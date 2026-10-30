"""Storage locations, end to end: thumbnails, database backups and a user's originals moved to a network share and
back, an external library on the folder that holds the originals, and the NAS going away and coming back, with the
server restarting meanwhile, on a fresh test instance.

The NAS is an NFS server rclone runs on 127.0.0.1 (the instance's server.env sets IMMICH_NETWORK_SHARES_NFS_PORT to its
port), serving a local folder with a write cache, so that Immich can write to it, and the script can stop and start it.

Usage (with the machine-learning venv's python, which has httpx):
  m1_storage_locations.py --url http://127.0.0.1:2289 --home ~/Library/Application\\ Support/Immich-p6 \\
      --library /tmp/immich-p6/library --nas /tmp/immich-p6/nas --port 12052
"""

import argparse
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).parent))
import m1_network_shares as shares_e2e  # noqa: E402
from m1_external_dedupe import upload  # noqa: E402
from m1_network_shares import Instance, check, nfs_mounts, poll, results  # noqa: E402

shares_e2e.EMAIL, shares_e2e.PASSWORD = "p6@immich.local", "p6-password"
E2E = Path(__file__).resolve().parents[2] / "e2e/test-assets"
FIRST = ["albums/nature/el_torcal_rocks.jpg", "formats/heic/IMG_2682.heic", "albums/nature/prairie_falcon.jpg",
         "albums/nature/tanners_ridge.jpg"]
LATER = "albums/nature/cyclamen_persicum.jpg"
WHILE_AWAY = "albums/nature/silver_fir.jpg"
OLD = ["albums/nature/wood_anemones.jpg", "albums/nature/polemonium_reptans.jpg"]


def sha1(path: Path | str) -> str:
    return hashlib.sha1(Path(path).read_bytes()).hexdigest()


