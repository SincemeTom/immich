"""M2: video transcoding with VideoToolbox against Immich's software path, through the server, on one set of videos.

On a fresh test instance: signs up an admin, turns machine learning off, uploads the samples from m2-samples.sh, then
transcodes every video twice: with acceleration disabled, one at a time (Immich's defaults), and with VideoToolbox, two
at a time (what immichctl video-accel sets). Per run it times the queue and samples the Mac's CPU, less what it used
when idle just before; per video it reads which path the server took from its log, and compares the two outputs: size
as displayed, frame count, mean brightness and SSIM.

Usage (with the machine-learning venv's python, which has httpx):
  m2_videotoolbox.py --url http://127.0.0.1:2285 --log ~/Library/.../Immich-m2/logs/server.log
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

FFMPEG_DIR = Path(os.environ.get("M2_FFMPEG_DIR", Path.home() / "Library/Application Support/Immich/current/ffmpeg"))
FFMPEG, FFPROBE = str(FFMPEG_DIR / "ffmpeg"), str(FFMPEG_DIR / "ffprobe")
EMAIL, PASSWORD = "m2@immich.local", "m2-password"
# acceleration, and transcodes at once
RUNS = {"disabled": 1, "videotoolbox": 2}
# what VideoToolbox cannot decode on an M4, so the server retries with software decoding (it does decode H.264 10-bit
# and 4:4:4, VP9, AV1 and ProRes)
NO_HW_DECODE = {"derived-mjpeg.avi"}

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}")
    return ok


def login(client: httpx.Client) -> None:
    if not client.get("/api/server/config").json().get("isInitialized"):
        client.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "M2", "password": PASSWORD}).raise_for_status()
    response = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    response.raise_for_status()
    client.headers["Authorization"] = f"Bearer {response.json()['accessToken']}"


def configure(client: httpx.Client, concurrency: int = 1, **ffmpeg: Any) -> None:
    config = client.get("/api/system-config").json()
    config["machineLearning"]["enabled"] = False
    config["job"]["videoConversion"]["concurrency"] = concurrency
    config["ffmpeg"].update(ffmpeg)
    client.put("/api/system-config", json=config).raise_for_status()


def upload(client: httpx.Client, path: Path) -> str:
    now = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    with path.open("rb") as handle:
        response = client.post(
            "/api/assets",
            data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": path.name},
            files={"assetData": (path.name, handle, "application/octet-stream")},
            timeout=600,
        )
    response.raise_for_status()
    return str(response.json()["id"])


def wait_for_queues(client: httpx.Client, timeout: int) -> None:
    deadline, quiet = time.time() + timeout, 0
    while time.time() < deadline:
        queues = {queue["name"]: queue["statistics"] for queue in client.get("/api/queues").json()}
        busy = any(s["active"] or s["waiting"] or s["delayed"] for s in queues.values())
        quiet = 0 if busy else quiet + 1
        if quiet >= 3:
            return
        time.sleep(1)
    sys.exit("queues did not drain in time")


class CpuSampler:
    """The Mac's CPU busy share each second, from top: what every process together used, transcoding or not."""

    def __init__(self) -> None:
        self.samples: list[float] = []
        self.process = subprocess.Popen(["top", "-l", "0", "-s", "1", "-n", "0"], stdout=subprocess.PIPE, text=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.process.stdout
        for line in self.process.stdout:
            match = re.search(r"CPU usage: .*?([\d.]+)% idle", line)
            if match:
                self.samples.append(100 - float(match.group(1)))

    def stop(self) -> list[float]:
        self.process.terminate()
        # top's first sample covers the time since boot
        return self.samples[1:]

    def take(self) -> list[float]:
        """The samples so far, which then start over."""
        taken, self.samples = self.samples[1:], self.samples[:1]
        return taken


def probe(path: Path) -> dict[str, Any]:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
         "stream=codec_name,width,height,pix_fmt,nb_read_packets:stream_side_data=rotation", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    rotation = next((int(d["rotation"]) for d in stream.get("side_data_list", []) if "rotation" in d), 0)
    width, height = stream["width"], stream["height"]
    displayed = (height, width) if abs(rotation) == 90 else (width, height)
    return {"codec": stream["codec_name"], "displayed": displayed, "frames": int(stream["nb_read_packets"]),
            "pix_fmt": stream["pix_fmt"]}


def mean_luma(path: Path) -> float:
    out = subprocess.run(
        [FFMPEG, "-i", str(path), "-vf", r"select=not(mod(n\,5)),signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
         "-f", "null", "-"], capture_output=True, text=True,
    )
    values = [float(v) for v in re.findall(r"YAVG=([\d.]+)", out.stdout)]
    return sum(values) / len(values)


def ssim(a: Path, b: Path) -> float:
    out = subprocess.run(
        [FFMPEG, "-i", str(a), "-i", str(b), "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"], capture_output=True, text=True,
    )
    match = re.search(r"All:([\d.]+)", out.stderr)
    return float(match.group(1)) if match else 0.0


def paths_taken(log: str, asset_id: str, original: str) -> str:
    """The attempts the server made for one asset, in its own words. A retry's line names no asset, and two transcodes
    run at once; the failure before it does dump ffmpeg's output, whose last input line names the original file."""
    match = re.search(rf"Transcoding video {asset_id} (with [^\n]*|without hardware acceleration)", log)
    if not match:
        return "?"
    steps = [match.group(1)]
    for retry in re.finditer(r"Retrying with ([^\n]*)", log):
        failure = log.rfind("Error occurred during transcoding", 0, retry.start())
        source = log.rfind("Input #0", 0, failure)
        if source >= 0 and original in log[source : log.find("\n", source)]:
            steps.append(retry.group(1))
    return " -> ".join(steps)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2285")
    parser.add_argument("--log", type=Path, required=True, help="the test instance's server.log")
    parser.add_argument("--samples", type=Path, default=Path("/tmp/immich-m2/samples"))
    parser.add_argument("--out", type=Path, default=Path("/tmp/immich-m2/out"))
    parser.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args()

    client = httpx.Client(base_url=args.url, timeout=60)
    print("== setup")
    login(client)
    configure(client, transcode="disabled")
    samples = sorted(p for p in args.samples.iterdir() if p.is_file())
    assets = {path.name: upload(client, path) for path in samples}
    originals = {name: Path(client.get(f"/api/assets/{asset_id}").json()["originalPath"]).name
                 for name, asset_id in assets.items()}
    wait_for_queues(client, args.timeout)
    check("uploads", len(assets) == len(samples), f"{len(assets)} videos, {sum(p.stat().st_size for p in samples) / 1e9:.2f} GB")

    paths: dict[str, dict[str, str]] = {}
    cores = os.cpu_count() or 1
    for accel, concurrency in RUNS.items():
        print(f"== transcoding everything, acceleration {accel}, {concurrency} at a time")
        configure(client, concurrency, accel=accel, transcode="all", accelDecode=True)
        log_start = args.log.stat().st_size
        sampler = CpuSampler()
        time.sleep(11)
        idle = sampler.take()
        baseline = sum(idle) / max(len(idle), 1)
        started = time.time()
        client.put("/api/jobs/videoConversion", json={"command": "start", "force": True}).raise_for_status()
        wait_for_queues(client, args.timeout)
        elapsed = time.time() - started
        busy = sampler.stop()
        # summed rather than averaged, over the run's samples (the quiet polls at the end count as idle)
        cpu_seconds = max(0.0, sum(b - baseline for b in busy)) / 100 * cores
        print(f"    {elapsed:.0f} s, the Mac's CPU {sum(busy) / max(len(busy), 1):.0f}% busy on average "
              f"({baseline:.0f}% before), {cpu_seconds:.0f} CPU s above that ({cores} cores)")
        with args.log.open("rb") as handle:
            handle.seek(log_start)
            log = re.sub(r"\x1b\[[0-9;]*m", "", handle.read().decode(errors="replace"))
        paths[accel] = {name: paths_taken(log, asset_id, originals[name]) for name, asset_id in assets.items()}
        results.append((f"run {accel}", True, f"{elapsed:.0f} s, {cpu_seconds:.0f} CPU s above idle"))
        folder = args.out / accel
        folder.mkdir(parents=True, exist_ok=True)
        for name, asset_id in assets.items():
            with client.stream("GET", f"/api/assets/{asset_id}/video/playback", timeout=600) as response:
                response.raise_for_status()
                with (folder / f"{name}.mp4").open("wb") as handle:
                    for chunk in response.iter_bytes():
                        handle.write(chunk)

    print("== per video: VideoToolbox against software")
    for name in assets:
        sw, vt = args.out / "disabled" / f"{name}.mp4", args.out / "videotoolbox" / f"{name}.mp4"
        source, a, b = probe(args.samples / name), probe(sw), probe(vt)
        luma_sw, luma_vt = mean_luma(sw), mean_luma(vt)
        score = ssim(sw, vt)
        taken = paths["videotoolbox"][name]
        problems = []
        if "VIDEOTOOLBOX" not in taken.split(" -> ")[0]:
            problems.append("not started with VideoToolbox")
        if "acceleration disabled" in taken:
            problems.append("fell back to software encoding")
        if (name in NO_HW_DECODE) != ("software decoding" in taken):
            problems.append("expected " + ("a" if name in NO_HW_DECODE else "no") + " fallback to software decoding")
        if b["codec"] != "h264":
            problems.append(f"codec {b['codec']}")
        if b["displayed"] != a["displayed"]:
            problems.append(f"displayed {b['displayed']} vs {a['displayed']}")
        if abs(b["frames"] - a["frames"]) > 1:
            problems.append(f"{b['frames']} frames vs {a['frames']}")
        if abs(luma_vt - luma_sw) > 2:
            problems.append(f"brightness {luma_vt:.1f} vs {luma_sw:.1f}")
        if score < 0.9:
            problems.append(f"SSIM {score:.3f}")
        detail = (f"{source['codec']} {source['pix_fmt']} {source['displayed'][0]}x{source['displayed'][1]} -> "
                  f"{b['displayed'][0]}x{b['displayed'][1]}, {b['frames']} frames, brightness {luma_vt:.1f} "
                  f"(software {luma_sw:.1f}), SSIM {score:.3f}, size {vt.stat().st_size / 1e6:.1f} MB "
                  f"(software {sw.stat().st_size / 1e6:.1f} MB); {taken}")
        check(name, not problems, "; ".join(problems) + (" | " if problems else "") + detail)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
