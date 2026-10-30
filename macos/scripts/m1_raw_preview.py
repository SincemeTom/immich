"""Previews of raw photos, end to end, on a fresh test instance with real Sony A7C II raw + JPEG pairs.

  by default the preview of a raw file is made from the JPEG the camera embedded: it looks as the camera's own JPEG
    does, colour for colour
  turning "Prefer embedded preview" off makes the previews of raw photos again, decoding the raw data, and only theirs;
    turning it on again makes them again
  the upgrade: an install whose raw previews were made decoding the raw data, as upstream's default did, has them made
    again from the embedded JPEG when the server starts, once

Usage (with the machine-learning venv's python, which has httpx, Pillow and numpy):
  m1_raw_preview.py --url http://127.0.0.1:2290 --home ~/Library/Application\\ Support/Immich-p6
"""

import argparse
import hashlib
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from PIL import Image

EMAIL, PASSWORD = "p6@immich.local", "p6-password"
PAIRS = ["CAM00074", "CAM00076", "CAM00088"]

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}", flush=True)
    return ok


def main_library(names: list[str]) -> dict[str, Path]:
    quoted = ",".join(f"'{n}'" for n in names)
    out = subprocess.run(["immichctl", "psql", "-At", "-F", "\t", "-c",
                          f'select "originalFileName", "originalPath" from asset where "originalFileName" in ({quoted})'],
                         capture_output=True, text=True, check=True).stdout
    found = {name: Path(path) for name, path in (line.split("\t") for line in out.splitlines() if line)}
    missing = set(names) - set(found)
    if missing:
        sys.exit(f"not in the main library: {sorted(missing)}")
    return found


def difference(a: Path, b: Path) -> tuple[float, float]:
    """How far apart two pictures look: the mean absolute difference of their pixels (0-255) at one size, and of their
    mean brightness"""
    images = [np.asarray(Image.open(p).convert("RGB").resize((480, 320)), dtype=np.float32) for p in (a, b)]
    return float(np.abs(images[0] - images[1]).mean()), float(abs(images[0].mean() - images[1].mean()))


