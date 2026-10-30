"""Whether deleting photos and videos removes their files: originals, thumbnails, previews, transcoded videos, sidecars,
live photo videos and face thumbnails, in every way a user deletes them.

On a fresh test instance: uploads real iPhone live photos and HDR videos and photos with faces, waits for thumbnails,
transcodes and faces, notes every file each asset has on disk, then deletes them, and checks which files are left:

  trash, then empty the trash          what the web UI and the app do by default
  trash, then the trash expires        the nightly job, after the configured days (set to 0 and run now)
  delete permanently                   force, with the trash skipped
  a file removed from the external library, then a scan, then the trash emptied
  the external library's share unmounted, then the trash emptied, and expired: nothing may be deleted
  an external library's file deleted in Immich, then the trash emptied
  the people of the deleted faces      the person cleanup job

Usage (with the machine-learning venv's python, which has httpx):
  m1_delete_cleanup.py --url http://127.0.0.1:2287 --home ~/Library/Application\\ Support/Immich-p2 --nas /tmp/immich-p2/nas
"""

import argparse
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

EMAIL, PASSWORD = "p2@immich.local", "p2-password"
REPO = Path(__file__).resolve().parents[2]
E2E = REPO / "e2e/test-assets"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}")
    return ok


class Instance:
    def __init__(self, url: str, home: Path) -> None:
        self.client = httpx.Client(base_url=url, timeout=60)
        self.ctl = home / "bin/immichctl"

    def sql(self, query: str) -> list[list[str]]:
        out = subprocess.run([str(self.ctl), "psql", "-At", "-F", "\t", "-c", query], capture_output=True, text=True, check=True)
        return [line.split("\t") for line in out.stdout.splitlines() if line]

    def login(self) -> str:
        c = self.client
        if not c.get("/api/server/config").json().get("isInitialized"):
            c.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "P2", "password": PASSWORD}).raise_for_status()
        body = c.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()
        c.headers["Authorization"] = f"Bearer {body['accessToken']}"
        return str(body["userId"])

    def configure(self, **changes: Any) -> None:
        config = self.client.get("/api/system-config").json()
        for path, value in changes.items():
            node = config
            *parents, key = path.split("__")
            for parent in parents:
                node = node[parent]
            node[key] = value
        self.client.put("/api/system-config", json=config).raise_for_status()

    def wait(self, timeout: int = 900) -> None:
        deadline, quiet = time.time() + timeout, 0
        while time.time() < deadline:
            queues = {q["name"]: q["statistics"] for q in self.client.get("/api/queues").json()}
            busy = any(s["active"] or s["waiting"] or s["delayed"] for s in queues.values())
            quiet = 0 if busy else quiet + 1
            if quiet >= 3:
                return
            time.sleep(1)
        sys.exit("queues did not drain in time")

    def upload(self, path: Path, **fields: str) -> str:
        now = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
        with path.open("rb") as handle:
            response = self.client.post(
                "/api/assets",
                data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": path.name, **fields},
                files={"assetData": (path.name, handle, "application/octet-stream")},
                timeout=300,
            )
        response.raise_for_status()
        return str(response.json()["id"])

    def upload_live(self, still: Path, video: Path) -> tuple[str, str]:
        """As the app does: the video hidden first, then the still linked to it"""
        video_id = self.upload(video, visibility="hidden")
        return self.upload(still, livePhotoVideoId=video_id), video_id

    def files(self, asset_ids: list[str]) -> dict[str, list[str]]:
        """Every file of these assets, and of their live photo videos, by kind"""
        ids = ",".join(f"'{i}'" for i in asset_ids)
        rows = self.sql(f"""
            with a as (select id, "originalPath", "livePhotoVideoId" from asset where id in ({ids})
                       union select v.id, v."originalPath", null from asset s join asset v on v.id = s."livePhotoVideoId"
                       where s.id in ({ids}))
            select 'original', "originalPath" from a
            union all select f.type, f.path from asset_file f join a on a.id = f."assetId"
        """)
        found: dict[str, list[str]] = {}
        for kind, path in rows:
            found.setdefault(kind, []).append(path)
        return found

    def library_assets(self, library_id: str) -> list[str]:
        return [r[0] for r in self.sql(f"select id from asset where \"libraryId\" = '{library_id}'")]


def photos(names: list[str]) -> dict[str, Path]:
    """Real iPhone files, from the main install's library (its storage template renames them, and live photo videos
    stay in the upload folder)"""
    quoted = ",".join(f"'{n}'" for n in names)
    out = subprocess.run(["immichctl", "psql", "-At", "-F", "\t", "-c",
                          f'select "originalFileName", "originalPath" from asset where "originalFileName" in ({quoted})'],
                         capture_output=True, text=True, check=True).stdout
    found = {name: Path(path) for name, path in (line.split("\t") for line in out.splitlines() if line)}
    missing = set(names) - set(found)
    if missing:
        sys.exit(f"not in the main library: {sorted(missing)}")
    return found


