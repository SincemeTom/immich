"""M0: end-to-end check of a native deployment through the public API, the way a user exercises it.

Signs up an admin on a fresh instance, points machine learning at the native service, uploads every image in
e2e/test-assets/formats plus the synthetic clips from m0-ffmpeg-bench.sh, waits for the queues to drain, then checks
thumbnails, metadata, faces, OCR, smart search, video transcoding and a database backup.

Usage (with the machine-learning venv's python, which has httpx):
  m0_e2e.py --url http://127.0.0.1:2283 --ml-url http://127.0.0.1:3003
"""

import argparse
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

REPO = Path(__file__).resolve().parents[2]
FFPROBE = str(Path.home() / "Library/Caches/immich-m0/ffmpeg/ffprobe")
FORMATS = REPO / "e2e/test-assets/formats"
EXTRA = [
    REPO / "e2e/test-assets/metadata/faces/portrait.jpg",
    REPO / "e2e/test-assets/albums/text/japanese-shop.jpg",
    REPO / "e2e/test-assets/albums/nature/prairie_falcon.jpg",
]
VIDEOS = Path("/tmp/immich-m0/ffmpeg/samples")
SKIP = {".xmp", ".md"}
EMAIL, PASSWORD = "m0@immich.local", "m0-password"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}")
    return ok


def login(client: httpx.Client) -> None:
    config = client.get("/api/server/config").json()
    if not config.get("isInitialized"):
        client.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "M0", "password": PASSWORD}).raise_for_status()
    response = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    response.raise_for_status()
    client.headers["Authorization"] = f"Bearer {response.json()['accessToken']}"


def configure(client: httpx.Client, ml_url: str) -> None:
    config = client.get("/api/system-config").json()
    config["machineLearning"]["urls"] = [ml_url]
    client.put("/api/system-config", json=config).raise_for_status()


def upload(client: httpx.Client, path: Path) -> dict[str, Any]:
    now = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    with path.open("rb") as handle:
        response = client.post(
            "/api/assets",
            data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": path.name},
            files={"assetData": (path.name, handle, "application/octet-stream")},
            timeout=300,
        )
    response.raise_for_status()
    body: dict[str, Any] = response.json()
    return body


