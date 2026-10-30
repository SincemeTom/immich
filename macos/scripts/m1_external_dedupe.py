"""External library and phone backup: the duplicates a backup made of photos an external library already holds.

Reproduces the problem on the code before the fix (phase "before"): an external library over a folder of real iPhone
photos (the NAS), then the same photos backed up the way the mobile app does it, live photos as a hidden video first and
the still linked to it. Then, after upgrading the instance (phase "after"), checks the fix: the library's files hashed by
their contents and synced so to the app, every upload grouped with its file in the duplicates utility with the file
suggested to keep, resolving them as "Deduplicate all" does, new backups recognised, and the edge cases of a library:
a new file, a changed file, two files with the same contents, the share unmounted.

Usage (with the machine-learning venv's python, which has httpx):
  m1_external_dedupe.py --url http://127.0.0.1:2286 --nas /tmp/immich-p1/nas before
  m1_external_dedupe.py --url http://127.0.0.1:2286 --nas /tmp/immich-p1/nas after
"""

import argparse
import base64
import hashlib
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

EMAIL, PASSWORD = "p1@immich.local", "p1-password"
REPO = Path(__file__).resolve().parents[2]
NEW_PHOTO = REPO / "e2e/test-assets/metadata/faces/portrait.jpg"
OTHER_PHOTO = REPO / "e2e/test-assets/albums/nature/el_torcal_rocks.jpg"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}")
    return ok


def media(folder: Path) -> list[Path]:
    """The photos and videos of a folder, without the XMP sidecars Immich writes next to them"""
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() != ".xmp")


def sha1(path: Path) -> str:
    return base64.b64encode(hashlib.sha1(path.read_bytes()).digest()).decode()


def login(client: httpx.Client) -> str:
    if not client.get("/api/server/config").json().get("isInitialized"):
        client.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "P1", "password": PASSWORD}).raise_for_status()
    response = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    response.raise_for_status()
    body = response.json()
    client.headers["Authorization"] = f"Bearer {body['accessToken']}"
    return str(body["userId"])


def wait_for_queues(client: httpx.Client, timeout: int = 600) -> None:
    deadline, quiet = time.time() + timeout, 0
    while time.time() < deadline:
        queues = {queue["name"]: queue["statistics"] for queue in client.get("/api/queues").json()}
        busy = any(s["active"] or s["waiting"] or s["delayed"] for s in queues.values())
        quiet = 0 if busy else quiet + 1
        if quiet >= 3:
            return
        time.sleep(1)
    sys.exit("queues did not drain in time")


def scan(client: httpx.Client, library_id: str) -> None:
    """Scans, then waits until the queues are idle and the library's count holds, as the crawl queues work late"""
    client.post(f"/api/libraries/{library_id}/scan").raise_for_status()
    last, steady = -1, 0
    while steady < 3:
        time.sleep(2)
        wait_for_queues(client)
        total = client.get(f"/api/libraries/{library_id}/statistics").json()["total"]
        steady = steady + 1 if total == last else 0
        last = total


def upload(client: httpx.Client, path: Path, header: bool = False, **fields: str) -> dict[str, Any]:
    """As the mobile app does: no checksum header, so the server only knows the file once it has it."""
    now = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    headers = {"x-immich-checksum": hashlib.sha1(path.read_bytes()).hexdigest()} if header else {}
    with path.open("rb") as handle:
        response = client.post(
            "/api/assets",
            data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": path.name, **fields},
            files={"assetData": (path.name, handle, "application/octet-stream")},
            headers=headers,
            timeout=300,
        )
    response.raise_for_status()
    return {"status_code": response.status_code, **response.json()}


