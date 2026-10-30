"""Rotating and mirroring videos, end to end, on a fresh test instance: each edit is checked against the same edit of
an image, through the server's own image pipeline, on the frame the video shows; then as it plays (the stream copied
with a new display matrix), downloads, shows in thumbnails and sizes, streams in real time (HLS), and after the video
is transcoded again; and the edits removed. The viewer's quick rotation and the editor run in a browser.

Usage (with the machine-learning venv's python, which has httpx and Pillow):
  m1_video_rotation.py --url http://127.0.0.1:2290 --home ~/Library/Application\\ Support/Immich-p7 --media /tmp/vrot/media
"""

import argparse
import io
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageChops, ImageStat

EMAIL, PASSWORD = "p7@immich.local", "p7-password"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}", flush=True)
    return ok


class Instance:
    def __init__(self, url: str, home: Path) -> None:
        self.url, self.home = url, home
        self.client = httpx.Client(base_url=url, timeout=300)
        self.ffmpeg = str(home / "current/ffmpeg/ffmpeg")
        self.ffprobe = str(home / "current/ffmpeg/ffprobe")

    def login(self) -> None:
        c = self.client
        if not c.get("/api/server/config").json().get("isInitialized"):
            c.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "P7", "password": PASSWORD}).raise_for_status()
        body = c.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()
        c.headers["Authorization"] = f"Bearer {body['accessToken']}"
        self.token = body["accessToken"]

    def wait(self, timeout: int = 300) -> None:
        deadline, quiet = time.time() + timeout, 0
        while time.time() < deadline:
            queues = {q["name"]: q["statistics"] for q in self.client.get("/api/queues").json()}
            busy = any(s["active"] or s["waiting"] or s["delayed"] for s in queues.values())
            quiet = 0 if busy else quiet + 1
            if quiet >= 3:
                return
            time.sleep(1)
        sys.exit("queues did not drain in time")

    def upload(self, path: Path) -> str:
        with path.open("rb") as handle:
            response = self.client.post(
                "/api/assets",
                data={"fileCreatedAt": "2024-05-01T10:00:00Z", "fileModifiedAt": "2024-05-01T10:00:00Z",
                      "filename": path.name},
                files={"assetData": (path.name, handle, "application/octet-stream")})
        response.raise_for_status()
        return str(response.json()["id"])

    def asset(self, asset_id: str) -> dict[str, Any]:
        return self.client.get(f"/api/assets/{asset_id}").json()

    def edit(self, asset_id: str, edits: list[dict[str, Any]]) -> None:
        response = (self.client.delete(f"/api/assets/{asset_id}/edits") if not edits
                    else self.client.put(f"/api/assets/{asset_id}/edits", json={"edits": edits}))
        if response.status_code >= 400:
            raise RuntimeError(f"{response.status_code} {response.text}")
        time.sleep(1)
        self.wait()

    def get(self, path: str, **params: Any) -> bytes:
        response = self.client.get(path, params=params)
        response.raise_for_status()
        return response.content

    def frame(self, video: bytes, at: float = 0.0) -> Image.Image:
        """The frame the video shows at a time, as a player shows it: turned by its display matrix"""
        with tempfile.NamedTemporaryFile(suffix=".mp4") as source:
            source.write(video)
            source.flush()
            png = subprocess.run([self.ffmpeg, "-v", "error", "-ss", str(at), "-i", source.name, "-frames:v", "1",
                                  "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=True).stdout
        return Image.open(io.BytesIO(png)).convert("RGB")

    def sql(self, query: str) -> list[list[str]]:
        out = subprocess.run([str(self.home / "bin/immichctl"), "psql", "-At", "-F", "\t", "-c", query],
                             capture_output=True, text=True, check=True)
        return [line.split("\t") for line in out.stdout.splitlines() if line]


def difference(a: Image.Image, b: Image.Image) -> float:
    """Mean difference per channel, out of 255, once b is scaled to a"""
    if a.size != b.size:
        if (a.width > a.height) != (b.width > b.height):
            return 255.0
        b = b.resize(a.size, Image.Resampling.BILINEAR)
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


ROTATE = lambda angle: {"action": "rotate", "parameters": {"angle": angle}}  # noqa: E731
MIRROR = lambda axis: {"action": "mirror", "parameters": {"axis": axis}}  # noqa: E731


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2290")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--media", type=Path, required=True)
    args = parser.parse_args()

    immich = Instance(args.url, args.home)
    immich.login()
    c = immich.client

    print("== upload")
    ids = {name: immich.upload(args.media / name) for name in ["landscape.mp4", "portrait.mov", "transcoded.avi"]}
    immich.wait()
    for name, asset_id in ids.items():
        asset = immich.asset(asset_id)
        print(f"  {name}: {asset['width']}x{asset['height']}")
    encoded = immich.sql(f"select count(*) from asset_file where \"assetId\" = '{ids['transcoded.avi']}' "
                         "and type = 'encoded_video' and not \"isEdited\"")[0][0]
    check("the avi is transcoded, the others play as they are", encoded == "1")

    cases = [
        ("landscape.mp4", [ROTATE(90)]),
        ("portrait.mov", [MIRROR("horizontal"), ROTATE(90)]),
        ("transcoded.avi", [ROTATE(270)]),
        ("landscape.mp4", [MIRROR("vertical")]),
        ("portrait.mov", [ROTATE(180), MIRROR("horizontal")]),
    ]
    shown: dict[str, Image.Image] = {}
    for name, asset_id in ids.items():
        shown[name] = immich.frame(immich.get(f"/api/assets/{asset_id}/video/playback"), 1.0)
    reference_ids: dict[str, str] = {}
    for name, image in shown.items():
        path = Path(tempfile.gettempdir()) / f"shown-{Path(name).stem}.png"
        image.save(path)
        reference_ids[name] = immich.upload(path)
    immich.wait()

    for name, edits in cases:
        label = ", ".join(f"{e['action']} {next(iter(e['parameters'].values()))}" for e in edits)
        print(f"== {name}: {label}")
        asset_id = ids[name]
        before = immich.asset(asset_id)
        started = time.time()
        immich.edit(asset_id, edits)
        took = time.time() - started
        immich.edit(reference_ids[name], edits)
        expected = Image.open(io.BytesIO(immich.get(f"/api/assets/{reference_ids[name]}/original", edited="true"))).convert("RGB")

        playback = immich.get(f"/api/assets/{asset_id}/video/playback")
        played = immich.frame(playback, 1.0)
        diff = difference(played, expected)
        check("plays as the image edit shows the same frame", diff < 6, f"difference {diff:.1f}, applied in {took:.0f} s")
        original = (args.media / name).read_bytes()
        check("the stream is copied, not encoded again", abs(len(playback) - len(original)) < len(original) * 0.05
              or name.endswith(".avi"), f"{len(playback)} bytes, original {len(original)}")

        asset = immich.asset(asset_id)
        sideways = any(e["action"] == "rotate" and e["parameters"]["angle"] in (90, 270) for e in edits)
        expected_size = (before["height"], before["width"]) if sideways else (before["width"], before["height"])
        check("its size is as it shows", (asset["width"], asset["height"]) == expected_size,
              f"{asset['width']}x{asset['height']}")
        check("it is marked edited", asset["isEdited"] is True)
        thumb = Image.open(io.BytesIO(immich.get(f"/api/assets/{asset_id}/thumbnail", size="preview", edited="true")))
        check("its preview is turned too", (thumb.width > thumb.height) == (expected.width > expected.height),
              f"{thumb.width}x{thumb.height}")
        unedited = Image.open(io.BytesIO(immich.get(f"/api/assets/{asset_id}/thumbnail", size="preview", edited="false")))
        check("its own preview is kept", (unedited.width > unedited.height) == (shown[name].width > shown[name].height))
        downloaded = immich.get(f"/api/assets/{asset_id}/original", edited="true")
        check("downloads as edited", difference(immich.frame(downloaded, 1.0), expected) < 6)
        check("the original is untouched", immich.get(f"/api/assets/{asset_id}/original", edited="false") == original)

        # the edits are replaced as a whole: undo them for the next case on this video
        immich.edit(asset_id, [])
        immich.edit(reference_ids[name], [])

    print("== transcoding again keeps the edit")
    asset_id = ids["transcoded.avi"]
    immich.edit(asset_id, [ROTATE(90)])
    edited_path = immich.sql(f"select path from asset_file where \"assetId\" = '{asset_id}' and \"isEdited\" "
                             "and type = 'encoded_video'")[0][0]
    first = Path(edited_path).stat().st_mtime
    c.post("/api/assets/jobs", json={"name": "transcode-video", "assetIds": [asset_id]}).raise_for_status()
    time.sleep(2)
    immich.wait()
    second = Path(edited_path).stat().st_mtime if Path(edited_path).exists() else 0
    check("the edited stream is made again from the new one", second > first)
    played = immich.frame(immich.get(f"/api/assets/{asset_id}/video/playback"), 1.0)
    check("and still plays turned", played.height > played.width, f"{played.width}x{played.height}")

    print("== edits removed")
    immich.edit(asset_id, [])
    rows = immich.sql(f"select path from asset_file where \"assetId\" = '{asset_id}' and \"isEdited\"")
    check("its edited stream and thumbnails are removed", rows == [], str(rows))
    asset = immich.asset(asset_id)
    check("its size is back", (asset["width"], asset["height"]) == (1280, 720), f"{asset['width']}x{asset['height']}")
    played = immich.frame(immich.get(f"/api/assets/{asset_id}/video/playback"), 1.0)
    check("it plays as before", difference(played, shown["transcoded.avi"]) < 6)

    print("== refused")
    response = c.put(f"/api/assets/{ids['landscape.mp4']}/edits",
                     json={"edits": [{"action": "crop", "parameters": {"x": 0, "y": 0, "width": 100, "height": 100}}]})
    check("cropping a video", response.status_code == 400, response.json().get("message", ""))

    print("== real-time streaming (HLS)")
    config = c.get("/api/system-config").json()
    config["ffmpeg"]["realtime"]["enabled"] = True
    c.put("/api/system-config", json=config).raise_for_status()
    asset_id = ids["portrait.mov"]
    immich.edit(asset_id, [MIRROR("horizontal"), ROTATE(90)])
    immich.edit(reference_ids["portrait.mov"], [MIRROR("horizontal"), ROTATE(90)])
    expected = Image.open(io.BytesIO(immich.get(f"/api/assets/{reference_ids['portrait.mov']}/original", edited="true"))).convert("RGB")
    main_playlist = c.get(f"/api/assets/{asset_id}/video/stream/main.m3u8").text
    resolutions = [line.split("RESOLUTION=")[1].split(",")[0] for line in main_playlist.splitlines() if "RESOLUTION=" in line]
    landscape = all(int(r.split("x")[0]) > int(r.split("x")[1]) for r in resolutions)
    check("its variants are sized as it shows", bool(resolutions) and landscape, ", ".join(resolutions))
    variant = next(line for line in main_playlist.splitlines() if line.endswith("playlist.m3u8"))
    media = c.get(f"/api/assets/{asset_id}/video/stream/{variant}").text
    base = variant.rsplit("/", 1)[0]
    segments = [line for line in media.splitlines() if line and not line.startswith("#")]
    init = next(line.split('URI="')[1].split('"')[0] for line in media.splitlines() if "EXT-X-MAP" in line)
    data = immich.get(f"/api/assets/{asset_id}/video/stream/{base}/{init}") + immich.get(
        f"/api/assets/{asset_id}/video/stream/{base}/{segments[0]}")
    streamed = immich.frame(data, 1.0)
    diff = difference(streamed, expected)
    check("its stream shows as the image edit", diff < 10, f"difference {diff:.1f}, {streamed.width}x{streamed.height}")
    config["ffmpeg"]["realtime"]["enabled"] = False
    c.put("/api/system-config", json=config).raise_for_status()
    immich.edit(asset_id, [])

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
