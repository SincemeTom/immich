"""M0: end-to-end check of a native deployment through the public API, the way a user exercises it.

Signs up an admin on a fresh instance, points machine learning at the native service, uploads every image in
e2e/test-assets/formats plus the synthetic clips from m0-ffmpeg-bench.sh, waits for the queues to drain, then checks
thumbnails, metadata, faces, OCR, smart search, video transcoding and a database backup.

Usage (with the machine-learning venv's python, which has httpx):
  m0_e2e.py --url http://127.0.0.1:2283 --ml-url http://127.0.0.1:3003
"""

from __future__ import annotations

import argparse
import gzip
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

REPO = Path(__file__).resolve().parents[2]
FFPROBE = os.environ.get("M0_FFPROBE", str(Path.home() / "Library/Caches/immich-m0/ffmpeg/ffprobe"))
FORMATS = REPO / "e2e/test-assets/formats"
EXTRA = [
    REPO / "e2e/test-assets/metadata/faces/portrait.jpg",
    REPO / "e2e/test-assets/albums/text/japanese-shop.jpg",
    REPO / "e2e/test-assets/albums/nature/prairie_falcon.jpg",
    REPO / "e2e/test-assets/albums/nature/notocactus_minimus.jpg",
]
VIDEOS = Path("/tmp/immich-m0/ffmpeg/samples")
# a photo taken on Jiangchuan Road, Minhang, Shanghai: reverse geocoding names its place in Chinese
# (macos/native/geodata.sh), the township, the region and the country
GPS_PHOTO = Path("/tmp/immich-m0/minhang-gps.jpg")
GPS_POINT = (31.0195, 121.4045)
# a screenshot as an iPhone 16 saves one: a PNG of the screen's size, of no camera; content analysis tags it
SCREENSHOT = Path("/tmp/immich-m0/IMG_9001.PNG")
# a video of someone saying this (macOS's voice): on macOS 26 searching by text finds it; before, it must not
SPEECH_VIDEO = Path("/tmp/immich-m0/speech-birthday.mp4")
SPEECH_TEXT = "今天是宝宝的生日，大家一起唱生日快乐歌"
SPEECH_QUERY = "生日快乐"


def macos_major() -> int:
    version = subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True).stdout.strip()
    return int(version.split(".")[0] or 0)


