"""Rotating and mirroring a live photo, end to end, on a fresh test instance, with a real iPhone live photo (a HEIC and
its HEVC motion): the photo and its motion turn together, the motion as the image edit turns its own frame, the motion
stream copied (still HEVC, tagged hvc1 for Safari), cropping refused, and the edits removed with both.

Usage (with the machine-learning venv's python, which has httpx and Pillow):
  m1_live_photo_rotation.py --url http://127.0.0.1:2291 --home ~/Library/Application\\ Support/Immich-p8 \\
      --photo /tmp/live/media/IMG_5895.HEIC --motion /tmp/live/media/IMG_5895.MOV
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

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import m1_video_rotation as video_e2e  # noqa: E402
from m1_video_rotation import MIRROR, ROTATE, Instance, check, difference, results  # noqa: E402

video_e2e.EMAIL, video_e2e.PASSWORD = "p8@immich.local", "p8-password"


def probe(immich: Instance, data: bytes) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=".mp4") as source:
        source.write(data)
        source.flush()
        out = subprocess.run([immich.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=codec_name,codec_tag_string,width,height", "-of", "json", source.name],
                             capture_output=True, check=True).stdout
    return json.loads(out)["streams"][0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2291")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--photo", type=Path, required=True)
    parser.add_argument("--motion", type=Path, required=True)
    args = parser.parse_args()

    immich = Instance(args.url, args.home)
    immich.login()
    c = immich.client

    print("== upload, as the iPhone app does: the motion, then the photo linked to it")
    motion_id = immich.upload(args.motion)
    with args.photo.open("rb") as handle:
        response = c.post("/api/assets", data={
            "fileCreatedAt": "2026-10-01T10:00:00Z", "fileModifiedAt": "2026-10-01T10:00:00Z",
            "filename": args.photo.name, "livePhotoVideoId": motion_id,
        }, files={"assetData": (args.photo.name, handle, "application/octet-stream")})
    response.raise_for_status()
    photo_id = response.json()["id"]
    # the queues may be empty a moment before the upload's jobs are queued: wait for its preview
    for _ in range(120):
        immich.wait()
        if c.get(f"/api/assets/{photo_id}/thumbnail", params={"size": "preview"}).status_code == 200:
            break
        time.sleep(1)
    photo, motion = immich.asset(photo_id), immich.asset(motion_id)
    check("a live photo", photo["livePhotoVideoId"] == motion_id and motion["visibility"] == "hidden",
          f"photo {photo['width']}x{photo['height']}")
    preview = Image.open(io.BytesIO(immich.get(f"/api/assets/{photo_id}/thumbnail", size="preview")))
    check("its HEIC is decoded, upright", preview.height > preview.width, f"preview {preview.width}x{preview.height}")
    played = immich.get(f"/api/assets/{motion_id}/video/playback")
    shown = immich.frame(played, 1.0)
    check("its motion plays upright", shown.height > shown.width, f"{shown.width}x{shown.height}")

    reference_path = Path(tempfile.gettempdir()) / "live-motion-frame.png"
    shown.save(reference_path)
    reference_id = immich.upload(reference_path)
    immich.wait()

    for edits in [[ROTATE(90)], [MIRROR("horizontal"), ROTATE(270)], [ROTATE(180), MIRROR("vertical")]]:
        label = ", ".join(f"{e['action']} {next(iter(e['parameters'].values()))}" for e in edits)
        print(f"== {label}")
        started = time.time()
        immich.edit(photo_id, edits)
        took = time.time() - started
        immich.edit(reference_id, edits)
        expected = Image.open(io.BytesIO(immich.get(f"/api/assets/{reference_id}/original", edited="true"))).convert("RGB")

        # the moment the photo is ready, its motion is too
        motion_edits = [{"action": e["action"], "parameters": e["parameters"]}
                        for e in c.get(f"/api/assets/{motion_id}/edits").json()["edits"]]
        check("the motion takes the photo's edits", motion_edits == edits, f"in {took:.0f} s")
        played = immich.get(f"/api/assets/{motion_id}/video/playback")
        frame = immich.frame(played, 1.0)
        diff = difference(frame, expected)
        check("the motion plays as the image edit turns its frame", diff < 6, f"difference {diff:.1f}")
        stream = probe(immich, played)
        check("its stream is copied: HEVC still, tagged for Safari",
              stream["codec_name"] == "hevc" and stream["codec_tag_string"] == "hvc1",
              f"{stream['codec_name']} {stream['codec_tag_string']}, {len(played)} bytes")
        still = Image.open(io.BytesIO(immich.get(f"/api/assets/{photo_id}/thumbnail", size="preview", edited="true")))
        check("the photo turns the same way", (still.width > still.height) == (frame.width > frame.height),
              f"photo {still.width}x{still.height}, motion {frame.width}x{frame.height}")
        photo = immich.asset(photo_id)
        check("its size follows", (photo["width"] > photo["height"]) == (frame.width > frame.height),
              f"{photo['width']}x{photo['height']}")

    print("== refused")
    response = c.put(f"/api/assets/{photo_id}/edits",
                     json={"edits": [{"action": "crop", "parameters": {"x": 0, "y": 0, "width": 100, "height": 100}}]})
    check("cropping a live photo", response.status_code == 400, response.json().get("message", ""))

    print("== edits removed")
    immich.edit(photo_id, [])
    check("the motion's edits go with them", c.get(f"/api/assets/{motion_id}/edits").json()["edits"] == [])
    rows = immich.sql(f"select path from asset_file where \"assetId\" in ('{photo_id}', '{motion_id}') and \"isEdited\"")
    check("and every edited file", rows == [], str(rows))
    frame = immich.frame(immich.get(f"/api/assets/{motion_id}/video/playback"), 1.0)
    check("the motion plays as before", difference(frame, shown) < 6)
    check("the originals are untouched",
          immich.get(f"/api/assets/{photo_id}/original", edited="false") == args.photo.read_bytes()
          and immich.get(f"/api/assets/{motion_id}/original", edited="false") == args.motion.read_bytes())

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
