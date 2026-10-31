"""The feedback of macos/verification/m1-external-library-member-feedback.md, end to end on a fresh test instance: an
external library a member (not an administrator) owns, deleted while the library queue is paused and then emptied, as
it happened on the test Mac; one deleted the old way, before its assets were hidden at once, as the test Mac's still
is; and an original whose folder is gone.

Usage (with the machine-learning venv's python, which has httpx):
  m1_external_library_delete.py --url http://127.0.0.1:2297 --home ~/Library/Application\\ Support/Immich-p13 --nas /tmp/p13/nas
"""

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[2]
ASSETS = REPO / "e2e/test-assets"
SAMPLES = [
    "albums/nature/prairie_falcon.jpg", "albums/nature/el_torcal_rocks.jpg", "albums/nature/tanners_ridge.jpg",
    "albums/nature/silver_fir.jpg", "albums/nature/wood_anemones.jpg", "albums/text/japanese-shop.jpg",
    "metadata/faces/portrait.jpg", "formats/heic/IMG_2682.heic", "formats/webp/denali.webp", "videos/train.mov",
]
ADMIN = ("admin@p13.local", "admin-password")
MEMBER = ("member@p13.local", "member-password")

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}")
    return ok


class Instance:
    def __init__(self, url: str, home: Path):
        self.url, self.home = url, home
        self.ctl = str(home / "bin/immichctl")

    def client(self, email: str, password: str) -> httpx.Client:
        client = httpx.Client(base_url=self.url, timeout=60)
        response = client.post("/api/auth/login", json={"email": email, "password": password})
        response.raise_for_status()
        client.headers["Authorization"] = f"Bearer {response.json()['accessToken']}"
        return client

    def sql(self, query: str) -> str:
        return subprocess.run([self.ctl, "psql", "-At", "-c", query], capture_output=True, text=True, check=True).stdout.strip()

    def wait(self, admin: httpx.Client, timeout: int = 300) -> None:
        # the queues may be empty a moment before what was just done queues its jobs
        time.sleep(2)
        deadline = time.time() + timeout
        quiet = 0
        while time.time() < deadline:
            try:
                queues = admin.get("/api/queues").json()
            except httpx.TransportError:
                # restarting: launchd brings it back
                time.sleep(2)
                continue
            busy = sum(q["statistics"]["active"] + q["statistics"]["waiting"] + q["statistics"]["delayed"]
                       for q in queues if not q["isPaused"])
            quiet = quiet + 1 if busy == 0 else 0
            if quiet >= 3:
                return
            time.sleep(1)
        sys.exit("queues did not drain in time")

    def restart_server(self) -> None:
        for attempt in range(2):
            done = subprocess.run([self.ctl, "restart", "server"], capture_output=True, text=True)
            if done.returncode == 0:
                break
            print(f"    immichctl restart server: exit {done.returncode}: {(done.stdout + done.stderr).strip()}")
        for _ in range(90):
            try:
                if httpx.get(f"{self.url}/api/server/ping", timeout=2).json().get("res") == "pong":
                    return
            except httpx.HTTPError:
                pass
            time.sleep(1)
        sys.exit("the server did not come back")


def seen_by(client: httpx.Client) -> int:
    """What the user sees: the timeline's count, and search agrees"""
    buckets = client.get("/api/timeline/buckets", params={"visibility": "timeline"}).json()
    timeline = sum(bucket["count"] for bucket in buckets)
    search = client.post("/api/search/metadata", json={"size": 1000}).json()["assets"]["total"]
    return timeline if timeline == search else -abs(timeline - search) - 1000


def in_album(client: httpx.Client, album_id: str) -> int:
    buckets = client.get("/api/timeline/buckets", params={"albumId": album_id}).json()
    return sum(bucket["count"] for bucket in buckets)


def in_trash(client: httpx.Client) -> int:
    buckets = client.get("/api/timeline/buckets", params={"isTrashed": "true"}).json()
    return sum(bucket["count"] for bucket in buckets)


