"""M1: how well a CLIP model finds photos from Chinese and English queries, and how fast it runs, measured against the
machine learning service the way the server uses it.

The gallery is every image in e2e/test-assets, sent as the 1440px JPEG previews the server would send. Each query
names what is in one or a few of them; a query is found at k when one of its photos ranks in the top k of the 47.

Usage (with the machine-learning venv's python):
  m1_clip_eval.py run --url http://127.0.0.1:3010 --model XLM-Roberta-Large-ViT-H-14__frozen_laion5b_s13b_b90k \
    --label xlm-coreml --out xlm-coreml.json
  m1_clip_eval.py compare a.json b.json
"""

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import numpy as np

REPO = Path(__file__).resolve().parents[2]
ASSETS = REPO / "e2e" / "test-assets"
PREVIEWS = Path("/tmp/immich-m1/previews")
SUFFIXES = {".jpg", ".jpeg", ".heic", ".png", ".webp", ".avif", ".jxl", ".cr2", ".nef", ".arw", ".raf", ".rw2", ".dng"}

# (Chinese, English, photos that answer it), written from looking at each photo
QUERIES: list[tuple[str, str, list[str]]] = [
    ("粉色的花", "a pink flower", ["albums/nature/cyclamen_persicum.jpg"]),
    ("开黄花的仙人掌", "a cactus with yellow flowers", ["albums/nature/notocactus_minimus.jpg"]),
    ("紫色的花", "purple flowers", ["albums/nature/orychophragmus_violaceus.jpg"]),
    ("淡蓝色的小花", "small light blue flowers", ["albums/nature/polemonium_reptans.jpg"]),
    (
        "嶙峋的石灰岩",
        "weathered limestone rock formations",
        ["albums/nature/el_torcal_rocks.jpg", "formats/jpeg/el_torcal_rocks.jpeg", "formats/jpg/el_torcal_rocks.jpg"],
    ),
    ("猛禽", "a bird of prey", ["albums/nature/prairie_falcon.jpg"]),
    (
        "森林",
        "a forest",
        [
            "albums/nature/silver_fir.jpg",
            "albums/nature/wood_anemones.jpg",
            "formats/raw/Sony/ILCE-7M2/14bit-uncompressed-(3_2).arw",
        ],
    ),
    ("打开的书和干花", "an open book with dried flowers", ["albums/text/book-beside-flowers.jpg"]),
    ("酒吧里的啤酒", "beer at a bar", ["albums/text/craft-beer.jpg"]),
    ("笔记本和便利贴", "a notebook with sticky notes", ["albums/text/handwritten-notes.jpg"]),
    ("夜晚的日本小店", "a small Japanese shop at night", ["albums/text/japanese-shop.jpg"]),
    ("插着旗帜的城堡", "a castle with a flag", ["formats/avif/10bit-HDR-P3-nclx.avif"]),
    ("结冰的河岸", "a frozen riverbank", ["formats/avif/8bit-sRGB.avif"]),
    ("服务器机柜和网线", "a server rack with network cables", ["formats/heic/IMG_2682.heic"]),
    ("草地上的鹅", "geese on the grass", ["formats/motionphoto/pixel-6-pro.jpg"]),
    ("一杯冰咖啡", "a glass of iced coffee", ["formats/motionphoto/pixel-8a.jpg"]),
    ("数据图表", "a data chart", ["formats/png/density_plot.png"]),
    ("海边五颜六色的房子", "colorful houses by the water", ["formats/raw/Canon/PowerShot_G12.CR2"]),
    ("公园里的喷泉", "a fountain in a park", ["formats/raw/Nikon/D700/philadelphia.nef"]),
    (
        "山谷里的湖",
        "a lake in a mountain valley",
        ["formats/raw/Nikon/D80/glarus.nef", "formats/raw/Canon/EOS_70D.CR2"],
    ),
    ("塔楼", "a tower", ["formats/raw/Sony/ILCE-6300/12bit-compressed-(3_2).arw"]),
    ("雪山", "snowy mountains", ["formats/webp/denali.webp", "formats/raw/Canon/EOS_70D.CR2"]),
    ("在椅子上睡觉的猫", "a cat sleeping on a chair", ["metadata/gps-position/empty_gps.jpg"]),
    ("沙漠里的沙丘", "sand dunes in the desert", ["metadata/rating/mongolels.jpg"]),
    (
        "黑白老照片",
        "an old black and white photo",
        ["metadata/faces/portrait.jpg", "metadata/faces/portrait-orientation-6.jpg"],
    ),
    ("玻璃花瓶", "a glass vase", ["formats/jxl/8bit-sRGB.jxl", "formats/raw/Panasonic/DMC-GH4/4_3.rw2"]),
    ("蓝天白云", "blue sky with clouds", ["formats/raw/Canon/EOS_30D.CR2"]),
    ("绿色的山谷", "a green valley", ["formats/jxl/16bit-HDR-P3-nclx.jxl", "albums/nature/tanners_ridge.jpg"]),
    ("荒漠中的方山", "a mesa in the desert", ["metadata/gps-position/thompson-springs.jpg"]),
    ("微笑的女人", "a smiling woman", ["albums/text/craft-beer.jpg"]),
]


def gallery() -> list[str]:
    return sorted(
        str(p.relative_to(ASSETS))
        for folder in ("albums", "formats", "metadata")
        for p in (ASSETS / folder).rglob("*")
        if p.is_file() and p.suffix.lower() in SUFFIXES
    )