def backup(client: httpx.Client, nas: Path, header: bool = False) -> dict[str, dict[str, Any]]:
    """Every photo of the folder, live photos as the app sends them: the video hidden, then the still linked to it."""
    responses: dict[str, dict[str, Any]] = {}
    files = media(nas)
    stills = {p.stem: p for p in files if p.suffix.lower() in {".heic", ".jpg"}}
    for path in files:
        if path.suffix.lower() == ".mov" and path.stem in stills:
            responses[path.name] = upload(client, path, header, visibility="hidden")
    for path in files:
        if path.name in responses:
            continue
        video = responses.get(f"{path.stem}.MOV")
        fields = {"livePhotoVideoId": video["id"]} if video and path.suffix.lower() == ".heic" else {}
        responses[path.name] = upload(client, path, header, **fields)
    return responses


def assets(client: httpx.Client, **filters: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    page: int | None = 1
    while page:
        body = client.post("/api/search/metadata", json={"page": page, "size": 1000, "withExif": True, **filters}).json()
        found += body["assets"]["items"]
        page = int(body["assets"]["nextPage"]) if body["assets"]["nextPage"] else None
    return found


def library_assets(client: httpx.Client, library_id: str) -> list[dict[str, Any]]:
    return [a for a in assets(client, withDeleted=True, visibility="timeline") + assets(client, visibility="hidden")
            if a.get("libraryId") == library_id]


def get_library(client: httpx.Client, user_id: str, nas: Path) -> str:
    for library in client.get("/api/libraries").json():
        if str(nas) in library["importPaths"]:
            return str(library["id"])
    body = client.post("/api/libraries", json={"ownerId": user_id, "importPaths": [str(nas)], "name": "NAS"}).json()
    return str(body["id"])


def before(client: httpx.Client, user_id: str, nas: Path) -> None:
    print("== the problem, on the code before the fix")
    config = client.get("/api/system-config").json()
    config["machineLearning"]["enabled"] = False
    client.put("/api/system-config", json=config).raise_for_status()
    library_id = get_library(client, user_id, nas)
    scan(client, library_id)
    external = library_assets(client, library_id)
    files = media(nas)
    check("library holds every file", len(external) == len(files), f"{len(external)} assets, {len(files)} files")
    check("library files are hashed by their paths",
          all(a["checksum"] != sha1(Path(a["originalPath"])) for a in external))

    responses = backup(client, nas)
    created = [r for r in responses.values() if r["status"] == "created"]
    check("the phone's backup uploads every file again", len(created) == len(files),
          f"{len(created)} of {len(files)} created")
    wait_for_queues(client)
    timeline = assets(client, visibility="timeline")
    names = [a["originalFileName"] for a in timeline]
    doubled = sorted({n for n in names if names.count(n) > 1})
    check("the timeline shows each photo twice", len(doubled) == len(timeline) // 2, f"{len(timeline)} on the timeline: {doubled}")

    # what the user did with the uploads meanwhile, which resolving the duplicates must keep
    uploads = {a["originalFileName"]: a for a in timeline if not a.get("libraryId")}
    album = client.post("/api/albums", json={"albumName": "Holiday", "assetIds": [uploads["IMG_5561.HEIC"]["id"],
                                                                              uploads["IMG_5562.HEIC"]["id"]]}).json()
    client.put("/api/assets", json={"ids": [uploads["IMG_5563.HEIC"]["id"]], "isFavorite": True}).raise_for_status()
    check("an album and a favorite on the uploads", album["assetCount"] == 2, f"album {album['albumName']}")


def after(client: httpx.Client, user_id: str, nas: Path) -> None:
    library_id = get_library(client, user_id, nas)
    print("== upgrade: a scan hashes the library's files by their contents")
    scan(client, library_id)
    external = library_assets(client, library_id)
    wrong = [a["originalFileName"] for a in external if a["checksum"] != sha1(Path(a["originalPath"]))]
    check("every library file hashed by its contents", not wrong, f"{len(external)} files" + (f", wrong: {wrong}" if wrong else ""))

    # what the app knows of the server's photos, by which it decides what is backed up
    stream = client.post("/api/sync/stream", json={"types": ["AssetsV2"]}, timeout=60).text.splitlines()
    synced = {d["id"]: d["checksum"] for d in (json.loads(line)["data"] for line in stream if '"AssetV2"' in line)}
    stale = [a["originalFileName"] for a in external if synced.get(a["id"]) != sha1(Path(a["originalPath"]))]
    check("the app's sync carries the new checksums", not stale, f"{len(synced)} assets synced" + (f", stale: {stale}" if stale else ""))

    print("== the duplicates the earlier backup made")
    groups = client.get("/api/duplicates").json()
    by_id = {a["id"]: a for a in external}
    visible = [a for a in external if a["visibility"] == "timeline"]
    pairs = [g for g in groups if len(g["assets"]) == 2 and sum(1 for a in g["assets"] if a["id"] in by_id) == 1]
    check("each visible library file is grouped with its upload", len(pairs) == len(visible) == len(groups),
          f"{len(groups)} groups, {len(visible)} visible library files")
    suggested = all(g["suggestedKeepAssetIds"] == [next(a["id"] for a in g["assets"] if a["id"] in by_id)] for g in groups)
    check("the library's file is the one suggested to keep", suggested)
    hidden = [g for g in groups if any(a["visibility"] == "hidden" for a in g["assets"])]
    check("live photos' hidden videos are not grouped", not hidden)

    # as the utility's "Deduplicate all" does
    resolve = {"groups": [{"duplicateId": g["duplicateId"], "keepAssetIds": g["suggestedKeepAssetIds"],
                           "trashAssetIds": [a["id"] for a in g["assets"] if a["id"] not in g["suggestedKeepAssetIds"]]}
                          for g in groups]}
    outcome = client.post("/api/duplicates/resolve", json=resolve).json()
    check("deduplicate all", all(r["success"] for r in outcome), f"{len(outcome)} groups resolved")
    wait_for_queues(client)
    timeline = assets(client, visibility="timeline")
    uploads_left = [a["originalFileName"] for a in timeline if not a.get("libraryId")]
    check("the timeline shows each photo once, from the library", not uploads_left and len(timeline) == len(visible),
          f"{len(timeline)} on the timeline" + (f", uploads left: {uploads_left}" if uploads_left else ""))
    album = next(a for a in client.get("/api/albums").json() if a["albumName"] == "Holiday")
    album_assets = assets(client, albumIds=[album["id"]])
    check("the album now holds the library's files", sorted(a["originalFileName"] for a in album_assets) ==
          ["IMG_5561.HEIC", "IMG_5562.HEIC"] and all(a["id"] in by_id for a in album_assets))
    favorite = next(a for a in timeline if a["originalFileName"] == "IMG_5563.HEIC")
    check("the favorite carried over", favorite["isFavorite"] and favorite["id"] in by_id)
    trashed = assets(client, trashedAfter="2000-01-01T00:00:00Z", withDeleted=True)
    check("the uploads are in the trash, not deleted", len([a for a in trashed if not a.get("libraryId")]) == len(visible),
          f"{len(trashed)} in the trash")

    # the uploads' live photo videos, hidden, go with their stills when the trash is emptied (or after 30 days)
    client.post("/api/trash/empty").raise_for_status()
    time.sleep(2)
    wait_for_queues(client)
    leftover = [a["originalFileName"] for a in assets(client, visibility="hidden") + assets(client, withDeleted=True)
                if not a.get("libraryId")]
    check("emptying the trash deletes the uploads, live photo videos too", not leftover,
          f"left: {leftover}" if leftover else "")

    print("== the next backups")
    count = len(assets(client, visibility="timeline")) + len(assets(client, visibility="hidden"))
    for header in (False, True):
        responses = backup(client, nas, header)
        dupes = [n for n, r in responses.items() if r["status"] == "duplicate" and r["id"] in by_id]
        check(f"the phone's backup is recognised ({'with' if header else 'without'} the checksum header)",
              len(dupes) == len(responses), f"{len(dupes)} of {len(responses)} answered with the library's file")
    files = media(nas)
    bulk = client.post("/api/assets/bulk-upload-check", json={"assets": [
        {"id": p.name, "checksum": hashlib.sha1(p.read_bytes()).hexdigest()} for p in files]}).json()["results"]
    check("bulk upload check (web, CLI) rejects them", all(r["action"] == "reject" and r["assetId"] in by_id for r in bulk))
    wait_for_queues(client)
    now = len(assets(client, visibility="timeline")) + len(assets(client, visibility="hidden"))
    check("no new assets", now == count, f"{now} assets, {count} before")

    print("== a new file in the library")
    new = nas / "2026" / "new" / NEW_PHOTO.name
    new.parent.mkdir(exist_ok=True)
    shutil.copy2(NEW_PHOTO, new)
    scan(client, library_id)
    response = upload(client, NEW_PHOTO)
    check("hashed when imported, and its upload recognised", response["status"] == "duplicate", response["status"])

    print("== a file changed in place")
    changed = nas / "2026" / "japanese-shop.jpg"
    old_contents = changed.read_bytes()
    shutil.copyfile(OTHER_PHOTO, changed)
    scan(client, library_id)
    asset = next(a for a in library_assets(client, library_id) if a["originalPath"] == str(changed))
    check("hashed again", asset["checksum"] == sha1(changed))
    old_checksum = hashlib.sha1(old_contents).hexdigest()
    claim = client.post("/api/assets/bulk-upload-check", json={"assets": [{"id": "old", "checksum": old_checksum}]}).json()
    check("its old contents are no longer the library file's", claim["results"][0].get("assetId") != asset["id"],
          f"old contents: {claim['results'][0]['action']}, {'trashed upload' if claim['results'][0].get('isTrashed') else 'new'}")
    response = upload(client, OTHER_PHOTO)
    check("an upload of its new contents is recognised", response["status"] == "duplicate" and response["id"] == asset["id"])

    print("== two files with the same contents")
    copy = nas / "2026" / "copy" / "prairie_falcon.jpg"
    copy.parent.mkdir(exist_ok=True)
    shutil.copy2(nas / "2026" / "prairie_falcon.jpg", copy)
    scan(client, library_id)
    both = [a for a in library_assets(client, library_id) if a["originalFileName"] == "prairie_falcon.jpg"]
    hashed = [a for a in both if a["checksum"] == sha1(copy)]
    check("both imported, one hashed by its contents", len(both) == 2 and len(hashed) == 1)
    other = next(a for a in both if a not in hashed)
    scan(client, library_id)
    again = next(a for a in library_assets(client, library_id) if a["id"] == other["id"])
    check("the other is not hashed again by every scan", again["checksum"] == other["checksum"])

    print("== the share unmounted")
    unmounted = nas.with_name(nas.name + "-unmounted")
    nas.rename(unmounted)
    try:
        scan(client, library_id)
        offline = [a for a in library_assets(client, library_id) if a["isOffline"]]
        check("the library's files go offline", len(offline) == len(library_assets(client, library_id)), f"{len(offline)} offline")
        response = upload(client, unmounted / "2026" / "09" / "IMG_5564.HEIC")
        check("a backup meanwhile is still recognised, not uploaded again", response["status"] == "duplicate", response["status"])
    finally:
        unmounted.rename(nas)
    scan(client, library_id)
    online = [a for a in library_assets(client, library_id) if not a["isOffline"]]
    check("back online after the next scan", len(online) == len(library_assets(client, library_id)), f"{len(online)} online")

    sidecars = sorted(str(p.relative_to(nas)) for p in nas.rglob("*.xmp"))
    print(f"\n  note: Immich wrote {len(sidecars)} XMP sidecar(s) into the library folder: {sidecars}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2286")
    parser.add_argument("--nas", type=Path, required=True)
    parser.add_argument("phase", choices=["before", "after"])
    args = parser.parse_args()
    client = httpx.Client(base_url=args.url, timeout=60)
    user_id = login(client)
    (before if args.phase == "before" else after)(client, user_id, args.nas.resolve())
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
