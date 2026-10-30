"""OCR models compared for Chinese, Japanese and English: accuracy, speed and memory, the way the server calls them.

Each model runs in a machine learning service of its own (the installed release, its CoreML build, the models folder
of the main install, so downloads are shared), started afresh so that its memory is its own. Two test sets:

  real: photos of the main library with text, the terms in them checked by eye
  synthetic: text rendered on crops of those photos, in simplified and traditional Chinese, Japanese, English and
    mixed, from 22 to 110 pixels high in a 1440 pixel preview, in several fonts: the exact text is known

A term counts as read when it is found, exactly, in what the model read (NFKC, case and spaces aside): that is what a
search for it needs. The character error rate says how close the misses came.

Usage (with the machine-learning venv's python, which has httpx, Pillow and numpy):
  m1_ocr_eval.py run --out /tmp/ocr-eval/results.json [--models PP-OCRv5_mobile,PP-OCRv6_medium] [--resolutions 736,1440]
  m1_ocr_eval.py report /tmp/ocr-eval/results.json
"""

import argparse
import io
import json
import os
import random
import signal
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HOME = Path.home() / "Library/Application Support/Immich"
RELEASE = HOME / "current"
PORT = 3012
MODELS = ["PP-OCRv5_mobile", "PP-OCRv5_server", "PP-OCRv6_small", "PP-OCRv6_medium"]

# the photos of the main library with text, and the terms in them, checked by eye on their previews
REAL: dict[str, list[str]] = {
    "CAM00081.JPG": ["北吴路", "Beiwu Rd.", "都会路", "Duhui Rd.", "虹梅南路", "Hongmei Rd.(S)", "元江路"],
    "CAM00082.JPG": ["北吴路", "Beiwu Rd.", "都会路", "Duhui Rd.", "虹梅南路", "Hongmei Rd.(S)", "元江路"],
    "CAM00083.JPG": ["都会路", "Duhui Rd.", "虹梅南路", "元江路", "虹梅高架路"],
    "CAM00088.JPG": ["北吴路", "Beiwu Rd.", "都会路", "Duhui Rd.", "虹梅南路", "Hongmei Rd.(S)", "元江路"],
    "CAM00089.JPG": ["北吴路", "Beiwu Rd.", "都会路", "Duhui Rd.", "虹梅南路", "Hongmei Rd.(S)", "元江路"],
    "CAM00083.ARW": ["都会路", "Duhui Rd.", "虹梅南路", "元江路", "虹梅高架路"],
    "CAM00089.ARW": ["北吴路", "Beiwu Rd.", "都会路", "Duhui Rd.", "虹梅南路", "Hongmei Rd.(S)", "元江路"],
    "IMG_5606.HEIC": ["总里程", "48970km", "行驶里程", "行驶时间", "5:25h", "30.09.2026"],
    "IMG_5895.HEIC": ["TAMRON", "28-75mm", "F/2.8", "2.4GHz", "Wireless"],
    "IMG_5561.HEIC": ["收银台"],
    "IMG_5595.HEIC": ["收银台"],
}

