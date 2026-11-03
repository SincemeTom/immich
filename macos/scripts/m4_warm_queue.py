"""M4: what the server does while the models are prepared in the background (immichctl warm --background), as after a
.pkg install: it answers, and runs the jobs that need no model, so a photo uploaded meanwhile gets its thumbnail at once
(and a person's featured photo, set meanwhile, its new face: macos/verification/m4-person-cover-during-warmup.md); those
that call the machine learning service (smart search, faces, text) wait in the queue rather than fail, and run once the
models are ready, without the server restarting.

Usage (with the machine-learning venv's python, which has httpx and Pillow):
  m4_warm_queue.py upload URL      during the warm-up: signs up (as m0_e2e.py), uploads a photo, prints its id
  m4_warm_queue.py check URL ID    after it: the photo is found by smart search; then it is deleted
"""

import io
import sys
import time
from datetime import datetime, timezone

import httpx
from PIL import Image, ImageDraw

EMAIL, PASSWORD = "m0@immich.local", "m0-password"  # m0_e2e.py's, which runs on the same install after


def client_for(url: str) -> httpx.Client:
    client = httpx.Client(base_url=url, timeout=60)
    if not client.get("/api/server/config").json().get("isInitialized"):
        client.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "M0", "password": PASSWORD}).raise_for_status()
    token = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()["accessToken"]
    client.headers["Authorization"] = f"Bearer {token}"
    return client


def photo() -> bytes:
    """A photo none of m0_e2e.py's is (which would make its upload of it a duplicate): a red circle on a blue sky"""
    image = Image.new("RGB", (1600, 1200), (90, 150, 230))
    ImageDraw.Draw(image).ellipse((500, 300, 1100, 900), fill=(220, 30, 30))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=90)
    return buffer.getvalue()


def smart_search_waiting(client: httpx.Client) -> int:
    queues = {queue["name"]: queue["statistics"] for queue in client.get("/api/queues").json()}
    return queues["smartSearch"]["waiting"] + queues["smartSearch"]["active"]


def found(client: httpx.Client, asset: str) -> bool:
    response = client.post("/api/search/smart", json={"query": "a red circle", "size": 5})
    return response.status_code == 200 and asset in [a["id"] for a in response.json()["assets"]["items"]]


def upload(url: str) -> None:
    client = client_for(url)
    now = datetime.now(timezone.utc).isoformat()
    response = client.post(
        "/api/assets",
        data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": "m4-warm-queue.jpg"},
        files={"assetData": ("m4-warm-queue.jpg", photo(), "image/jpeg")},
    )
    response.raise_for_status()
    asset = response.json()["id"]
    deadline = time.time() + 60
    thumbnail = False
    while time.time() < deadline and not thumbnail:
        time.sleep(2)
        thumbnail = client.get(f"/api/assets/{asset}").json().get("thumbhash") is not None
    waiting = smart_search_waiting(client)
    ok = thumbnail and waiting > 0
    print(f"{'PASS' if ok else 'FAIL'} uploaded {asset}; its thumbnail made meanwhile: {thumbnail}, "
          f"smart search waiting: {waiting}")
    print(asset)
    sys.exit(0 if ok else 1)


def check(url: str, asset: str) -> None:
    client = client_for(url)
    deadline = time.time() + 300
    searchable = False
    while time.time() < deadline and not searchable:
        searchable = found(client, asset)
        time.sleep(3)
    print(f"{'PASS' if searchable else 'FAIL'} after the warm-up: found by smart search {searchable}")
    client.request("DELETE", "/api/assets", json={"ids": [asset], "force": True}).raise_for_status()
    sys.exit(0 if searchable else 1)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "upload":
        upload(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "check":
        check(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
