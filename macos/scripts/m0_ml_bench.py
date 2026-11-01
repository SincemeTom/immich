"""M0: benchmarks the machine learning service the way the server calls it, and compares the outputs of two runs.

Usage (with the machine-learning venv's python):
  m0_ml_bench.py run --url http://127.0.0.1:3003 --label coreml --out coreml.json
  m0_ml_bench.py compare cpu.json coreml.json
  m0_ml_bench.py load --url http://127.0.0.1:3003 --label coreml --pid <service pid> --concurrency 4
"""

import argparse
import os
import json
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
import numpy as np

REPO = Path(__file__).resolve().parents[2]
ASSETS = REPO / "e2e" / "test-assets"
IMAGES = {
    "portrait": ASSETS / "metadata/faces/portrait.jpg",
    "landscape": ASSETS / "albums/nature/el_torcal_rocks.jpg",
    "falcon": ASSETS / "albums/nature/prairie_falcon.jpg",
    "shop_text": ASSETS / "albums/text/japanese-shop.jpg",
    "book_text": ASSETS / "albums/text/book-beside-flowers.jpg",
}
TEXTS = ["a bird of prey in the sky", "rocks in the mountains", "a person smiling", "海边的日落"]

# the defaults the server sends, from server/src/dtos/config.dto.ts, or the models named in the environment
CLIP = os.environ.get("M0_CLIP", "ViT-B-32__openai")
FACE = os.environ.get("M0_FACE", "buffalo_l")
OCR = os.environ.get("M0_OCR", "PP-OCRv5_mobile")
OCR_RESOLUTION = int(os.environ.get("M0_OCR_RESOLUTION", "736"))
TASKS: dict[str, dict[str, Any]] = {
    "clip_visual": {"clip": {"visual": {"modelName": CLIP}}},
    "clip_textual": {"clip": {"textual": {"modelName": CLIP}}},
    "faces": {
        "facial-recognition": {
            "detection": {"modelName": FACE, "options": {"minScore": 0.7}},
            "recognition": {"modelName": FACE},
        }
    },
    "ocr": {
        "ocr": {
            "detection": {"modelName": OCR, "options": {"minScore": 0.5, "maxResolution": OCR_RESOLUTION}},
            "recognition": {"modelName": OCR, "options": {"minScore": 0.8}},
        }
    },
}


def predict(client: httpx.Client, task: str, payload: str | Path) -> tuple[float, dict[str, Any]]:
    data = {"entries": json.dumps(TASKS[task])}
    files = None
    if isinstance(payload, Path):
        files = {"image": payload.read_bytes()}
    else:
        data["text"] = payload
    start = time.perf_counter()
    response = client.post("/predict", data=data, files=files)
    elapsed = (time.perf_counter() - start) * 1000
    response.raise_for_status()
    return elapsed, response.json()


def inputs_for(task: str) -> dict[str, str | Path]:
    if task == "clip_textual":
        return {text: text for text in TEXTS}
    if task == "ocr":
        return {name: IMAGES[name] for name in ("shop_text", "book_text")}
    return dict(IMAGES)


def wait_for(client: httpx.Client, url: str, seconds: int) -> None:
    deadline = time.time() + seconds
    while True:
        try:
            client.get("/ping").raise_for_status()
            return
        except httpx.HTTPError:
            if time.time() > deadline:
                sys.exit(f"service at {url} did not come up within {seconds}s")
            time.sleep(1)


def run(args: argparse.Namespace) -> None:
    client = httpx.Client(base_url=args.url, timeout=900)
    wait_for(client, args.url, args.wait)

    report: dict[str, Any] = {"label": args.label, "tasks": {}}
    for task in TASKS:
        cases = inputs_for(task)
        # the first request loads the model, and for a compiling provider, compiles it
        first_ms, _ = predict(client, task, next(iter(cases.values())))
        warm: list[float] = []
        outputs: dict[str, Any] = {}
        for name, payload in cases.items():
            for _ in range(args.runs):
                elapsed, body = predict(client, task, payload)
                warm.append(elapsed)
            outputs[name] = body
        report["tasks"][task] = {
            "first_ms": round(first_ms, 1),
            "warm_median_ms": round(statistics.median(warm), 1),
            "warm_mean_ms": round(statistics.fmean(warm), 1),
            "requests": len(warm),
            "outputs": outputs,
        }
        print(f"{args.label:>8} {task:<13} first {first_ms:9.1f} ms   warm median {statistics.median(warm):8.1f} ms")

    Path(args.out).write_text(json.dumps(report))


def _cpu_seconds(text: str) -> float:
    """Parses ps's cumulative CPU time, [[dd-]hh:]mm:ss.cc."""
    days, _, clock = text.rpartition("-")
    seconds = 0.0
    for part in clock.split(":"):
        seconds = seconds * 60 + float(part)
    return seconds + (int(days) * 86400 if days else 0)


