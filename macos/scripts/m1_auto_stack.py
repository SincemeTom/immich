"""Auto stacking, end to end, on a fresh test instance with real photos: a Sony A7C II's raw + JPEG pairs, iPhone
photos taken seconds apart, an edited copy made of one of them, and a burst.

  an external library (the NAS) with the user's auto stacking on: raw + JPEG, edited copies, the burst are stacked,
    with the right cover; a raw file of the same name from another shoot is not
  an upload of a raw + JPEG pair, into folders of their own: stacked after the upload
  similar photos turned on: the shots seconds apart join, those further apart or less alike do not; two raw + JPEG
    stacks shot seconds apart (CAM00088, CAM00089) are merged into one
  no matter when taken: a copy of IMG_5568 exported a year later joins it, and IMG_5569 and IMG_5570, 10.4 s apart
    and all but the same (0.019); CAM00083, 25 minutes from CAM00088 and only alike (0.056), does not
  a photo taken out of an automatic stack stays out; a stack made by hand is never touched
  a cover someone chose (CAM00089.ARW) stays when the stack of CAM00088 is merged into it, and the stack is theirs
  removing the automatic stacks, stacking again, the job queue's "all", auto stacking turned off

Smart search runs on the machine learning service of the main install, with its model, so that distances are those of
the main library. Usage (with the machine-learning venv's python, which has httpx):
  m1_auto_stack.py --url http://127.0.0.1:2289 --home ~/Library/Application\\ Support/Immich-p5 --nas /tmp/immich-p5/nas
"""

import argparse
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

EMAIL, PASSWORD = "p5@immich.local", "p5-password"
EXIFTOOL = Path.home() / "Library/Application Support/Immich/current/server/node_modules/.pnpm/node_modules/.bin/exiftool"
REPO = Path(__file__).resolve().parents[2]
E2E = REPO / "e2e/test-assets"

RAW_PAIRS = [f"CAM000{n}" for n in range(74, 80)]
IPHONE = [f"IMG_55{n}" for n in range(66, 74)]
UPLOADED_PAIR = "CAM00081"
# two raw + JPEG pairs shot 3.4 s apart, their JPEGs at a distance of 0.0455
MERGED_PAIRS = ["CAM00088", "CAM00089"]

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}", flush=True)
    return ok


def main_library(names: list[str]) -> dict[str, Path]:
    """Real files, from the main install's library"""
    quoted = ",".join(f"'{n}'" for n in names)
    out = subprocess.run(["immichctl", "psql", "-At", "-F", "\t", "-c",
                          f'select "originalFileName", "originalPath" from asset where "originalFileName" in ({quoted})'],
                         capture_output=True, text=True, check=True).stdout
    found = {name: Path(path) for name, path in (line.split("\t") for line in out.splitlines() if line)}
    missing = set(names) - set(found)
    if missing:
        sys.exit(f"not in the main library: {sorted(missing)}")
    return found