def preview(name: str) -> Path:
    """The 1440px JPEG the server would make, as its thumbnail job sends previews, not originals, for encoding."""
    out = PREVIEWS / (name.replace("/", "_") + ".jpeg")
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["/opt/homebrew/bin/vips", "thumbnail", str(ASSETS / name), f"{out}[Q=80]", "1440", "--size", "down"],
            check=True,
            capture_output=True,
        )
    return out


def encode(client: httpx.Client, model: str, payload: str | Path) -> tuple[float, np.ndarray]:
    kind = "visual" if isinstance(payload, Path) else "textual"
    data = {"entries": json.dumps({"clip": {kind: {"modelName": model}}})}
    files = {"image": payload.read_bytes()} if isinstance(payload, Path) else None
    if isinstance(payload, str):
        data["text"] = payload
    start = time.perf_counter()
    response = client.post("/predict", data=data, files=files)
    elapsed = (time.perf_counter() - start) * 1000
    response.raise_for_status()
    vector = np.asarray(json.loads(response.json()["clip"]), dtype=np.float32)
    return elapsed, vector / np.linalg.norm(vector)


def run(args: argparse.Namespace) -> None:
    client = httpx.Client(base_url=args.url, timeout=7200)
    names = gallery()
    images = [preview(name) for name in names]

    # the first request of each kind downloads the model if needed, and compiles it for a compiling provider
    first_visual, _ = encode(client, args.model, images[0])
    first_textual, _ = encode(client, args.model, "warm up")
    print(f"{args.label}: first visual {first_visual / 1000:.1f}s, first textual {first_textual / 1000:.1f}s")

    visual_ms, vectors = [], []
    for image in images:
        elapsed, vector = encode(client, args.model, image)
        visual_ms.append(elapsed)
        vectors.append(vector)
    gallery_matrix = np.stack(vectors)

    textual_ms: list[float] = []
    results: dict[str, list[dict[str, Any]]] = {"zh": [], "en": []}
    for zh, en, answers in QUERIES:
        for language, text in (("zh", zh), ("en", en)):
            elapsed, query = encode(client, args.model, text)
            textual_ms.append(elapsed)
            order = np.argsort(-(gallery_matrix @ query))
            ranked = [names[i] for i in order]
            rank = min(ranked.index(answer) for answer in answers) + 1
            results[language].append({"query": text, "rank": rank, "top3": ranked[:3]})

    report = {
        "label": args.label,
        "model": args.model,
        "first_visual_s": round(first_visual / 1000, 1),
        "first_textual_s": round(first_textual / 1000, 1),
        "visual_ms": round(statistics.median(visual_ms), 1),
        "textual_ms": round(statistics.median(textual_ms), 1),
        "results": results,
        "embeddings": {name: vector.tolist() for name, vector in zip(names, vectors)},
    }
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False))
    summary(report)


def recall(rows: list[dict[str, Any]], k: int) -> float:
    return 100 * sum(row["rank"] <= k for row in rows) / len(rows)


def summary(report: dict[str, Any]) -> None:
    print(f"{report['label']}: visual {report['visual_ms']} ms, textual {report['textual_ms']} ms (median, warm)")
    for language in ("zh", "en"):
        rows = report["results"][language]
        print(
            f"  {language}: recall@1 {recall(rows, 1):5.1f}%  @3 {recall(rows, 3):5.1f}%  @5 {recall(rows, 5):5.1f}%"
            f"  median rank {statistics.median(row['rank'] for row in rows)}"
        )


def compare(args: argparse.Namespace) -> None:
    reports = [json.loads(Path(path).read_text()) for path in args.reports]
    labels = [report["label"] for report in reports]
    print(f"{'':28}" + "".join(f"{label:>22}" for label in labels))
    for key, title in (
        ("first_visual_s", "first visual (s)"),
        ("first_textual_s", "first textual (s)"),
        ("visual_ms", "visual (ms, warm)"),
        ("textual_ms", "textual (ms, warm)"),
    ):
        print(f"{title:28}" + "".join(f"{report[key]:>22}" for report in reports))
    for language in ("zh", "en"):
        for k in (1, 3, 5):
            row = [f"{recall(report['results'][language], k):.1f}%" for report in reports]
            print(f"{language} recall@{k:<20}" + "".join(f"{value:>22}" for value in row))
    print("\nper query, rank of the first right photo (of 47):")
    print(f"{'':34}" + "".join(f"{label:>16}" for label in labels))
    for language in ("zh", "en"):
        for i, row in enumerate(reports[0]["results"][language]):
            ranks = [report["results"][language][i]["rank"] for report in reports]
            print(f"  {row['query'][:30]:32}" + "".join(f"{rank:>16}" for rank in ranks))
    if len(reports) == 2 and reports[0]["model"] == reports[1]["model"]:
        a, b = (report["embeddings"] for report in reports)
        cosines = [float(np.dot(a[name], b[name])) for name in a]
        print(
            f"\nsame model, image embeddings agree: min cosine {min(cosines):.4f}, mean {statistics.fmean(cosines):.4f}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--url", required=True)
    run_parser.add_argument("--model", required=True)
    run_parser.add_argument("--label", required=True)
    run_parser.add_argument("--out", required=True)
    run_parser.set_defaults(func=run)
    compare_parser = commands.add_parser("compare")
    compare_parser.add_argument("reports", nargs="+")
    compare_parser.set_defaults(func=compare)
    args = parser.parse_args()
    if args.func is run and len(gallery()) != 47:
        sys.exit(f"expected the 47 images of e2e/test-assets, found {len(gallery())}")
    args.func(args)


if __name__ == "__main__":
    main()