def tree_cpu_seconds(root: int) -> float:
    """CPU time used by a process and every live descendant, which is where the service does its work."""
    rows = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,time="], capture_output=True, text=True, check=True).stdout
    table = [line.split() for line in rows.splitlines()]
    children: dict[int, list[int]] = {}
    times: dict[int, float] = {}
    for pid, ppid, cpu in table:
        children.setdefault(int(ppid), []).append(int(pid))
        times[int(pid)] = _cpu_seconds(cpu)
    total, stack = 0.0, [root]
    while stack:
        pid = stack.pop()
        total += times.get(pid, 0.0)
        stack.extend(children.get(pid, []))
    return total


def load(args: argparse.Namespace) -> None:
    """Throughput under concurrent requests, as the server sends them, and the CPU the service spends per image."""
    client = httpx.Client(base_url=args.url, timeout=900, limits=httpx.Limits(max_connections=args.concurrency))
    wait_for(client, args.url, args.wait)
    for task in ("clip_visual", "faces", "ocr"):
        payloads = list(inputs_for(task).values())
        predict(client, task, payloads[0])  # load the model outside the measurement
        jobs = [payloads[i % len(payloads)] for i in range(args.requests)]
        cpu_before, start = tree_cpu_seconds(args.pid), time.perf_counter()
        with ThreadPoolExecutor(args.concurrency) as pool:
            list(pool.map(lambda payload: predict(client, task, payload), jobs))
        wall = time.perf_counter() - start
        cpu = tree_cpu_seconds(args.pid) - cpu_before
        print(
            f"{args.label:>8} {task:<12} x{args.concurrency}  {args.requests / wall:7.1f} img/s"
            f"   service CPU {cpu / args.requests * 1000:7.1f} ms/img   ({cpu / wall:4.1f} cores busy)"
        )


def _vector(value: Any) -> np.ndarray:
    return np.asarray(json.loads(value) if isinstance(value, str) else value, dtype=np.float32)


def _cosine(a: Any, b: Any) -> float:
    x, y = _vector(a), _vector(b)
    return float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y)))


def compare(args: argparse.Namespace) -> None:
    base, other = (json.loads(Path(p).read_text()) for p in (args.base, args.other))
    print(f"{'task':<13} {base['label']:>10} {other['label']:>10} {'speedup':>8}   agreement")
    for task, a in base["tasks"].items():
        b = other["tasks"][task]
        speedup = a["warm_median_ms"] / b["warm_median_ms"]
        notes = []
        for name, out_a in a["outputs"].items():
            out_b = b["outputs"][name]
            if task.startswith("clip"):
                notes.append(f"{name}: cos {_cosine(out_a['clip'], out_b['clip']):.4f}")
            elif task == "faces":
                faces_a, faces_b = out_a["facial-recognition"], out_b["facial-recognition"]
                if len(faces_a) != len(faces_b):
                    notes.append(f"{name}: {len(faces_a)} vs {len(faces_b)} faces")
                elif faces_a:
                    worst = min(_cosine(fa["embedding"], fb["embedding"]) for fa, fb in zip(faces_a, faces_b))
                    notes.append(f"{name}: {len(faces_a)} faces, min cos {worst:.4f}")
                else:
                    notes.append(f"{name}: 0 faces")
            elif task == "ocr":
                text_a, text_b = out_a["ocr"]["text"], out_b["ocr"]["text"]
                same = len(set(text_a) & set(text_b))
                notes.append(f"{name}: {same}/{max(len(text_a), len(text_b))} lines equal")
        print(f"{task:<13} {a['warm_median_ms']:>8.1f}ms {b['warm_median_ms']:>8.1f}ms {speedup:>7.2f}x   {'; '.join(notes)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--url", default="http://127.0.0.1:3003")
    run_parser.add_argument("--label", required=True)
    run_parser.add_argument("--out", required=True)
    run_parser.add_argument("--runs", type=int, default=5, help="warm requests per input")
    run_parser.add_argument("--wait", type=int, default=120, help="seconds to wait for the service")
    run_parser.set_defaults(func=run)
    compare_parser = commands.add_parser("compare")
    compare_parser.add_argument("base")
    compare_parser.add_argument("other")
    compare_parser.set_defaults(func=compare)
    load_parser = commands.add_parser("load")
    load_parser.add_argument("--url", default="http://127.0.0.1:3003")
    load_parser.add_argument("--label", required=True)
    load_parser.add_argument("--pid", type=int, required=True, help="the service's top process")
    load_parser.add_argument("--concurrency", type=int, default=4)
    load_parser.add_argument("--requests", type=int, default=200)
    load_parser.add_argument("--wait", type=int, default=120)
    load_parser.set_defaults(func=load)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