class Instance:
    def __init__(self, url: str, home: Path) -> None:
        self.client = httpx.Client(base_url=url, timeout=120)
        self.ctl = home / "bin/immichctl"

    def sql(self, query: str) -> list[list[str]]:
        out = subprocess.run([str(self.ctl), "psql", "-At", "-F", "\t", "-c", query], capture_output=True, text=True,
                             check=True)
        return [line.split("\t") for line in out.stdout.splitlines() if line]

    def login(self) -> str:
        c = self.client
        if not c.get("/api/server/config").json().get("isInitialized"):
            c.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "P5", "password": PASSWORD}).raise_for_status()
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

    def preferences(self, **auto_stack: Any) -> None:
        self.client.put("/api/users/me/preferences", json={"autoStack": auto_stack}).raise_for_status()

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

    def upload(self, path: Path, name: str) -> str:
        now = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
        with path.open("rb") as handle:
            response = self.client.post(
                "/api/assets",
                data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": name},
                files={"assetData": (name, handle, "application/octet-stream")},
                timeout=300,
            )
        response.raise_for_status()
        return str(response.json()["id"])

    def stacks(self) -> dict[frozenset[str], dict[str, Any]]:
        """Each stack, by the file names in it: its cover, and whether auto stacking made it"""
        rows = self.sql("""
            select s.id, s."isAutomatic", p."originalFileName", string_agg(a."originalFileName", ',')
            from stack s join asset p on p.id = s."primaryAssetId" join asset a on a."stackId" = s.id
            where a."deletedAt" is null group by s.id, s."isAutomatic", p."originalFileName"
        """)
        return {frozenset(names.split(",")): {"id": sid, "auto": auto == "t", "cover": cover}
                for sid, auto, cover, names in rows}

    def asset_id(self, name: str) -> str:
        rows = self.sql(f"select id from asset where \"originalFileName\" = '{name}' and \"deletedAt\" is null")
        return rows[0][0]

    def run(self, force: bool = False) -> None:
        self.client.post("/api/auto-stacks/run", json={"force": force}).raise_for_status()
        time.sleep(2)
        self.wait()