def speech_video() -> Path | None:
    """The video, made with `say` and the release's ffmpeg; None where either is missing"""
    ffmpeg = Path(FFPROBE).with_name("ffmpeg")
    if not ffmpeg.exists():
        return None
    SPEECH_VIDEO.parent.mkdir(parents=True, exist_ok=True)
    audio = SPEECH_VIDEO.with_suffix(".aiff")
    # a Chinese voice that is on this Mac: the others are listed, but say nothing (a few ms of silence) until
    # downloaded; Tingting comes with macOS
    listed = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    voices = sorted((line.split("  ")[0].split(" (")[0].strip() for line in listed.splitlines() if "zh_CN" in line),
                    key=lambda voice: voice != "Tingting")
    for voice in voices:
        subprocess.run(["say", "-v", voice, "-o", str(audio), SPEECH_TEXT], check=False)
        if audio.exists() and audio.stat().st_size > 20_000:
            break
    else:
        audio.unlink(missing_ok=True)
        return None
    subprocess.run([str(ffmpeg), "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=steelblue:s=640x360:r=30",
                    "-i", str(audio), "-shortest", "-c:v", "h264_videotoolbox", "-b:v", "1M", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", str(SPEECH_VIDEO)], check=True)
    audio.unlink()
    return SPEECH_VIDEO
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


def gps_photo() -> Path:
    from PIL import Image

    def dms(value: float) -> tuple[float, float, float]:
        minutes, seconds = divmod(abs(value) * 3600, 60)
        degrees, minutes = divmod(minutes, 60)
        return (degrees, minutes, round(seconds, 2))

    GPS_PHOTO.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (640, 480), (90, 140, 200))
    exif = image.getexif()
    exif[0x010F], exif[0x0110] = "Apple", "iPhone 16"  # Make, Model
    gps = exif.get_ifd(0x8825)
    gps.update({1: "N", 2: dms(GPS_POINT[0]), 3: "E", 4: dms(GPS_POINT[1])})
    image.save(GPS_PHOTO, exif=exif, quality=90)
    return GPS_PHOTO


def screenshot() -> Path:
    from PIL import Image, ImageDraw

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1179, 2556), (242, 242, 247))
    draw = ImageDraw.Draw(image)
    for row in range(12):
        top = 300 + row * 180
        draw.rectangle((60, top, 1119, top + 140), fill=(255, 255, 255))
        draw.rectangle((90, top + 40, 600, top + 70), fill=(60, 60, 67))
    image.save(SCREENSHOT)
    return SCREENSHOT


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
    images.append(gps_photo())
    images.append(screenshot())
    videos = sorted(VIDEOS.glob("*")) if VIDEOS.exists() else []
    spoken = speech_video()
    extra_videos = [spoken] if spoken else []
    uploaded: dict[str, str] = {}
    for path in images + videos + extra_videos:
        body = upload(client, path)
        uploaded[str(path.relative_to(REPO) if path.is_relative_to(REPO) else path.name)] = body["id"]
    check("uploads accepted", len(uploaded) == len(images) + len(videos) + len(extra_videos), f"{len(uploaded)} files")
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
    # searching by text, which also looks in what is said in videos (content analysis on macOS 26)
    word = next((t for t in texts if t and len(t) >= 2), None)
    if word:
        found = client.post("/api/search/metadata", json={"ocr": word, "size": 10}).json()["assets"]["items"]
        check(f"search by text '{word}' finds japanese-shop.jpg", any(hit["id"] == shop for hit in found),
              ", ".join(hit["originalFileName"] for hit in found[:3]))

    exif = client.get(f"/api/assets/{uploaded[GPS_PHOTO.name]}").json().get("exifInfo") or {}
    place = f"{exif.get('city')} / {exif.get('state')} / {exif.get('country')}"
    check("place in Chinese for a photo taken in Minhang, Shanghai",
          "闵行区" in (exif.get("city") or "") and exif.get("state") == "上海市" and exif.get("country") == "中国", place)

    # content analysis (Apple Vision): a server that has it, on a Mac whose release carries immich-vision
    if "contentAnalysis" in queues:
        def tags(name: str) -> list[str]:
            asset = client.get(f"/api/assets/{uploaded[name]}").json()
            return sorted(tag["value"] for tag in asset.get("tags") or [])

        cactus = tags("e2e/test-assets/albums/nature/notocactus_minimus.jpg")
        check("content analysis tags notocactus_minimus.jpg 自动/植物/仙人掌", "自动/植物/仙人掌" in cactus, ", ".join(cactus))
        shot = tags(SCREENSHOT.name)
        visibility = client.get(f"/api/assets/{uploaded[SCREENSHOT.name]}").json().get("visibility")
        check("content analysis tags a screenshot 自动/截图, and leaves it in the timeline (archiving is off)",
              "自动/截图" in shot and visibility == "timeline", f"{', '.join(shot)}; {visibility}")
        portrait = tags("e2e/test-assets/metadata/faces/portrait.jpg")
        check("content analysis does not take a photo for a screenshot", "自动/截图" not in portrait, ", ".join(portrait))

        # speech in videos: on macOS 26 only; before, off, so that the video is not found
        if spoken:
            found = client.post("/api/search/metadata", json={"ocr": SPEECH_QUERY, "size": 10}).json()["assets"]["items"]
            hit = any(item["id"] == uploaded[spoken.name] for item in found)
            if macos_major() >= 26:
                check(f"macOS 26: search by text '{SPEECH_QUERY}' finds the video saying it", hit,
                      ", ".join(item["originalFileName"] for item in found[:3]))
            else:
                check(f"macOS {macos_major()}: speech recognition off, '{SPEECH_QUERY}' does not find the video",
                      not hit, ", ".join(item["originalFileName"] for item in found[:3]))

    model = client.get("/api/system-config").json()["machineLearning"]["clip"]["modelName"]
    queries = [("a bird of prey", "albums/nature/prairie_falcon.jpg")]
    # the native install's default model understands Chinese; Immich's own default (ViT-B-32__openai) does not
    if model.startswith(("XLM-", "nllb-")) or "SigLIP2" in model:
        queries += [("猛禽", "albums/nature/prairie_falcon.jpg"), ("夜晚的日本小店", "albums/text/japanese-shop.jpg")]
    for query, expected in queries:
        hits = client.post("/api/search/smart", json={"query": query, "size": 5}).json()["assets"]["items"]
        top = [hit["originalFileName"] for hit in hits]
        wanted = uploaded[f"e2e/test-assets/{expected}"]
        check(
            f"smart search '{query}' ranks {Path(expected).name} first ({model})",
            bool(hits) and hits[0]["id"] == wanted,
            ", ".join(top[:3]),
        )

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
    # queue counters are pruned, so the backup is judged by the file it should have written, and by what is in it:
    # a backup that exists is not one that restores (an empty file once passed here)
    after = client.get("/api/admin/database-backups").json()["backups"]
    created = [b for b in after if b["filename"] not in before]
    if not created:
        check("backup written", False, "no new backup file")
    else:
        name = created[0]["filename"]
        body = client.get(f"/api/admin/database-backups/{name}").content
        try:
            dump = gzip.decompress(body).decode()
        except (OSError, EOFError, UnicodeDecodeError) as error:
            check("backup written", False, f"{name} ({len(body)} bytes) is not a readable gzip: {error}")
        else:
            tables = [table for table in ("asset", "smart_search", "asset_face") if f"COPY public.{table} " in dump]
            check(
                "backup written",
                "PostgreSQL database dump complete" in dump and len(tables) == 3,
                f"{name}: {len(body)} bytes, {len(dump)} bytes of SQL, data for {', '.join(tables) or 'no tables'}",
            )

    passed = sum(ok for _, ok, _ in results)
    print(f"\nResult: {passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