def summary(files: dict[str, list[str]]) -> str:
    return ", ".join(f"{len(paths)} {kind}" for kind, paths in sorted(files.items()))


def left_over(files: dict[str, list[str]], keep: set[str] = frozenset()) -> list[str]:
    return sorted(f"{kind}: {Path(p).name}" for kind, paths in files.items() for p in paths
                  if kind not in keep and Path(p).exists())


def scenario(immich: Instance, name: str, ids: list[str], delete: Any, keep: set[str] = frozenset()) -> None:
    print(f"== {name}")
    files = immich.files(ids)
    missing = [p for paths in files.values() for p in paths if not Path(p).exists()]
    check("files there before", not missing and "encoded_video" in files and "thumbnail" in files,
          summary(files) + (f"; missing: {missing}" if missing else ""))
    delete()
    time.sleep(2)
    immich.wait()
    gone = not immich.sql(f"select id from asset where id in ({','.join(repr(i) for i in ids)})")
    left = left_over(files, keep)
    check("assets deleted from the database", gone)
    kept = [f"{kind}: {Path(p).name}" for kind, paths in files.items() for p in paths if kind in keep and Path(p).exists()]
    check("no files left" + (f" but the {', '.join(sorted(keep))}" if keep else ""), not left,
          f"left: {left}" if left else (f"kept: {kept}" if kept else ""))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2287")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--nas", type=Path, required=True)
    parser.add_argument("--ml-url", default="http://127.0.0.1:3003")
    args = parser.parse_args()
    immich = Instance(args.url, args.home)
    c = immich.client
    user_id = immich.login()
    # faces from the machine learning service of the main install, which has the models loaded
    immich.configure(machineLearning__urls=[args.ml_url], machineLearning__clip__enabled=False,
                     machineLearning__ocr__enabled=False, machineLearning__duplicateDetection__enabled=False)

    print("== upload")
    PHOTOS = photos(  # noqa: N806
        [f"IMG_{n}.{e}" for n in (5561, 5562, 5563, 5564, 5565) for e in ("HEIC", "MOV")]
                    + ["IMG_5585.MOV", "IMG_5576.MOV", "IMG_5581.MOV"])
    live_a = immich.upload_live(PHOTOS["IMG_5561.HEIC"], PHOTOS["IMG_5561.MOV"])
    live_b = immich.upload_live(PHOTOS["IMG_5562.HEIC"], PHOTOS["IMG_5562.MOV"])
    live_c = immich.upload_live(PHOTOS["IMG_5563.HEIC"], PHOTOS["IMG_5563.MOV"])
    video_a, video_b = immich.upload(PHOTOS["IMG_5585.MOV"]), immich.upload(PHOTOS["IMG_5576.MOV"])
    face = immich.upload(E2E / "metadata/faces/portrait.jpg")
    photo_b, photo_c = immich.upload(E2E / "albums/nature/el_torcal_rocks.jpg"), immich.upload(E2E / "albums/nature/tanners_ridge.jpg")
    nas = args.nas.resolve()
    shutil.rmtree(nas, ignore_errors=True)
    nas.mkdir(parents=True)
    for name in ["IMG_5564.HEIC", "IMG_5564.MOV", "IMG_5565.HEIC", "IMG_5565.MOV", "IMG_5581.MOV"]:
        shutil.copy2(PHOTOS[name], nas / name)
    library = c.post("/api/libraries", json={"ownerId": user_id, "importPaths": [str(nas)], "name": "NAS"}).json()
    c.post(f"/api/libraries/{library['id']}/scan").raise_for_status()
    time.sleep(3)
    immich.wait()
    people = immich.sql("select \"personGroupId\", \"thumbnailPath\" from person")
    check("uploaded and processed", len(people) >= 1 and len(immich.library_assets(library["id"])) == 5,
          f"{len(people)} person(s), {len(immich.library_assets(library['id']))} library assets")

    scenario(immich, "trash, then empty the trash", [live_a[0], video_a, face], lambda: (
        c.request("DELETE", "/api/assets", json={"ids": [live_a[0], video_a, face]}).raise_for_status(),
        immich.wait(), c.post("/api/trash/empty").raise_for_status()))

    scenario(immich, "delete permanently", [live_b[0], video_b, photo_b], lambda: c.request(
        "DELETE", "/api/assets", json={"ids": [live_b[0], video_b, photo_b], "force": True}).raise_for_status())

    def expire() -> None:
        c.request("DELETE", "/api/assets", json={"ids": [live_c[0], photo_c]}).raise_for_status()
        immich.wait()
        # the nightly tasks start at the next whole minute, with the trash kept for 0 days
        start = (datetime.now() + timedelta(minutes=1)).strftime("%H:%M")
        immich.configure(trash__days=0, nightlyTasks__startTime=start)
        deadline = time.time() + 150
        while immich.sql(f"select id from asset where id = '{photo_c}'") and time.time() < deadline:
            time.sleep(5)
        immich.configure(trash__days=30, nightlyTasks__startTime="00:00")

    scenario(immich, "trash, then the trash expires (nightly job)", [live_c[0], photo_c], expire)

    def by_name(*names: str) -> list[str]:
        quoted = ",".join(f"'{n}'" for n in names)
        return [r[0] for r in immich.sql(
            f"select id from asset where \"libraryId\" = '{library['id']}' and \"originalFileName\" in ({quoted})")]

    def scan() -> None:
        c.post(f"/api/libraries/{library['id']}/scan").raise_for_status()
        time.sleep(3)
        immich.wait()

    removed = by_name("IMG_5564.HEIC", "IMG_5581.MOV")

    def remove_on_nas() -> None:
        for name in ("IMG_5564.HEIC", "IMG_5564.MOV", "IMG_5581.MOV"):
            (nas / name).unlink()
        scan()
        state = immich.sql(f"select \"isOffline\", \"deletedAt\" is not null from asset where id in ({','.join(repr(i) for i in removed)})")
        check("removed files go offline, into the trash", all(r == ["t", "t"] for r in state), str(state))
        c.post("/api/trash/empty").raise_for_status()

    scenario(immich, "a file removed from the external library, then a scan, then the trash emptied", removed, remove_on_nas)

    print("== the share unmounted: nothing may be deleted")
    kept = by_name("IMG_5565.HEIC")
    kept_files = immich.files(kept)
    away = nas.with_name(nas.name + "-away")
    nas.rename(away)
    nas.mkdir()  # what an NFS mount point is with nothing mounted on it
    try:
        scan()
        state = immich.sql(f"select \"isOffline\", \"deletedAt\" is not null from asset where id = '{kept[0]}'")
        check("its files go offline, into the trash", state == [["t", "t"]], str(state))
        c.post("/api/trash/empty").raise_for_status()
        time.sleep(2)
        immich.wait()
        check("emptying the trash keeps them, and their thumbnails and videos", bool(by_name("IMG_5565.HEIC"))
              and all(Path(p).exists() for k, ps in kept_files.items() if k != "original" for p in ps), summary(kept_files))
        start = (datetime.now() + timedelta(minutes=1)).strftime("%H:%M")
        immich.configure(trash__days=0, nightlyTasks__startTime=start)
        time.sleep(75)
        immich.wait()
        immich.configure(trash__days=30, nightlyTasks__startTime="00:00")
        check("the expired trash keeps them too", bool(by_name("IMG_5565.HEIC"))
              and all(Path(p).exists() for k, ps in kept_files.items() if k != "original" for p in ps))
    finally:
        nas.rmdir()
        away.rename(nas)
    scan()
    state = immich.sql(f"select \"isOffline\", \"deletedAt\" is not null from asset where id = '{kept[0]}'")
    check("back online, out of the trash, after the next scan", state == [["f", "f"]], str(state))

    nas_files = sorted(p.name for p in nas.iterdir() if p.suffix.lower() != ".xmp")

    def delete_in_immich() -> None:
        c.request("DELETE", "/api/assets", json={"ids": kept}).raise_for_status()
        immich.wait()
        c.post("/api/trash/empty").raise_for_status()

    scenario(immich, "an external library's file deleted in Immich, then the trash emptied", kept, delete_in_immich,
             keep={"original"})
    now_on_nas = sorted(p.name for p in nas.iterdir() if p.suffix.lower() != ".xmp")
    print(f"  note: on the NAS before: {nas_files}, after: {now_on_nas}")

    print("== the people of the deleted faces")
    person_files = [p for _, p in people if p]
    c.post("/api/jobs", json={"name": "person-cleanup"}).raise_for_status()
    time.sleep(2)
    immich.wait()
    remaining = immich.sql("select count(*) from asset_face")[0][0]
    check("people and their thumbnails removed by the person cleanup",
          not immich.sql("select \"personGroupId\" from person") and not any(Path(p).exists() for p in person_files),
          f"{len(person_files)} people before, {remaining} faces left")

    print("== what is left")
    data = Path(immich.sql("select value->>'location' from system_metadata where key = 'MediaLocation'")[0][0] or "")
    left = immich.sql("select count(*) from asset")[0][0]
    files = [p for d in ("thumbs", "encoded-video", "upload") for p in (data / d).rglob("*") if p.is_file() and p.name != ".immich"]
    dirs = [p for d in ("thumbs", "encoded-video", "upload") for p in (data / d).rglob("*") if p.is_dir() and not any(p.iterdir())]
    check("no asset and no file left in the library folders", left == "0" and not files,
          f"{left} assets; files: {[str(p.relative_to(data)) for p in files]}")
    print(f"  note: {len(dirs)} empty folder(s) left: {sorted(str(p.relative_to(data)) for p in dirs)[:8]}")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