class Nas:
    """rclone serving a folder over NFS with a write cache, so that it can be written to"""

    def __init__(self, folder: Path, port: int) -> None:
        self.folder, self.port = folder, port
        self.cache = folder.parent / "rclone-cache"
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        self.process = subprocess.Popen(
            ["rclone", "serve", "nfs", str(self.folder), "--addr", f"127.0.0.1:{self.port}", "--vfs-cache-mode",
             "writes", "--cache-dir", str(self.cache), "--vfs-write-back", "1s"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)

    def stop(self) -> None:
        if self.process:
            self.process.kill()
            self.process.wait()
            self.process = None


class Locations:
    def __init__(self, immich: Instance) -> None:
        self.c = immich.client

    def get(self) -> dict[str, Any]:
        response = self.c.get("/api/admin/storage-locations")
        response.raise_for_status()
        return response.json()

    def folder(self, name: str) -> dict[str, Any]:
        return next(f for f in self.get()["folders"] if f["folder"] == name)

    def set_folder(self, name: str, share_id: str | None, path: str | None = None) -> httpx.Response:
        body: dict[str, Any] = {"shareId": share_id} | ({"path": path} if path else {})
        return self.c.put(f"/api/admin/storage-locations/folders/{name}", json=body)

    def set_user(self, user_id: str, share_id: str | None, path: str | None = None) -> httpx.Response:
        body: dict[str, Any] = {"shareId": share_id} | ({"path": path} if path else {})
        return self.c.put(f"/api/admin/storage-locations/users/{user_id}", json=body)

    def settled(self) -> bool:
        """No move left: nothing pending, nothing moving"""
        value = self.get()
        return all(not f["pendingFrom"] and not f.get("migration") for f in value["folders"])


def files_of(immich: Instance) -> list[tuple[str, str, str]]:
    return [tuple(row) for row in immich.sql(  # type: ignore[misc]
        'select a."originalFileName", f.type, f.path from asset_file f join asset a on a.id = f."assetId" '
        "where a.\"deletedAt\" is null and f.type in ('thumbnail', 'preview', 'fullsize') order by 1, 2")]


def originals_of(immich: Instance) -> dict[str, str]:
    return dict(immich.sql('select "originalFileName", "originalPath" from asset where "libraryId" is null '
                           'and "deletedAt" is null'))


def regular_files(folder: Path) -> list[Path]:
    return [p for p in folder.rglob("*") if p.is_file() and p.name != ".immich"] if folder.exists() else []


def queues(immich: Instance) -> dict[str, dict[str, Any]]:
    return {q["name"]: q for q in immich.client.get("/api/queues").json()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2289")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--nas", type=Path, required=True)
    parser.add_argument("--port", type=int, default=12052)
    args = parser.parse_args()

    immich = Instance(args.url, args.home)
    locations = Locations(immich)
    c = immich.client

    print("== set up: a NAS with old photos, and photos backed up to the Mac")
    if args.nas.exists():
        shutil.rmtree(args.nas)
    old_folder = args.nas / "homes/p6/Photos/2024"
    old_folder.mkdir(parents=True)
    (args.nas / "immich").mkdir()
    for sample in OLD:
        shutil.copy2(E2E / sample, old_folder)
    old_sums = {p.name: sha1(p) for p in old_folder.iterdir()}
    nas = Nas(args.nas, args.port)
    nas.start()

    user_id = immich.login()
    sources = {Path(s).name: E2E / s for s in [*FIRST, LATER, WHILE_AWAY]}
    for sample in FIRST:
        upload(c, E2E / sample)
    immich.wait()
    local_thumbs = args.library / "thumbs"
    check("thumbnails made on the Mac", len(files_of(immich)) >= 2 * len(FIRST)
          and all(path.startswith(str(local_thumbs)) for _, _, path in files_of(immich)))

    share = c.post("/api/admin/network-shares", json={"name": "群晖", "host": "127.0.0.1", "exportPath": "/"})
    share.raise_for_status()
    share_id, mount_path = share.json()["id"], Path(share.json()["mountPath"])
    check("share added and mounted", str(mount_path) in nfs_mounts(), str(mount_path))

    print("== thumbnails to the NAS")
    response = locations.set_folder("thumbs", share_id, "immich/thumbs")
    check("thumbnails set to the share", response.status_code == 200, response.text[:200])
    nas_thumbs = mount_path / "immich/thumbs"
    _, took = poll(locations.settled, 180)
    rows = files_of(immich)
    check("every thumbnail moved", all(path.startswith(str(nas_thumbs)) for _, _, path in rows),
          f"{len(rows)} files in {took:.0f} s")
    check("each is on the NAS", all(os.path.exists(path) for _, _, path in rows))
    check("none left on the Mac", regular_files(local_thumbs) == [], str(regular_files(local_thumbs)[:3]))
    check("the marker is on the NAS", poll(lambda: (args.nas / "immich/thumbs/.immich").exists(), 30)[0])
    asset_id = immich.sql("select id from asset where \"libraryId\" is null limit 1")[0][0]
    thumb = c.get(f"/api/assets/{asset_id}/thumbnail", params={"size": "preview"})
    check("the web shows them", thumb.status_code == 200 and len(thumb.content) > 1000, str(thumb.status_code))

    print("== what is refused")
    check("the top of the share", locations.set_folder("encoded-video", share_id, "/").status_code == 400)
    response = locations.set_folder("encoded-video", share_id, "homes/p6/Photos")
    check("a folder with photos in it", response.status_code == 400 and "not empty" in response.text)
    response = locations.set_folder("encoded-video", share_id, "immich/thumbs/videos")
    check("a folder in another location", response.status_code == 400, response.json().get("message", ""))
    response = c.delete(f"/api/admin/network-shares/{share_id}")
    check("removing the share", response.status_code == 400, response.json().get("message", ""))
    response = c.put(f"/api/admin/network-shares/{share_id}", json={"readOnly": True})
    check("making the share read-only", response.status_code == 400)

    print("== database backups to the NAS")
    check("backups set to the share", locations.set_folder("backups", share_id, "immich/backups").status_code == 200)
    poll(locations.settled, 60)
    c.post("/api/jobs", json={"name": "backup-database"}).raise_for_status()
    backup, took = poll(lambda: list((mount_path / "immich/backups").glob("*.sql.gz")), 120)
    check("a backup is written to the NAS", bool(backup), f"{backup[0].name if backup else ''} in {took:.0f} s")

    print("== the user's originals to the NAS, beside the old photos")
    response = locations.set_user(user_id, share_id, "homes/p6/Photos/Immich")
    check("originals set to the share", response.status_code == 200, response.text[:200])
    time.sleep(2)
    immich.wait()
    nas_originals = mount_path / "homes/p6/Photos/Immich"
    originals = originals_of(immich)
    check("every original moved", all(path.startswith(str(nas_originals)) for path in originals.values()),
          str(list(originals.values())[:2]))
    check("each is whole on the NAS", all(sha1(path) == sha1(sources[name]) for name, path in originals.items()))
    check("none left on the Mac", regular_files(args.library / "library") == [])

    library = c.post("/api/libraries", json={"ownerId": user_id, "name": "群晖照片",
                                             "importPaths": [str(mount_path / "homes/p6/Photos")]})
    library.raise_for_status()
    immich.scan(library.json()["id"])
    imported = sorted(immich.library_assets(library.json()["id"]))
    check("an external library on the folder holding them leaves them out", imported == sorted(old_sums), str(imported))

    upload(c, sources[Path(LATER).name])
    time.sleep(2)
    immich.wait()
    later = originals_of(immich)[Path(LATER).name]
    later_files = [path for name, _, path in files_of(immich) if name == Path(LATER).name]
    check("a new upload goes to the NAS", later.startswith(str(nas_originals)), later)
    check("and its thumbnails", len(later_files) >= 2 and all(p.startswith(str(nas_thumbs)) for p in later_files))

    print("== the NAS goes away")
    nas.stop()
    away, took = poll(lambda: not locations.folder("thumbs")["available"], 150, 5)
    check("the locations are unavailable", bool(away), f"after {took:.0f} s")
    value = locations.get()
    check("what uses them is paused", {"thumbnailGeneration", "storageTemplateMigration", "backupDatabase"}
          <= set(value["pausedQueues"]), ", ".join(value["pausedQueues"]))
    check("the queues say so", queues(immich)["thumbnailGeneration"].get("isPaused") is True)
    check("the user's originals too", value["users"][0]["available"] is False, value["users"][0].get("message", ""))
    upload(c, sources[Path(WHILE_AWAY).name])
    time.sleep(10)
    away_name = Path(WHILE_AWAY).name
    away_path = originals_of(immich)[away_name]
    check("an upload meanwhile is kept on the Mac", away_path.startswith(str(args.library / "upload")), away_path)
    check("and waits for its thumbnails", not [p for n, _, p in files_of(immich) if n == away_name])
    unmounted, took = poll(lambda: str(mount_path) not in nfs_mounts(), 200, 5)
    check("the share is unmounted", bool(unmounted), f"after {took:.0f} s")
    mode = stat.S_IMODE(os.stat(mount_path).st_mode)
    check("its mount point is read-only", mode == 0o555, oct(mode))
    check("nothing was written to the Mac in its place", os.listdir(mount_path) == [], str(os.listdir(mount_path)))
    check("the server answers", c.get("/api/server/ping").status_code == 200)
    immich.restart_server()
    check("the server starts while the NAS is away", c.get("/api/server/ping").status_code == 200)
    time.sleep(70)
    check("and keeps the jobs paused", queues(immich)["thumbnailGeneration"].get("isPaused") is True)

    print("== the NAS comes back")
    nas.start()
    back, took = poll(lambda: all(f["available"] for f in locations.get()["folders"]), 150, 5)
    check("the locations can be used again", bool(back), f"after {took:.0f} s")
    check("the jobs are resumed", locations.get()["pausedQueues"] == []
          and queues(immich)["thumbnailGeneration"].get("isPaused") is False)
    time.sleep(3)
    immich.wait()
    away_path = originals_of(immich)[away_name]
    away_files = [p for n, _, p in files_of(immich) if n == away_name]
    check("the upload made meanwhile goes to the NAS", away_path.startswith(str(nas_originals)), away_path)
    check("with its thumbnails", len(away_files) >= 2 and all(p.startswith(str(nas_thumbs)) for p in away_files))

    print("== thumbnails back to the Mac")
    check("thumbnails set to the Mac", locations.set_folder("thumbs", None).status_code == 200)
    _, took = poll(locations.settled, 180)
    rows = files_of(immich)
    check("every thumbnail moved back", all(path.startswith(str(local_thumbs)) and os.path.exists(path)
                                            for _, _, path in rows), f"{len(rows)} files in {took:.0f} s")
    check("none left on the NAS", regular_files(nas_thumbs) == [])

    check("the old photos on the NAS are untouched", {p.name: sha1(p) for p in old_folder.iterdir()} == old_sums)
    nas.stop()

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