TERMS: dict[str, list[str]] = {
    "zh-Hans": ["北京西站", "禁止停车", "营业时间 9:00-21:00", "上海市闵行区虹梅南路", "欢迎光临", "地铁2号线", "请勿吸烟",
                "停车场入口", "新鲜水果 每斤12元", "中国工商银行", "人民广场站", "小心地滑", "洗手间", "全场八折",
                "南京东路步行街", "儿童游乐区", "自助取票机", "免费无线网络"],
    "zh-Hant": ["臺北車站", "營業時間", "請勿吸菸", "歡迎光臨", "捷運淡水線", "售票處", "優惠價格", "香港中環", "緊急出口",
                "銅鑼灣", "臺灣銀行", "飲料專賣"],
    "ja": ["東京駅 丸の内口", "ラーメン一蘭", "営業中", "お会計はこちら", "きっぷうりば", "新宿三丁目", "立入禁止",
           "本日のおすすめ", "コンビニエンスストア", "渋谷駅前", "準備中", "東京タワー", "ご自由にお取りください", "大阪城公園"],
    "en": ["EXIT", "Opening Hours 9am - 9pm", "Platform 3", "Coffee & Bakery", "No Parking", "Welcome", "Main Street",
           "Fresh Fruit", "Emergency Exit", "Open 24 Hours"],
    "mixed": ["出口 Exit", "星巴克 STARBUCKS", "洗手间 Toilet", "駅 Station", "2号出口 Exit 2", "B1 停车场"],
}
FONTS: dict[str, list[tuple[str, int]]] = {
    "zh-Hans": [("/System/Library/Fonts/Hiragino Sans GB.ttc", 0), ("/System/Library/Fonts/STHeiti Medium.ttc", 1),
                ("/System/Library/Fonts/Supplemental/Songti.ttc", 6)],
    "zh-Hant": [("/System/Library/Fonts/Supplemental/Songti.ttc", 7), ("/System/Library/Fonts/STHeiti Light.ttc", 0),
                ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0)],
    "ja": [("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", 0), ("/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", 0),
           ("/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", 0), ("/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc", 0)],
    "en": [("/System/Library/Fonts/Helvetica.ttc", 0), ("/System/Library/Fonts/Times.ttc", 0),
           ("/System/Library/Fonts/Avenir Next.ttc", 7)],
    "mixed": [("/System/Library/Fonts/Hiragino Sans GB.ttc", 0), ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0)],
}
SIZES = [22, 32, 56, 110]


def normalize(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).lower().split())


def distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def score(terms: list[str], lines: list[str]) -> dict[str, Any]:
    """Whether each term was read exactly, and how far its closest reading was"""
    normalized = [normalize(line) for line in lines]
    joined = "".join(normalized)
    found, errors, characters, misses = 0, 0, 0, []
    for term in terms:
        target = normalize(term)
        characters += len(target)
        if target in joined or any(target in line for line in normalized):
            found += 1
            continue
        closest = min((distance(target, line) for line in normalized), default=len(target))
        errors += min(closest, len(target))
        misses.append(term)
    return {"terms": len(terms), "found": found, "errors": errors, "characters": characters, "misses": misses}


# --- test images ---------------------------------------------------------------------------------------------------


def previews(names: list[str]) -> dict[str, Path]:
    quoted = ",".join(f"'{n}'" for n in names)
    out = subprocess.run(
        ["immichctl", "psql", "-At", "-F", "\t", "-c",
         'select a."originalFileName", f.path from asset a join asset_file f on f."assetId" = a.id '
         f"and f.type = 'preview' and not f.\"isEdited\" where a.\"originalFileName\" in ({quoted}) "
         'and a."deletedAt" is null'],
        capture_output=True, text=True, check=True).stdout
    return {name: Path(path) for name, path in (line.split("\t") for line in out.splitlines() if line)}


HARD_SIZES = [12, 15, 18, 22]