def make_library(immich: Instance, admin: httpx.Client, owner_id: str, folder: Path, name: str) -> tuple[str, list[str]]:
    folder.mkdir(parents=True, exist_ok=True)
    for sample in SAMPLES:
        shutil.copy(ASSETS / sample, folder / f"{name}-{Path(sample).name}")
    library = admin.post("/api/libraries", json={"ownerId": owner_id, "name": name, "importPaths": [str(folder)]}).json()
    admin.post(f"/api/libraries/{library['id']}/scan").raise_for_status()
    immich.wait(admin)
    ids = immich.sql(f"select id from asset where \"libraryId\" = '{library['id']}'").split()
    return library["id"], ids


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2297")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--nas", type=Path, required=True)
    args = parser.parse_args()
    immich = Instance(args.url, args.home)
    # a server that has just been installed restarts once more as its settings are applied
    for _ in range(3):
        immich.restart_server()
        time.sleep(5)
        if httpx.get(f"{args.url}/api/server/ping", timeout=5).status_code == 200:
            break
    shutil.rmtree(args.nas, ignore_errors=True)

    print("== setup: an administrator, a member, the member's external library")
    httpx.post(f"{args.url}/api/auth/admin-sign-up", json={"email": ADMIN[0], "name": "Admin", "password": ADMIN[1]})
    admin = immich.client(*ADMIN)
    member_id = admin.post("/api/admin/users", json={"email": MEMBER[0], "name": "Member", "password": MEMBER[1],
                                                       "shouldChangePassword": False}).json()["id"]
    member = immich.client(*MEMBER)

    library_id, ids = make_library(immich, admin, member_id, args.nas / "member" / "Photos", "family")
    check("the member sees their library", seen_by(member) == len(SAMPLES), f"{seen_by(member)} of {len(SAMPLES)}")
    check("the administrator does not", seen_by(admin) == 0)
    album = member.post("/api/albums", json={"albumName": "Shared", "assetIds": ids[:3],
                                             "albumUsers": [{"userId": admin.get("/api/users/me").json()["id"],
                                                             "role": "viewer"}]}).json()
    check("an album shares 3 of them with the administrator",
          in_album(admin, album["id"]) == 3)

    print("== deleted while the library queue is paused, then the queue emptied (the test Mac's case)")
    admin.put("/api/queues/library", json={"isPaused": True}).raise_for_status()
    admin.delete(f"/api/libraries/{library_id}").raise_for_status()
    check("at once, the member sees none of it", seen_by(member) == 0, f"{seen_by(member)} seen")
    check("nor in their trash", in_trash(member) == 0, f"{in_trash(member)} in the trash")
    check("nor in the album shared with the administrator",
          in_album(admin, album["id"]) == 0)
    statuses = [member.get(f"/api/assets/{ids[0]}").status_code,
                member.get(f"/api/assets/{ids[0]}/thumbnail").status_code,
                member.get(f"/api/assets/{ids[-1]}/video/playback").status_code,
                member.get(f"/api/assets/{ids[0]}/original").status_code]
    check("nor by its id: the asset, thumbnail, video, original", all(s in (400, 403, 404) for s in statuses), str(statuses))
    # what the web UI's Clear button sends
    admin.request("DELETE", "/api/queues/library/jobs", json={"failed": False}).raise_for_status()
    waiting = admin.get("/api/queues/library").json()["statistics"]
    admin.put("/api/queues/library", json={"isPaused": False}).raise_for_status()
    check("emptying the queue queues the deletion check again", waiting["waiting"] + waiting["paused"] >= 1, str(waiting))
    immich.wait(admin)
    left = immich.sql(f"select count(*) from asset where \"libraryId\" = '{library_id}'")
    check("and its assets are removed", left == "0", f"{left} left")
    check("their files on the NAS untouched", len(list((args.nas / "member" / "Photos").iterdir())) == len(SAMPLES))
    immich.restart_server()
    immich.wait(admin)
    check("the library itself is gone after the next check (at startup)",
          immich.sql(f"select count(*) from library where id = '{library_id}'") == "0")

    print("== deleted before this fix, its assets still visible (as the test Mac's library is now)")
    old_id, old_ids = make_library(immich, admin, member_id, args.nas / "member" / "Old", "old")
    check("the member sees it", seen_by(member) == len(SAMPLES))
    immich.sql(f"update library set \"deletedAt\" = now() where id = '{old_id}'")
    check("soft-deleted the old way: still seen", seen_by(member) == len(SAMPLES))
    immich.restart_server()
    immich.wait(admin)
    check("after a restart, gone", seen_by(member) == 0, f"{seen_by(member)} seen")
    check("its assets removed", immich.sql(f"select count(*) from asset where \"libraryId\" = '{old_id}'") == "0")

    print("== an original whose folder is gone (a share that is not mounted)")
    gone_id, gone_ids = make_library(immich, admin, member_id, args.nas / "member" / "Gone", "gone")
    (args.nas / "member" / "Gone").rename(args.nas / "member" / "Gone.away")
    log = Path.home() / "Library/Logs/Immich" if args.home.name == "Immich" else args.home / "logs"
    before = (log / "server.log").read_text(errors="replace").count("Unknown error")
    response = member.get(f"/api/assets/{gone_ids[0]}/original")
    video = member.get(f"/api/assets/{gone_ids[-1]}/original")
    check("downloading it: 404, saying why", response.status_code == 404 and "mounted" in response.text,
          f"{response.status_code} {response.json().get('message', '')}")
    check("a video's too", video.status_code == 404, str(video.status_code))
    time.sleep(1)
    text = (log / "server.log").read_text(errors="replace")
    check("logged as a missing file, not an unknown error",
          text.count("Unknown error") == before and "File not found" in text)
    check("its thumbnail still shows", member.get(f"/api/assets/{gone_ids[0]}/thumbnail").status_code == 200)
    (args.nas / "member" / "Gone.away").rename(args.nas / "member" / "Gone")

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