def expect_stack(stacks: dict[frozenset[str], dict[str, Any]], name: str, members: set[str], cover: str) -> None:
    stack = stacks.get(frozenset(members))
    check(name, bool(stack) and stack["cover"] == cover and stack["auto"],
          f"cover {stack['cover']}" if stack else f"not found; stacks: {[sorted(k) for k in stacks]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2289")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--nas", type=Path, required=True)
    parser.add_argument("--ml-url", default="http://127.0.0.1:3003")
    args = parser.parse_args()
    immich = Instance(args.url, args.home)
    c = immich.client
    user_id = immich.login()
    print("== the defaults of this install")
    template = c.get("/api/system-config").json()["storageTemplate"]
    check("storage template on, {{y}}/{{MM}}/{{filename}}",
          template["enabled"] is True and template["template"] == "{{y}}/{{MM}}/{{filename}}", str(template))
    features = c.get("/api/users/me/preferences").json()
    check("folders on, and folders, people and memories in the sidebar",
          features["folders"] == {"enabled": True, "sidebarWeb": True} and features["people"]["sidebarWeb"] is True
          and features["memories"]["sidebarWeb"] is True)
    # uploads stay in folders of their own, so that raw + JPEG pairs are recognised by when and with what they were taken
    immich.configure(machineLearning__urls=[args.ml_url], machineLearning__facialRecognition__enabled=False,
                     machineLearning__ocr__enabled=False, storageTemplate__enabled=False)

    print("== the NAS")
    files = main_library([f"{n}.{e}" for n in RAW_PAIRS + MERGED_PAIRS + [UPLOADED_PAIR, "CAM00083"] for e in ("ARW", "JPG")]
                         + [f"{n}.HEIC" for n in IPHONE] + ["CAM00080.ARW"])
    shutil.rmtree(args.nas, ignore_errors=True)
    shoot, iphone, other, burst = (args.nas / d for d in ("2026-10-28 A7C2", "2026-09 iPhone", "2025 other", "burst"))
    for folder in (shoot, iphone, other, burst):
        folder.mkdir(parents=True)
    for name in RAW_PAIRS + MERGED_PAIRS:
        for ext in ("ARW", "JPG"):
            shutil.copy2(files[f"{name}.{ext}"], shoot / f"{name}.{ext}")
    for name in IPHONE:
        shutil.copy2(files[f"{name}.HEIC"], iphone / f"{name}.HEIC")
    # an edited copy, as iPhone exports it: another file, the same moment
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-r", "90",
                    str(files["IMG_5571.HEIC"]), "--out", str(iphone / "IMG_E5571.JPG")], check=True, capture_output=True)
    subprocess.run([str(EXIFTOOL), "-q", "-overwrite_original", "-TagsFromFile", str(files["IMG_5571.HEIC"]),
                    "-all:all", str(iphone / "IMG_E5571.JPG")], check=True)
    shutil.copy2(files["CAM00083.JPG"], shoot / "CAM00083.JPG")
    # a copy of IMG_5568 exported a year later, smaller, under another name
    export = args.nas / "2027 export" / "Exported 0042.jpg"
    export.parent.mkdir()
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "2048",
                    str(files["IMG_5568.HEIC"]), "--out", str(export)], check=True, capture_output=True)
    # its metadata, orientation included, but dated a year later
    subprocess.run([str(EXIFTOOL), "-q", "-overwrite_original", "-TagsFromFile", str(files["IMG_5568.HEIC"]),
                    "-all:all", "-AllDates=2027:09:30 13:52:58", "-OffsetTime*=+08:00", str(export)], check=True)
    # a raw file of the same name as one of the shoot's, from another day
    shutil.copy2(files["CAM00080.ARW"], other / "CAM00074.ARW")
    # a burst, as Google Camera marks one
    for sample in ("albums/nature/prairie_falcon.jpg", "albums/nature/silver_fir.jpg", "albums/nature/wood_anemones.jpg"):
        shutil.copy2(E2E / sample, burst / Path(sample).name)
    subprocess.run([str(EXIFTOOL), "-q", "-overwrite_original", "-XMP-GCamera:BurstID=burst-0001",
                    *[str(p) for p in burst.iterdir()]], check=True)

    print("== auto stacking on, the external library scanned")
    prefs = c.get("/api/users/me/preferences").json()["autoStack"]
    check("defaults: on, every rule, similar photos within 600 s, all but the same whenever taken",
          prefs == {"enabled": True, "burst": True, "rawJpeg": True, "edited": True, "similar": True,
                    "maxDistance": 0.06, "maxSeconds": 600, "anytime": True, "anytimeDistance": 0.03}, str(prefs))
    # the scenarios below turn the rules on one by one, from bursts, raw + JPEG and edited copies only
    immich.preferences(enabled=True, similar=False, maxSeconds=10, anytime=False, anytimeDistance=0.02)
    library = c.post("/api/libraries", json={"ownerId": user_id, "importPaths": [str(args.nas)], "name": "NAS"}).json()
    start = time.time()
    c.post(f"/api/libraries/{library['id']}/scan").raise_for_status()
    time.sleep(3)
    immich.wait()
    print(f"    imported and processed in {time.time() - start:.0f}s")
    stacks = immich.stacks()
    for name in RAW_PAIRS + MERGED_PAIRS:
        expect_stack(stacks, f"{name}: raw + JPEG, the JPEG as cover", {f"{name}.ARW", f"{name}.JPG"}, f"{name}.JPG")
    expect_stack(stacks, "IMG_E5571: the edited copy with its original, as cover", {"IMG_E5571.JPG", "IMG_5571.HEIC"},
                 "IMG_E5571.JPG")
    expect_stack(stacks, "the burst", {"prairie_falcon.jpg", "silver_fir.jpg", "wood_anemones.jpg"},
                 "prairie_falcon.jpg")
    other_raw = immich.sql("select coalesce(\"stackId\"::text, 'none') from asset "
                           "where \"originalPath\" like '%/2025 other/CAM00074.ARW'")
    check("a raw file of the same name from another shoot stays out", other_raw == [["none"]], str(other_raw))
    check("nothing else stacked", len(stacks) == len(RAW_PAIRS) + len(MERGED_PAIRS) + 2, f"{len(stacks)} stacks")
    check("the export a year later is not stacked by default",
          not any("Exported 0042.jpg" in k for k in stacks))
    lone = immich.sql("select count(*) from asset a join asset_job_status j on j.\"assetId\" = a.id "
                      "where a.\"stackId\" is null and j.\"autoStackedAt\" is not null")[0][0]
    check("only stacked photos are marked as stacked", lone == "0", lone)

    print("== an upload of a raw + JPEG pair")
    jpeg = immich.upload(files[f"{UPLOADED_PAIR}.JPG"], f"{UPLOADED_PAIR}.JPG")
    raw = immich.upload(files[f"{UPLOADED_PAIR}.ARW"], f"{UPLOADED_PAIR}.ARW")
    time.sleep(3)
    immich.wait()
    paths = immich.sql(f"select \"originalPath\" from asset where id in ('{jpeg}', '{raw}')")
    stacks = immich.stacks()
    expect_stack(stacks, "stacked after the upload, the JPEG as cover",
                 {f"{UPLOADED_PAIR}.ARW", f"{UPLOADED_PAIR}.JPG"}, f"{UPLOADED_PAIR}.JPG")
    check("though uploaded into folders of their own", len({str(Path(p[0]).parent) for p in paths}) == 2,
          ", ".join(Path(p[0]).parent.name for p in paths))

    print("== a stack made by hand")
    manual = c.post("/api/stacks", json={"assetIds": [immich.asset_id("IMG_5566.HEIC"),
                                                      immich.asset_id("IMG_5567.HEIC")]}).json()
    check("made", bool(manual.get("id")))

    print("== a cover chosen by hand")
    chosen = immich.sql("select \"stackId\" from asset where \"originalFileName\" = 'CAM00089.ARW'")[0][0]
    c.put(f"/api/stacks/{chosen}", json={"primaryAssetId": immich.asset_id("CAM00089.ARW")}).raise_for_status()
    stack = immich.stacks()[frozenset({"CAM00089.ARW", "CAM00089.JPG"})]
    check("CAM00089.ARW is the cover, and the stack is no longer automatic",
          stack["cover"] == "CAM00089.ARW" and not stack["auto"], str(stack))

    print("== similar photos on (recommended: 0.06, 10 s)")
    immich.preferences(similar=True)
    immich.run()
    stacks = immich.stacks()
    expect_stack(stacks, "IMG_5572 and IMG_5573, seconds after IMG_5571, join its stack, the edited copy still cover",
                 {"IMG_E5571.JPG", "IMG_5571.HEIC", "IMG_5572.HEIC", "IMG_5573.HEIC"}, "IMG_E5571.JPG")
    loose = {r[0] for r in immich.sql("select \"originalFileName\" from asset where \"stackId\" is null "
                                      "and \"originalFileName\" like 'IMG_55%' and visibility = 'timeline'")}
    check("IMG_5568, IMG_5569, IMG_5570 (10 to 27 s apart) stay out", {"IMG_5568.HEIC", "IMG_5569.HEIC",
                                                                       "IMG_5570.HEIC"} <= loose, str(sorted(loose)))
    merged = stacks.get(frozenset({"CAM00088.ARW", "CAM00088.JPG", "CAM00089.ARW", "CAM00089.JPG"}))
    check("the raw + JPEG stacks of CAM00088 and CAM00089, 3.4 s apart, merged into the one with the chosen cover",
          bool(merged) and merged["id"] == chosen and merged["cover"] == "CAM00089.ARW" and not merged["auto"],
          str(merged) if merged else f"stacks: {[sorted(k) for k in stacks]}")
    check("the raw + JPEG stacks further apart stay apart",
          all(frozenset({f"{n}.ARW", f"{n}.JPG"}) in stacks for n in RAW_PAIRS), f"{len(stacks)} stacks")
    check("the stack made by hand is untouched",
          stacks.get(frozenset({"IMG_5566.HEIC", "IMG_5567.HEIC"}), {}).get("auto") is False)

    print("== no matter when taken (0.02)")
    immich.preferences(anytime=True)
    immich.run()
    stacks = immich.stacks()
    with_export = [k for k in stacks if "Exported 0042.jpg" in k]
    check("the copy exported a year later joins IMG_5568", with_export == [frozenset({"Exported 0042.jpg", "IMG_5568.HEIC"})],
          str([sorted(k) for k in with_export]))
    check("IMG_5569 and IMG_5570, 10.4 s apart and all but the same, stacked",
          frozenset({"IMG_5569.HEIC", "IMG_5570.HEIC"}) in stacks)
    check("CAM00083, 25 minutes from CAM00088 and only alike, stays out", not any("CAM00083.JPG" in k for k in stacks))
    check("other stacks unchanged", len(stacks) == len(RAW_PAIRS) + 4 + 1 + 2, f"{len(stacks)} stacks")
    immich.preferences(anytime=False)

    print("== a photo taken out of an automatic stack")
    stack = stacks[frozenset({"IMG_E5571.JPG", "IMG_5571.HEIC", "IMG_5572.HEIC", "IMG_5573.HEIC"})]
    c.delete(f"/api/stacks/{stack['id']}/assets/{immich.asset_id('IMG_5573.HEIC')}").raise_for_status()
    immich.run()
    check("stays out when stacking runs again",
          frozenset({"IMG_E5571.JPG", "IMG_5571.HEIC", "IMG_5572.HEIC"}) in immich.stacks())

    print("== removing the automatic stacks")
    removed = c.delete("/api/auto-stacks").json()["count"]
    stacks = immich.stacks()
    check("all of them removed but those made or changed by hand, the photos kept", removed == len(RAW_PAIRS) + 5
          and set(stacks) == {frozenset({"IMG_5566.HEIC", "IMG_5567.HEIC"}),
                              frozenset({"CAM00088.ARW", "CAM00088.JPG", "CAM00089.ARW", "CAM00089.JPG"})},
          f"{removed} removed, left: {[sorted(k) for k in stacks]}")
    check("no photo deleted", immich.sql("select count(*) from asset where \"deletedAt\" is null "
                                         "and visibility = 'timeline'")[0][0] == str((len(RAW_PAIRS) + len(MERGED_PAIRS)) * 2 + len(IPHONE) + 1 + 1 + 3 + 2 + 2))

    print("== stacking again")
    immich.run()
    stacks = immich.stacks()
    check("the same stacks again", len(stacks) == len(RAW_PAIRS) + 5
          and frozenset({"CAM00088.ARW", "CAM00088.JPG", "CAM00089.ARW", "CAM00089.JPG"}) in stacks,
          f"{len(stacks)} stacks")
    check("the photo taken out stays out", frozenset({"IMG_E5571.JPG", "IMG_5571.HEIC", "IMG_5572.HEIC"}) in stacks)

    print("== the job queue's all")
    c.put("/api/jobs/autoStack", json={"command": "start", "force": True}).raise_for_status()
    time.sleep(2)
    immich.wait()
    check("also stacks the photo taken out",
          frozenset({"IMG_E5571.JPG", "IMG_5571.HEIC", "IMG_5572.HEIC", "IMG_5573.HEIC"}) in immich.stacks())

    print("== auto stacking off")
    immich.preferences(enabled=False)
    c.request("DELETE", "/api/assets", json={"ids": [jpeg, raw], "force": True}).raise_for_status()
    immich.wait()
    immich.upload(files[f"{UPLOADED_PAIR}.JPG"], f"{UPLOADED_PAIR}.JPG")
    immich.upload(files[f"{UPLOADED_PAIR}.ARW"], f"{UPLOADED_PAIR}.ARW")
    uploaded = immich.sql(f"select count(*) from asset where \"originalFileName\" like '{UPLOADED_PAIR}.%' "
                          "and \"deletedAt\" is null")[0][0]
    time.sleep(3)
    immich.wait()
    check("a new upload is not stacked", uploaded == "2" and not any(f"{UPLOADED_PAIR}.JPG" in k for k in immich.stacks()),
          f"{uploaded} uploaded")

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