class Instance:
    def __init__(self, url: str, home: Path) -> None:
        self.client = httpx.Client(base_url=url, timeout=120)
        self.ctl = home / "bin/immichctl"

    def sql(self, query: str) -> list[list[str]]:
        out = subprocess.run([str(self.ctl), "psql", "-At", "-F", "\t", "-c", query], capture_output=True, text=True,
                             check=True)
        return [line.split("\t") for line in out.stdout.splitlines() if line]

    def login(self) -> None:
        c = self.client
        if not c.get("/api/server/config").json().get("isInitialized"):
            c.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "P6", "password": PASSWORD}).raise_for_status()
        body = c.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()
        c.headers["Authorization"] = f"Bearer {body['accessToken']}"

    def configure(self, **changes: Any) -> None:
        config = self.client.get("/api/system-config").json()
        for path, value in changes.items():
            node = config
            *parents, key = path.split("__")
            for parent in parents:
                node = node[parent]
            node[key] = value
        self.client.put("/api/system-config", json=config).raise_for_status()

    def wait(self, timeout: int = 600) -> None:
        deadline, quiet = time.time() + timeout, 0
        while time.time() < deadline:
            queues = {q["name"]: q["statistics"] for q in self.client.get("/api/queues").json()}
            busy = any(s["active"] or s["waiting"] or s["delayed"] for s in queues.values())
            quiet = 0 if busy else quiet + 1
            if quiet >= 3:
                return
            time.sleep(1)
        sys.exit("queues did not drain in time")

    def upload(self, path: Path, name: str) -> None:
        now = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
        with path.open("rb") as handle:
            self.client.post("/api/assets", data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": name},
                             files={"assetData": (name, handle, "application/octet-stream")},
                             timeout=300).raise_for_status()

    def previews(self) -> dict[str, tuple[Path, str]]:
        """Each photo's preview, and a hash of it"""
        rows = self.sql("select a.\"originalFileName\", f.path from asset a join asset_file f on f.\"assetId\" = a.id "
                        "and f.type = 'preview' and not f.\"isEdited\" where a.\"deletedAt\" is null")
        return {name: (Path(path), hashlib.sha1(Path(path).read_bytes()).hexdigest()) for name, path in rows}

    def restart(self) -> None:
        subprocess.run([str(self.ctl), "restart", "server"], check=True, capture_output=True)
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                if self.client.get("/api/server/ping", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(1)
        self.login()


def compare(immich: Instance, label: str) -> list[tuple[float, float]]:
    previews = immich.previews()
    diffs = []
    for name in PAIRS:
        diff = difference(previews[f"{name}.ARW"][0], previews[f"{name}.JPG"][0])
        diffs.append(diff)
        print(f"    {label} {name}: pixels {diff[0]:.1f}, brightness {diff[1]:.1f}")
    return diffs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2290")
    parser.add_argument("--home", type=Path, required=True)
    args = parser.parse_args()
    immich = Instance(args.url, args.home)
    immich.login()
    files = main_library([f"{n}.{e}" for n in PAIRS for e in ("ARW", "JPG")])

    print("== the default")
    config = immich.client.get("/api/system-config").json()
    check("Prefer embedded preview is on", config["image"]["extractEmbedded"] is True)
    for name in PAIRS:
        immich.upload(files[f"{name}.JPG"], f"{name}.JPG")
        immich.upload(files[f"{name}.ARW"], f"{name}.ARW")
    time.sleep(3)
    immich.wait()
    embedded = compare(immich, "embedded JPEG")
    check("the preview of each raw file looks as the camera's JPEG", all(d[0] < 4 and d[1] < 2 for d in embedded),
          ", ".join(f"{d[0]:.1f}" for d in embedded))
    before = immich.previews()

    print("== turned off")
    immich.configure(image__extractEmbedded=False)
    time.sleep(3)
    immich.wait()
    after = immich.previews()
    decoded = compare(immich, "decoded raw   ")
    check("the previews of the raw files are made again", all(after[f"{n}.ARW"][1] != before[f"{n}.ARW"][1] for n in PAIRS))
    check("those of the JPEGs are not", all(after[f"{n}.JPG"][1] == before[f"{n}.JPG"][1] for n in PAIRS))
    check("decoded, the raw files look further from the camera's JPEG",
          sum(d[0] for d in decoded) > 2 * sum(d[0] for d in embedded),
          f"{sum(d[0] for d in decoded) / len(decoded):.1f} against {sum(d[0] for d in embedded) / len(embedded):.1f}")

    print("== on again")
    immich.configure(image__extractEmbedded=True)
    time.sleep(3)
    immich.wait()
    again = immich.previews()
    check("the previews of the raw files are made again, as before",
          all(difference(again[f"{n}.ARW"][0], before[f"{n}.ARW"][0])[0] < 1 for n in PAIRS))

    print("== another setting changed")
    mtimes = {name: path.stat().st_mtime for name, (path, _) in again.items()}
    immich.configure(image__preview__quality=81)
    time.sleep(3)
    immich.wait()
    check("the previews are left alone",
          all(path.stat().st_mtime == mtimes[name] for name, (path, _) in immich.previews().items()))
    immich.configure(image__preview__quality=80)

    print("== the upgrade, from previews made decoding the raw data")
    immich.configure(image__extractEmbedded=False)
    time.sleep(3)
    immich.wait()
    # as before this was kept: no record of how they were made, and the setting at upstream's default
    immich.sql("delete from system_metadata where key = 'raw-previews'")
    immich.sql("update system_metadata set value = value #- '{image,extractEmbedded}' where key = 'system-config'")
    decoded_previews = immich.previews()
    immich.restart()
    time.sleep(5)
    immich.wait()
    upgraded = immich.previews()
    check("made again from the embedded JPEG when the server starts",
          all(upgraded[f"{n}.ARW"][1] != decoded_previews[f"{n}.ARW"][1] for n in PAIRS)
          and all(difference(upgraded[f"{n}.ARW"][0], before[f"{n}.ARW"][0])[0] < 1 for n in PAIRS))
    check("the JPEGs' left alone", all(upgraded[f"{n}.JPG"][1] == decoded_previews[f"{n}.JPG"][1] for n in PAIRS))
    state = immich.sql("select value from system_metadata where key = 'raw-previews'")
    check("recorded", state == [['{"extractEmbedded": true}']], str(state))
    mtimes = {name: path.stat().st_mtime for name, (path, _) in upgraded.items()}
    immich.restart()
    time.sleep(5)
    immich.wait()
    check("not again at the next start",
          all(path.stat().st_mtime == mtimes[name] for name, (path, _) in immich.previews().items()))

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