def synthetic(folder: Path, backgrounds: list[Path], hard: bool = False) -> list[dict[str, Any]]:
    """Text in each language at each size, on crops of real photos, as signs and as text on the scene. Hard: small,
    of low contrast, and blurred, as text far off in a photo"""
    rng = random.Random(20261031 if hard else 20261030)
    sizes_of = HARD_SIZES if hard else SIZES
    folder.mkdir(parents=True, exist_ok=True)
    cases = []
    for language, terms in TERMS.items():
        terms = terms[:]
        rng.shuffle(terms)
        for index in range(0, len(terms), 3):
            group = terms[index:index + 3]
            background = Image.open(rng.choice(backgrounds)).convert("RGB")
            width, height = 1440, 1080
            scale = max(width / background.width, height / background.height)
            background = background.resize((int(background.width * scale) + 1, int(background.height * scale) + 1))
            left = rng.randint(0, background.width - width)
            top = rng.randint(0, background.height - height)
            image = background.crop((left, top, left + width, top + height)).filter(ImageFilter.GaussianBlur(1.5))
            draw = ImageDraw.Draw(image, "RGBA")
            sizes = rng.sample(sizes_of, len(group))
            rows = [80 + i * (height - 160) // len(group) for i in range(len(group))]
            for term, size, row in zip(group, sizes, rows):
                path, font_index = rng.choice(FONTS[language])
                font = ImageFont.truetype(path, size, index=font_index)
                x0, y0, x1, y1 = draw.textbbox((0, 0), term, font=font)
                x = rng.randint(40, max(41, width - (x1 - x0) - 40))
                y = row + rng.randint(0, max(1, (height - 160) // len(group) - (y1 - y0) - 20))
                if rng.random() < 0.6:
                    # a sign: a plate, dark text on light or light on dark
                    light = rng.random() < 0.5
                    pad = max(6, size // 4)
                    plate = (245, 245, 240, 235) if light else (rng.choice([20, 30, 0]), rng.choice([60, 90, 30]), 140, 230)
                    ink = (20, 20, 20) if light else (255, 255, 255)
                    if hard:
                        plate = (200, 200, 195, 200) if light else (70, 90, 120, 200)
                        ink = (95, 95, 95) if light else (190, 190, 190)
                    draw.rounded_rectangle((x - pad, y + y0 - pad, x + x1 - x0 + pad, y + y1 + pad), radius=pad, fill=plate)
                    draw.text((x - x0, y), term, font=font, fill=ink)
                else:
                    draw.text((x - x0, y), term, font=font, fill=(255, 255, 255), stroke_width=max(1, size // 18),
                              stroke_fill=(0, 0, 0))
            if rng.random() < 0.5:
                image = image.rotate(rng.uniform(-4, 4), resample=Image.Resampling.BICUBIC, fillcolor=(0, 0, 0))
            if hard:
                image = image.filter(ImageFilter.GaussianBlur(0.8))
            name = f"{'hard-' if hard else ''}{language}-{index // 3 + 1}.jpg"
            image.save(folder / name, quality=70 if hard else 82)
            cases.append({"name": name, "language": language, "path": str(folder / name), "terms": group,
                          "sizes": sizes, "set": "hard" if hard else "synthetic"})
    return cases


# --- the service -------------------------------------------------------------------------------------------------------


CPU_ONLY = (
    "import uvicorn, sys\n"
    "import immich_ml.sessions.ort as ort\n"
    "ort._providers_default = lambda: ['CPUExecutionProvider']\n"
    "uvicorn.run('immich_ml.main:app', host='127.0.0.1', port=int(sys.argv[1]), log_config=sys.argv[2])\n"
)


class Service:
    def __init__(self, cpu: bool = False) -> None:
        env = dict(os.environ)
        env.update({
            "PYTHONPATH": str(RELEASE / "ml"),
            "MACHINE_LEARNING_CACHE_FOLDER": str(HOME / "data/models"),
            "HF_HOME": str(HOME / "data/models/hf-cache"),
            "MACHINE_LEARNING_MODEL_TTL": "0",
            "IMMICH_LOG_LEVEL": "warning",
        })
        self.log = open(f"/tmp/ocr-eval/service-{time.time():.0f}.log", "w")
        log_config = str(RELEASE / "ml/immich_ml/log_conf.json")
        command = ([str(RELEASE / "ml/venv/bin/python"), "-c", CPU_ONLY, str(PORT), log_config] if cpu else
                   [str(RELEASE / "ml/venv/bin/python"), "-m", "uvicorn", "immich_ml.main:app", "--host", "127.0.0.1",
                    "--port", str(PORT), "--log-config", log_config])
        self.process = subprocess.Popen(
            command,
            cwd=RELEASE / "ml", env=env, stdout=self.log, stderr=subprocess.STDOUT)
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{PORT}", timeout=1800)
        self.peak = 0
        self._sampling = True
        threading.Thread(target=self._sample, daemon=True).start()
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                if self.client.get("/ping", timeout=2).status_code == 200:
                    return
            except httpx.HTTPError:
                time.sleep(0.5)
        raise RuntimeError("the service did not start")

    def rss(self) -> int:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(self.process.pid)], capture_output=True, text=True).stdout
        return int(out.strip() or 0) * 1024

    def footprint(self) -> int:
        out = subprocess.run(["footprint", "-p", str(self.process.pid)], capture_output=True, text=True).stdout
        for line in out.splitlines():
            if "phys_footprint:" in line:
                value, unit = line.split("phys_footprint:")[1].split()[:2]
                return int(float(value) * {"KB": 2**10, "MB": 2**20, "GB": 2**30}.get(unit, 1))
        return 0

    def _sample(self) -> None:
        while self._sampling and self.process.poll() is None:
            self.peak = max(self.peak, self.rss())
            time.sleep(0.2)

    def ocr(self, image: bytes, model: str, resolution: int) -> tuple[list[str], float]:
        entries = {"ocr": {"detection": {"modelName": model, "options": {"minScore": 0.5, "maxResolution": resolution}},
                           "recognition": {"modelName": model, "options": {"minScore": 0.8}}}}
        start = time.perf_counter()
        response = self.client.post("/predict", data={"entries": json.dumps(entries)}, files={"image": image})
        elapsed = time.perf_counter() - start
        response.raise_for_status()
        return list(response.json()["ocr"]["text"]), elapsed

    def stop(self) -> None:
        self._sampling = False
        self.process.send_signal(signal.SIGTERM)
        try:
            self.process.wait(30)
        except subprocess.TimeoutExpired:
            self.process.kill()
        self.log.close()


def jpeg(path: Path) -> bytes:
    """As the server sends it: the preview, a JPEG"""
    return path.read_bytes()


def build_images(folder: Path) -> list[dict[str, Any]]:
    real = previews(list(REAL))
    missing = set(REAL) - set(real)
    if missing:
        sys.exit(f"not in the main library: {sorted(missing)}")
    backgrounds = list(previews(["IMG_5566.HEIC", "IMG_5571.HEIC", "CAM00074.JPG", "CAM00076.JPG", "IMG_5603.HEIC",
                                 "IMG_5609.HEIC", "IMG_5599.HEIC", "CAM00085.JPG"]).values())
    cases = synthetic(folder / "synthetic", backgrounds) + synthetic(folder / "synthetic", backgrounds, hard=True)
    return [{"name": name, "set": "real", "language": "real", "path": str(path), "terms": REAL[name]}
            for name, path in real.items()] + cases


def textless() -> list[dict[str, Any]]:
    """Photos of the main library in which no OCR found any text: what a model reads there is noise, or text missed"""
    out = subprocess.run(
        ["immichctl", "psql", "-At", "-F", "\t", "-c",
         'select a."originalFileName", f.path from asset a join asset_file f on f."assetId" = a.id '
         "and f.type = 'preview' and not f.\"isEdited\" where a.\"deletedAt\" is null and a.type = 'IMAGE' "
         'and not exists (select 1 from asset_ocr o where o."assetId" = a.id) order by a."fileCreatedAt"'],
        capture_output=True, text=True, check=True).stdout
    return [{"name": name, "set": "textless", "language": "none", "path": path, "terms": []}
            for name, path in (line.split("\t") for line in out.splitlines() if line)]


def sweep(args: argparse.Namespace) -> None:
    """One run at low thresholds, keeping each line's scores; then each pair of thresholds is a filter of it"""
    folder = Path(args.out).parent
    images = build_images(folder) + textless()
    floor_det, floor_rec = 0.2, 0.3
    service = Service()
    lines: dict[str, list[tuple[str, float, float]]] = {}
    try:
        entries = {"ocr": {"detection": {"modelName": args.model,
                                         "options": {"minScore": floor_det, "maxResolution": args.resolution}},
                           "recognition": {"modelName": args.model, "options": {"minScore": floor_rec}}}}
        for image in images:
            response = service.client.post("/predict", data={"entries": json.dumps(entries)},
                                           files={"image": jpeg(Path(image["path"]))})
            response.raise_for_status()
            ocr = response.json()["ocr"]
            lines[image["name"]] = list(zip(ocr["text"], ocr["boxScore"], ocr["textScore"]))
    finally:
        service.stop()
    Path(args.out).write_text(json.dumps({"images": images, "lines": lines}, ensure_ascii=False, indent=1))

    sets = ["real", "synthetic", "hard"]
    print(f"{args.model}@{args.resolution}: terms read exactly, per set; lines read on {sum(1 for i in images if i['set'] == 'textless')}"
          " photos without text; lines matching no term in the sets with text")
    print(f"{'det':>4} {'rec':>4} " + " ".join(f"{s:>9}" for s in sets) + f" {'textless':>9} {'unmatched':>9}")
    for det in (0.3, 0.4, 0.5, 0.6):
        for rec in (0.5, 0.6, 0.7, 0.8, 0.9):
            cells, unmatched, noise = [], 0, 0
            for kind in sets:
                found = terms = 0
                for image in (i for i in images if i["set"] == kind):
                    kept = [text for text, box, score_ in lines[image["name"]] if box >= det and score_ >= rec]
                    result = score(image["terms"], kept)
                    found, terms = found + result["found"], terms + result["terms"]
                    targets = [normalize(t) for t in image["terms"]]
                    unmatched += sum(1 for text in kept if not any(normalize(text) in t or t in normalize(text)
                                                                   for t in targets))
                cells.append(f"{found:>4}/{terms:<4}")
            noise = sum(1 for i in images if i["set"] == "textless"
                        for _, box, score_ in lines[i["name"]] if box >= det and score_ >= rec)
            print(f"{det:4.1f} {rec:4.1f} " + " ".join(f"{c:>9}" for c in cells) + f" {noise:>9} {unmatched:>9}")


def run(args: argparse.Namespace) -> None:
    folder = Path(args.out).parent
    images = build_images(folder)
    results = json.loads(Path(args.out).read_text()) if Path(args.out).exists() else {}

    for model in args.models.split(","):
        for resolution in [int(r) for r in args.resolutions.split(",")]:
            key = f"{model}@{resolution}{'/cpu' if args.cpu else ''}"
            if key in results:
                print(f"== {key}: done before", flush=True)
                continue
            print(f"== {key}", flush=True)
            service = Service(cpu=args.cpu)
            idle = service.rss()
            try:
                start = time.perf_counter()
                try:
                    service.ocr(jpeg(Path(images[0]["path"])), model, resolution)
                except httpx.HTTPStatusError as error:
                    print(f"    failed: {error}; the service's log: {service.log.name}", flush=True)
                    continue
                first = time.perf_counter() - start
                print(f"    first request (download, CoreML compile, load): {first:.1f}s", flush=True)
                outputs, timings = {}, []
                for image in images:
                    data = jpeg(Path(image["path"]))
                    service.ocr(data, model, resolution)
                    runs = [service.ocr(data, model, resolution) for _ in range(2)]
                    lines = runs[0][0]
                    timings.append(statistics.median(t for _, t in runs))
                    outputs[image["name"]] = {"lines": lines, **score(image["terms"], lines)}
                loaded = service.rss()
                results[key] = {
                    "model": model, "resolution": resolution, "first": first, "idle": idle, "loaded": loaded,
                    "footprint": service.footprint(), "cpu": args.cpu,
                    "peak": service.peak, "median": statistics.median(timings),
                    "mean": statistics.mean(timings), "outputs": outputs,
                }
            finally:
                service.stop()
            Path(args.out).write_text(json.dumps({**results, "_images": images}, ensure_ascii=False, indent=1))
            if key in results:
                summarize(results, images, [key])
    Path(args.out).write_text(json.dumps({**results, "_images": images}, ensure_ascii=False, indent=1))


def summarize(results: dict[str, Any], images: list[dict[str, Any]], keys: list[str]) -> None:
    groups = ["real", "synthetic", "hard", "hard zh-Hans", "hard zh-Hant", "hard ja", "hard en", "hard mixed"]
    print(f"{'model':30} " + " ".join(f"{g:>13}" for g in groups) +
          f" {'hard by size 12/15/18/22':>25} {'median':>7} {'RSS':>7} {'footprint':>9}")

    def chosen(group: str, image: dict[str, Any]) -> bool:
        if " " in group:
            kind, language = group.split()
            return image.get("set") == kind and image["language"] == language
        return image.get("set") == group

    for key in keys:
        result = results[key]
        cells = []
        for group in groups:
            selected = [image for image in images if chosen(group, image) and image["name"] in result["outputs"]]
            found = sum(result["outputs"][i["name"]]["found"] for i in selected)
            terms = sum(result["outputs"][i["name"]]["terms"] for i in selected)
            errors = sum(result["outputs"][i["name"]]["errors"] for i in selected)
            characters = sum(result["outputs"][i["name"]]["characters"] for i in selected)
            cells.append(f"{found:3}/{terms:<3} {100 * errors / max(characters, 1):4.1f}%")
        by_size = []
        for size in HARD_SIZES:
            found = terms = 0
            for image in images:
                if image.get("set") != "hard" or image["name"] not in result["outputs"]:
                    continue
                misses = result["outputs"][image["name"]]["misses"]
                for term, term_size in zip(image["terms"], image["sizes"]):
                    if term_size == size:
                        terms += 1
                        found += term not in misses
            by_size.append(f"{100 * found / max(terms, 1):.0f}")
        print(f"{key:30} " + " ".join(f"{c:>13}" for c in cells) + f" {'/'.join(by_size):>25}"
              f" {result['median'] * 1000:5.0f}ms {result['loaded'] / 2**20:5.0f}MB"
              f" {result.get('footprint', 0) / 2**20:7.0f}MB", flush=True)


def report(args: argparse.Namespace) -> None:
    data = json.loads(Path(args.results).read_text())
    images = data.pop("_images")
    print("found/terms and character error rate of the misses' closest reading, per set")
    summarize(data, images, list(data))
    if args.misses:
        for key, result in data.items():
            print(f"\n== {key}: misses")
            for image in images:
                output = result["outputs"][image["name"]]
                if output["misses"]:
                    print(f"  {image['name']}: missed {output['misses']}; read {output['lines']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--out", default="/tmp/ocr-eval/results.json")
    run_parser.add_argument("--models", default=",".join(MODELS))
    run_parser.add_argument("--resolutions", default="736")
    run_parser.add_argument("--cpu", action="store_true", help="CPU only, not CoreML")
    report_parser = sub.add_parser("report")
    report_parser.add_argument("results")
    report_parser.add_argument("--misses", action="store_true")
    sweep_parser = sub.add_parser("sweep", help="the detection and recognition thresholds of one model")
    sweep_parser.add_argument("--out", default="/tmp/ocr-eval/sweep.json")
    sweep_parser.add_argument("--model", default="PP-OCRv6_medium")
    sweep_parser.add_argument("--resolution", type=int, default=1024)
    args = parser.parse_args()
    {"run": run, "report": report, "sweep": sweep}[args.command](args)


if __name__ == "__main__":
    main()