def wait_for_queues(client: httpx.Client, timeout: int) -> dict[str, dict[str, int]]:
    """Waits until no queue has work, which must hold for a few polls since one job enqueues the next."""
    deadline, quiet = time.time() + timeout, 0
    while time.time() < deadline:
        queues = {queue["name"]: queue["statistics"] for queue in client.get("/api/queues").json()}
        busy = {name: s for name, s in queues.items() if s["active"] or s["waiting"] or s["delayed"]}
        quiet = 0 if busy else quiet + 1
        if quiet >= 3:
            return queues
        summary = ", ".join(f"{n} {s['active']}+{s['waiting']}" for n, s in busy.items())
        print(f"    waiting: {summary}" if summary else "    settling")
        time.sleep(3)
    sys.exit("queues did not drain in time")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2283")
    parser.add_argument("--ml-url", default="http://127.0.0.1:3003")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()

    client = httpx.Client(base_url=args.url, timeout=60)
    print("== setup")
    login(client)
    configure(client, args.ml_url)
    check("machine learning reachable from the server", client.get(f"{args.ml_url}/ping").text == "pong")

    print("== upload")
    images = sorted(p for p in FORMATS.rglob("*") if p.is_file() and p.suffix.lower() not in SKIP) + EXTRA
    videos = sorted(VIDEOS.glob("*")) if VIDEOS.exists() else []
    uploaded: dict[str, str] = {}
    for path in images + videos:
        body = upload(client, path)
        uploaded[str(path.relative_to(REPO) if path.is_relative_to(REPO) else path.name)] = body["id"]
    check("uploads accepted", len(uploaded) == len(images) + len(videos), f"{len(uploaded)} files")
    started = time.time()
    queues = wait_for_queues(client, args.timeout)
    print(f"    queues drained in {time.time() - started:.0f}s")
    failed = {name: s["failed"] for name, s in queues.items() if s["failed"]}
    # counters are pruned, so this misses failures that have aged out; the per-feature checks below are the real test
    check("no failed jobs in the queue counters", not failed, str(failed) if failed else "")

    print("== per asset")
    for name, asset_id in uploaded.items():
        asset = client.get(f"/api/assets/{asset_id}").json()
        thumb = client.get(f"/api/assets/{asset_id}/thumbnail", params={"size": "preview"})
        exif = asset.get("exifInfo") or {}
        problems = []
        if thumb.status_code != 200 or not thumb.content:
            problems.append(f"preview HTTP {thumb.status_code}")
        if not asset.get("thumbhash"):
            problems.append("no thumbhash")
        if not exif.get("exifImageWidth") and asset["type"] == "IMAGE":
            problems.append("no EXIF dimensions")
        if asset["type"] == "VIDEO":
            playback = client.get(f"/api/assets/{asset_id}/video/playback", headers={"Range": "bytes=0-1023"})
            if playback.status_code not in (200, 206):
                problems.append(f"playback HTTP {playback.status_code}")
        detail = f"{asset['type'].lower()} {exif.get('exifImageWidth')}x{exif.get('exifImageHeight')}"
        if exif.get("make"):
            detail += f", {exif['make']} {exif.get('model') or ''}".rstrip()
        check(name, not problems, "; ".join(problems) or detail)

    print("== features")
    portrait = uploaded["e2e/test-assets/metadata/faces/portrait.jpg"]
    faces = client.get("/api/faces", params={"id": portrait}).json()
    check("face detected in portrait.jpg", len(faces) >= 1, f"{len(faces)} face(s)")

    shop = uploaded["e2e/test-assets/albums/text/japanese-shop.jpg"]
    ocr = client.get(f"/api/assets/{shop}/ocr").json()
    texts = [line.get("text") for line in ocr] if isinstance(ocr, list) else []
    check("OCR text in japanese-shop.jpg", any(texts), ", ".join(t for t in texts if t)[:80])

    falcon = uploaded["e2e/test-assets/albums/nature/prairie_falcon.jpg"]
    hits = client.post("/api/search/smart", json={"query": "a bird of prey", "size": 5}).json()["assets"]["items"]
    top = [hit["originalFileName"] for hit in hits]
    check("smart search 'a bird of prey' ranks the falcon first", bool(hits) and hits[0]["id"] == falcon, ", ".join(top[:3]))

    for video in videos:
        asset_id = uploaded[video.name]
        playback = client.get(f"/api/assets/{asset_id}/video/playback")
        out = Path(f"/tmp/immich-m0/e2e-{video.stem}.mp4")
        out.write_bytes(playback.content)
        probe = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=codec_name,height,color_transfer", "-of", "csv=p=0", str(out)],
            capture_output=True, text=True,
        ).stdout.strip()
        # Immich's defaults: H.264 at 720p, HDR tone-mapped to SDR (bt709). With the default policy ("required") a
        # clip already in an accepted codec and container is played as uploaded, so the 1080p H.264 one stays as it is
        expected = "h264,1080" if video.name.startswith("sdr_") else "h264,720,bt709"
        check(f"playback of {video.name}", probe.startswith(expected), f"{probe} (expected {expected})")

    print("== database backup (pg_dump)")
    before = {b["filename"] for b in client.get("/api/admin/database-backups").json()["backups"]}
    client.post("/api/jobs", json={"name": "backup-database"}).raise_for_status()
    wait_for_queues(client, 300)
    # queue counters are pruned, so the backup is judged by the file it should have written
    after = client.get("/api/admin/database-backups").json()["backups"]
    created = [b for b in after if b["filename"] not in before]
    detail = f"{created[0]['filename']} ({created[0]['filesize']} bytes)" if created else "no new backup file"
    check("backup written", bool(created), detail)

    passed = sum(ok for _, ok, _ in results)
    print(f"\nResult: {passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
