"""M4 research: what Apple's Vision framework would add to Immich (macos/verification/m4-vision-research.md), measured
on the photos the earlier evaluations used, through macos/vision/probe.swift.

  ocr        Apple's text recognition against PP-OCRv6 on m1_ocr_eval.py's sets (real, synthetic, hard; photos without
             text for what it reads that is not there)
  tags       the classifier as tags: each of m1_clip_eval.py's queries searched as the label a user would type
  utility    "is utility" (screenshots, receipts, documents): screenshots and photographed documents made here, against
             the gallery and the main library's photos
  quality    the aesthetics score against degraded copies (blur, dark, noise); face capture quality
  faces      face detection against the 45 faces labelled in m1_face_eval.py
  speed      each request's time on 1440px previews, as Vision chooses the hardware and on the CPU alone; memory
  library    on any Mac (the test machine, on macOS 26 for documents and lens smudge): a sample of an install's
             photos, as an HTML contact sheet to check by eye; it stays on that Mac

Usage (with the machine-learning venv's python, which has Pillow and httpx):
  m4_vision_eval.py all --out /tmp/vision/results.json [--ppocr /tmp/vision/ppocr.json]
  m4_vision_eval.py library --sample 2000 --out ~/Desktop/vision-report

The library report needs only this file and the probe beside it (a notarized build of macos/vision/probe.swift), and
the release's Python: "$HOME/Library/Application Support/Immich/current/ml/python/bin/python3" m4_vision_eval.py library
"""

import argparse
import html
import json
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

sys.path.insert(0, str(Path(__file__).parent))
try:  # the evaluations' photos and scoring; the library report, run on its own elsewhere, needs neither
    import m1_clip_eval
    import m1_ocr_eval
except ImportError:
    pass

REPO = Path(__file__).resolve().parents[2]
WORK = Path("/tmp/vision")
# a probe beside this script (as copied to another Mac), or one built from the checkout
PROBE = Path(__file__).with_name("probe") if Path(__file__).with_name("probe").exists() else WORK / "probe"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# languages, and the smallest text height read, as a fraction of the image's (Vision's default: 1/32)
OCR_CONFIGS: dict[str, tuple[list[str] | None, float | None]] = {
    "apple zh,ja,en": (["zh-Hans", "zh-Hant", "ja-JP", "en-US"], None),
    "apple auto": (None, None),
    "apple auto, text 1/150": (None, 1 / 150),
    "apple zh,ja,en, text 1/150": (["zh-Hans", "zh-Hant", "ja-JP", "en-US"], 1 / 150),
}

# each query of m1_clip_eval.py as the tag a user would search for, chosen from the classifier's labels before running it
QUERY_LABELS = {
    "a pink flower": "flower", "a cactus with yellow flowers": "cactus", "purple flowers": "flower",
    "small light blue flowers": "flower", "a bird of prey": "bird", "an open book with dried flowers": "book",
    "beer at a bar": "beer", "a notebook with sticky notes": "document", "a small Japanese shop at night": "storefront",
    "a castle with a flag": "castle", "a frozen riverbank": "snow", "a server rack with network cables": "computer",
    "geese on the grass": "bird", "a glass of iced coffee": "coffee", "a data chart": "diagram",
    "colorful houses by the water": "house_single", "a fountain in a park": "fountain", "a tower": "tower",
    "snowy mountains": "mountain", "a cat sleeping on a chair": "cat", "sand dunes in the desert": "sand_dune",
    "a glass vase": "vase", "blue sky with clouds": "cloudy", "a green valley": "hill", "a mesa in the desert": "canyon",
    "a smiling woman": "people", "weathered limestone rock formations": "rocks", "a forest": "forest",
    "a lake in a mountain valley": "lake",
    # "an old black and white photo": no label says black and white, which only CLIP finds
}


class Probe:
    def __init__(self) -> None:
        if not PROBE.exists():
            build_probe()
        self.process = subprocess.Popen([str(PROBE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def run(self, path: Path | str, tasks: list[str], languages: list[str] | None = None, cpu: bool = False,
            minimum_text_height: float | None = None) -> dict:
        job: dict[str, Any] = {"path": str(path), "tasks": tasks, "cpu": cpu}
        if languages is not None:
            job["languages"] = languages
        if minimum_text_height is not None:
            job["minimumTextHeight"] = minimum_text_height
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(json.dumps(job) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def footprint(self) -> int:
        out = subprocess.run(["footprint", "-p", str(self.process.pid)], capture_output=True, text=True).stdout
        for line in out.splitlines():
            if "phys_footprint:" in line:
                value, unit = line.split("phys_footprint:")[1].split()[:2]
                return int(float(value) * {"KB": 2**10, "MB": 2**20, "GB": 2**30}.get(unit, 1))
        return 0

    def stop(self) -> None:
        assert self.process.stdin
        self.process.stdin.close()
        self.process.wait(timeout=30)


def build_probe() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    subprocess.run(["swiftc", "-O", "-parse-as-library", "-o", str(PROBE), str(REPO / "macos/vision/probe.swift")],
                   check=True)


def library_previews(limit: int | None = None) -> dict[str, Path]:
    """The previews of an install's photos, as the server sends them to machine learning"""
    query = ('select a."originalFileName", f.path from asset a join asset_file f on f."assetId" = a.id '
             "and f.type = 'preview' and not f.\"isEdited\" where a.\"deletedAt\" is null and a.type = 'IMAGE' "
             'order by a."fileCreatedAt"')
    out = subprocess.run(["immichctl", "psql", "-At", "-F", "\t", "-c", query], capture_output=True, text=True,
                         check=True).stdout
    rows = [line.split("\t") for line in out.splitlines() if line]
    if limit is not None and len(rows) > limit:
        rows = random.Random(20261101).sample(rows, limit)
    return {f"{name}#{index}": Path(path) for index, (name, path) in enumerate(rows) if Path(path).exists()}


def gallery() -> dict[str, Path]:
    return {name: m1_clip_eval.preview(name) for name in m1_clip_eval.gallery()}


# --- OCR -----------------------------------------------------------------------------------------------------------


def ocr(args: argparse.Namespace, results: dict[str, Any]) -> None:
    folder = WORK / "ocr"
    images = m1_ocr_eval.build_images(folder)
    textless = m1_ocr_eval.textless()
    probe = Probe()
    table: dict[str, Any] = {}
    try:
        for key, (languages, height) in OCR_CONFIGS.items():
            outputs, timings, noise = {}, [], 0
            probe.run(images[0]["path"], ["ocr"], languages, minimum_text_height=height)
            for image in images:
                result = probe.run(image["path"], ["ocr"], languages, minimum_text_height=height)
                lines = [line["text"] for line in result["ocr"]] if isinstance(result["ocr"], list) else []
                timings.append(result["ms"]["ocr"] / 1000)
                outputs[image["name"]] = {"lines": lines, **m1_ocr_eval.score(image["terms"], lines)}
            for image in textless:
                result = probe.run(image["path"], ["ocr"], languages, minimum_text_height=height)
                noise += len(result["ocr"]) if isinstance(result["ocr"], list) else 0
            table[key] = {"outputs": outputs, "median": statistics.median(timings), "loaded": probe.footprint(),
                          "footprint": probe.footprint(), "textless_lines": noise, "textless": len(textless)}
    finally:
        probe.stop()
    if args.ppocr and Path(args.ppocr).exists():
        ppocr = json.loads(Path(args.ppocr).read_text())
        for key, value in ppocr.items():
            if not key.startswith("_"):
                table[key] = value
    print("== OCR: found/terms and the character error rate of the misses, per set; median time per photo")
    m1_ocr_eval.summarize(table, images, list(table))
    for key, value in table.items():
        if "textless_lines" in value:
            print(f"  {key}: {value['textless_lines']} lines read on {value['textless']} photos without text")
    results["ocr"] = {key: {k: v for k, v in value.items() if k != "outputs"} | {"misses": {
        name: out["misses"] for name, out in value["outputs"].items() if out["misses"]}} for key, value in table.items()}


# --- tags ----------------------------------------------------------------------------------------------------------


def tags(args: argparse.Namespace, results: dict[str, Any]) -> None:
    photos = gallery()
    probe = Probe()
    try:
        labels = {name: probe.run(path, ["classify"])["classify"] for name, path in photos.items()}
    finally:
        probe.stop()
    known = set(subprocess.run([str(PROBE), "labels"], capture_output=True, text=True, check=True).stdout.split())
    rows = []
    for zh, en, expected in m1_clip_eval.QUERIES:
        label = QUERY_LABELS.get(en)
        if label is None or label not in known:
            rows.append({"query": en, "label": None, "rank": None, "tagged": 0})
            continue
        scored = sorted(((next((c["confidence"] for c in labels[name] if c["label"] == label), 0.0), name)
                         for name in photos), reverse=True)
        ranked = [name for confidence, name in scored if confidence > 0]
        rank = min((ranked.index(e) + 1 for e in expected if e in ranked), default=None)
        rows.append({"query": en, "label": label, "rank": rank, "tagged": len(ranked)})
    found = {k: sum(1 for r in rows if r["rank"] is not None and r["rank"] <= k) / len(rows) for k in (1, 3, 5)}
    untagged = [r["query"] for r in rows if r["rank"] is None]
    print(f"== tags: {len(rows)} queries as the label, over {len(photos)} photos")
    print(f"  recall@1 {found[1]:.0%}  @3 {found[3]:.0%}  @5 {found[5]:.0%}; the photo not tagged at all: {len(untagged)}")
    for r in rows:
        print(f"    {r['query']:<36} {r['label'] or '(no such label)':<15} rank {r['rank'] or '-':>3}  "
              f"({r['tagged']} photos carry it)")
    per_photo = [sum(1 for c in found_labels if c["confidence"] >= 0.3) for found_labels in labels.values()]
    print(f"  labels at confidence >= 0.3 per photo: median {statistics.median(per_photo)}, max {max(per_photo)}")
    results["tags"] = {"recall": found, "rows": rows, "labels": {n: [(c["label"], round(c["confidence"], 2))
                                                                     for c in v[:10]] for n, v in labels.items()}}


# --- utility -------------------------------------------------------------------------------------------------------

PHONE = (393, 852, 3)  # an iPhone 15's points and scale: 1179 x 2556 pixels
DESKTOP = (1440, 900, 2)

SCREENS = {
    "chat": """<div class=bar>微信 (3)</div><div class=list>{bubbles}</div><div class=input>发送消息…</div>""",
    "settings": """<h1>设置</h1>{rows}""",
    "order": """<h1>我的订单</h1>{orders}""",
    "article": """<h1>城市更新计划发布 十二个片区年内开工</h1><p class=meta>2026-10-31 08:30 来源：本地新闻</p>{paragraphs}""",
    "home": """<div class=grid>{icons}</div>""",
    "sheet": """<table>{table}</table>""",
    "code": """<pre>{code}</pre>""",
    "map": """<svg width=100% height=100%>{shapes}</svg><div class=search>搜索地点、公交、地铁</div>""",
}


def screen_html(kind: str, dark: bool, rng: random.Random) -> str:
    words = ["好的", "明天见", "收到，谢谢", "我已经到了", "照片发你了", "下午三点开会", "晚饭吃什么？", "路上堵车", "OK 👍", "在吗"]
    fill = {
        "bubbles": "".join(f"<div class='b {'me' if rng.random() < .5 else ''}'>{rng.choice(words)}</div>" for _ in range(14)),
        "rows": "".join(f"<div class=row>{t}<span>›</span></div>" for t in
                        ["无线局域网", "蓝牙", "蜂窝网络", "个人热点", "通知", "声音与触感", "专注模式", "屏幕使用时间",
                         "通用", "控制中心", "显示与亮度", "主屏幕", "辅助功能", "墙纸", "隐私与安全性", "电池"]),
        "orders": "".join(f"<div class=order><b>订单 {rng.randint(10**9, 10**10)}</b><p>{item} × {rng.randint(1, 3)}</p>"
                          f"<p class=price>¥{rng.randint(9, 999)}.{rng.randint(0, 99):02d}</p><p>已签收</p></div>"
                          for item in ["无线耳机", "咖啡豆 500g", "数据线", "保温杯", "笔记本", "洗衣液"]),
        "paragraphs": "".join(f"<p>{'记者从市住建局获悉，今年将推进老旧小区改造和道路提升工程，涉及多个街道。' * rng.randint(2, 4)}</p>"
                              for _ in range(8)),
        "icons": "".join(f"<div class=icon><i style='background:hsl({rng.randint(0, 360)},70%,55%)'></i>{t}</div>" for t in
                         ["照片", "相机", "地图", "天气", "时钟", "日历", "备忘录", "提醒事项", "邮件", "信息", "电话", "音乐",
                          "设置", "App Store", "钱包", "健康", "计算器", "文件", "微信", "支付宝"]),
        "table": "<tr>" + "".join(f"<th>{c}</th>" for c in "ABCDEFGH") + "</tr>" + "".join(
            "<tr>" + "".join(f"<td>{rng.randint(0, 9999)}</td>" for _ in range(8)) + "</tr>" for _ in range(30)),
        "code": html.escape("\n".join(f"def handler_{i}(request):\n    data = request.json()\n    return {{'ok': True, "
                                      f"'id': {rng.randint(1, 999)}}}\n" for i in range(12))),
        "shapes": "".join(f"<rect x={rng.randint(0, 380)} y={rng.randint(0, 840)} width={rng.randint(20, 160)} "
                          f"height={rng.randint(10, 120)} fill='hsl({rng.choice([90, 120, 200, 40])},40%,80%)'/>"
                          for _ in range(40)) + "".join(
            f"<text x={rng.randint(10, 300)} y={rng.randint(20, 830)} font-size=13>{t}</text>"
            for t in ["人民广场", "南京东路", "外滩", "静安寺", "陆家嘴", "世纪大道", "徐家汇", "中山公园"]),
    }
    background, ink = ("#111", "#eee") if dark else ("#f5f5f7", "#111")
    style = (f"body{{margin:0;font:16px -apple-system,'PingFang SC';background:{background};color:{ink}}}"
             "h1{font-size:28px;padding:16px}p{padding:0 16px;line-height:1.6}.meta{color:#888}"
             ".bar{padding:14px;text-align:center;font-weight:600;border-bottom:1px solid #8884}"
             ".b{margin:10px 14px;padding:10px 14px;border-radius:10px;background:#8883;max-width:70%}"
             ".me{margin-left:auto;background:#95ec69;color:#111}.input{position:fixed;bottom:0;left:0;right:0;"
             "padding:16px;background:#8882}.row{display:flex;justify-content:space-between;padding:14px 18px;"
             "border-bottom:1px solid #8883}.order{margin:12px;padding:12px;border-radius:12px;background:#8882}"
             ".price{color:#e33;font-weight:600}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px;"
             "padding:60px 20px}.icon{text-align:center;font-size:12px}.icon i{display:block;width:60px;height:60px;"
             "margin:0 auto 6px;border-radius:14px}table{border-collapse:collapse;font-size:13px}td,th{border:1px "
             "solid #8885;padding:4px 10px}pre{font:13px Menlo;padding:16px}.search{position:fixed;top:50px;left:16px;"
             "right:16px;padding:12px;border-radius:12px;background:#fff;color:#888;box-shadow:0 2px 8px #0003}")
    return f"<!doctype html><meta charset=utf-8><style>{style}</style>" + SCREENS[kind].format(**fill)


def screenshot(page: str, size: tuple[int, int, int], out: Path) -> None:
    source = out.with_suffix(".html")
    source.write_text(page)
    width, height, scale = size
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--screenshot={out}",
                    f"--window-size={width},{height}", f"--force-device-scale-factor={scale}",
                    source.as_uri()], capture_output=True, check=True, timeout=60)


def photographed(document: Image.Image, background: Image.Image, rng: random.Random) -> Image.Image:
    """The document as a phone would photograph it on a table: smaller, turned, in perspective, shaded, softer"""
    canvas = background.convert("RGB").resize((1440, 1080))
    width, height = document.size
    scale = rng.uniform(0.55, 0.8) * min(1440 / width, 1080 / height)
    page = document.convert("RGB").resize((int(width * scale), int(height * scale)))
    w, h = page.size
    jitter = [rng.randint(-int(w * .08), int(w * .08)) for _ in range(8)]
    corners = [(jitter[0], jitter[1]), (w + jitter[2], jitter[3]), (w + jitter[4], h + jitter[5]), (jitter[6], h + jitter[7])]
    left, top = rng.randint(40, max(41, 1440 - w - 40)), rng.randint(20, max(21, 1080 - h - 20))
    mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(mask).polygon([(left + x, top + y) for x, y in corners], fill=255)
    coefficients = perspective([(left + x, top + y) for x, y in corners], [(0, 0), (w, 0), (w, h), (0, h)])
    warped = page.transform(canvas.size, Image.Transform.PERSPECTIVE, coefficients, Image.Resampling.BICUBIC)
    shade = ImageEnhance.Brightness(warped).enhance(rng.uniform(0.75, 0.95))
    canvas.paste(shade, (0, 0), mask.filter(ImageFilter.GaussianBlur(1)))
    return canvas.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 1.2)))


def perspective(source: list[tuple[int, int]], target: list[tuple[int, int]]) -> list[float]:
    """PIL's coefficients mapping the output's corners (source) back to the input's (target)"""
    import numpy as np

    rows = []
    for (x, y), (u, v) in zip(source, target):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    solution = np.linalg.solve(np.array(rows, dtype=float), np.array([c for p in target for c in p], dtype=float))
    return solution.tolist()


DOCUMENTS = {
    "receipt": """<div style='width:360px;padding:24px;font:15px Menlo;background:#fff;color:#222'><h3 style='text-align:center'>
               全家便利店 FamilyMart</h3><p>门店：虹梅南路店<br>2026-10-30 19:42</p>{items}<hr><p><b>合计 ¥{total}</b><br>
               支付宝 ¥{total}</p><p style='text-align:center'>谢谢惠顾 欢迎再来</p><img src='{qr}' width=140
               style='display:block;margin:auto'></div>""",
    "letter": """<div style='width:794px;padding:70px;font:17px Songti SC;background:#fff;color:#111;line-height:1.9'>
              <h2 style='text-align:center'>关于开展年度消防安全检查的通知</h2>{paragraphs}<p style='text-align:right'>
              物业服务中心<br>2026年10月28日</p></div>""",
    "poster": """<div style='width:600px;padding:40px;background:#123;color:#fff;font:22px PingFang SC;text-align:center'>
              <h1>秋季音乐节</h1><p>11月15日 19:30 · 世纪公园</p><img src='{qr}' width=260><p>扫码购票</p></div>""",
    "card": """<div style='width:540px;height:300px;padding:30px;background:#fafafa;color:#222;font:18px PingFang SC'>
            <h2>王小明</h2><p>产品经理 · 某某科技有限公司</p><p>电话 138 0000 0000<br>邮箱 wang@example.com<br>
            上海市徐汇区漕溪北路 88 号</p></div>""",
    "ticket": """<div style='width:640px;padding:26px;background:#e8f1ff;color:#123;font:18px PingFang SC;border-radius:12px'>
              <h2>G1234 上海虹桥 → 北京南</h2><p>2026年11月02日 08:00开 · 05车 12F号 · 二等座</p><p>¥553.0 · 网上购票</p>
              <img src='{qr}' width=120></div>""",
}


def make_utility(folder: Path) -> list[dict[str, Any]]:
    """Screenshots, phone and desktop, light and dark; and documents, photographed on photos of the gallery"""
    folder.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261101)
    qr = folder / "qr.png"
    subprocess.run([str(PROBE), "qr", "https://example.com/ticket/20261115", str(qr)], check=True)
    cases = []
    for kind in SCREENS:
        size = DESKTOP if kind in ("sheet", "code") else PHONE
        for dark in (False, True):
            out = folder / f"screen-{kind}-{'dark' if dark else 'light'}.png"
            if not out.exists():
                screenshot(screen_html(kind, dark, rng), size, out)
            cases.append({"name": out.name, "path": out, "kind": "screenshot"})
            # as a photo app keeps a screenshot shared through a chat: a JPEG, no metadata
            jpeg = out.with_suffix(".jpg")
            Image.open(out).convert("RGB").save(jpeg, quality=85)
            cases.append({"name": jpeg.name, "path": jpeg, "kind": "screenshot as JPEG"})
    backgrounds = [m1_clip_eval.preview(n) for n in ("albums/nature/el_torcal_rocks.jpg", "formats/heic/IMG_2682.heic",
                                                     "metadata/rating/mongolels.jpg", "albums/text/book-beside-flowers.jpg")]
    for kind, template in DOCUMENTS.items():
        fill = {"items": "".join(f"<p>{n}<span style='float:right'>{p}</span></p>" for n, p in
                                 [("矿泉水", "2.00"), ("饭团", "6.50"), ("关东煮", "12.00"), ("酸奶", "8.90")]),
                "total": "29.40", "qr": qr.as_uri(),
                "paragraphs": "".join("<p>各位业主：为切实做好冬季消防安全工作，物业将于下周对各楼栋消防设施进行检查，请予以配合。</p>"
                                      for _ in range(6))}
        flat = folder / f"doc-{kind}.png"
        if not flat.exists():
            screenshot("<!doctype html><meta charset=utf-8><body style='margin:0;background:#fff'>" + template.format(**fill),
                       (900, 1200, 1), flat)
        page = Image.open(flat).convert("RGB")
        page = page.crop(page.getbbox() or (0, 0, *page.size))
        for index, background in enumerate(backgrounds[:2]):
            out = folder / f"photo-{kind}-{index}.jpg"
            photographed(page, Image.open(background), rng).save(out, quality=88)
            cases.append({"name": out.name, "path": out, "kind": f"photographed {kind}"})
    return cases


def utility(args: argparse.Namespace, results: dict[str, Any]) -> None:
    probe = Probe()
    made = make_utility(WORK / "utility")
    groups: dict[str, list[dict[str, Any]]] = {"screenshots": [], "photographed documents": [], "gallery": [],
                                                "main library": []}
    try:
        for case in made:
            result = probe.run(case["path"], ["aesthetics", "barcodes"])
            case.update(result["aesthetics"], codes=result["barcodes"])
            groups["screenshots" if "screenshot" in case["kind"] else "photographed documents"].append(case)
        for name, path in gallery().items():
            groups["gallery"].append({"name": name, "path": path, **probe.run(path, ["aesthetics"])["aesthetics"]})
        for name, path in library_previews().items():
            groups["main library"].append({"name": name, "path": path, **probe.run(path, ["aesthetics"])["aesthetics"]})
    finally:
        probe.stop()
    print("== utility: the share marked utility (screenshots, documents) by Vision")
    for group, cases in groups.items():
        marked = [c for c in cases if c.get("utility")]
        print(f"  {group:<24} {len(marked):>3}/{len(cases):<4} {len(marked) / max(len(cases), 1):5.0%}")
        if group in ("gallery", "main library"):
            for case in marked:
                print(f"      marked: {case['name']}  ({case['path']})")
        else:
            for case in cases:
                if not case.get("utility"):
                    print(f"      not marked: {case['name']}")
    codes = [c for c in made if "qr" in c["name"] or c["kind"] in ("photographed receipt", "photographed poster",
                                                                     "photographed ticket")]
    read = sum(1 for c in codes if any("example.com" in code["payload"] for code in c["codes"]))
    print(f"  QR codes read: {read}/{len(codes)} of the photographed receipts, posters and tickets")
    results["utility"] = {group: [{"name": c["name"], "utility": c.get("utility"), "score": c.get("score")}
                                  for c in cases] for group, cases in groups.items()}


# --- quality -------------------------------------------------------------------------------------------------------

DEGRADE = {
    "blur 3px": lambda im: im.filter(ImageFilter.GaussianBlur(3)),
    "blur 8px": lambda im: im.filter(ImageFilter.GaussianBlur(8)),
    "dark": lambda im: ImageEnhance.Brightness(im).enhance(0.3),
    "washed out": lambda im: ImageEnhance.Contrast(im).enhance(0.35),
    "noise": lambda im: Image.blend(im, Image.effect_noise(im.size, 90).convert("RGB"), 0.35),
}


def quality(args: argparse.Namespace, results: dict[str, Any]) -> None:
    folder = WORK / "quality"
    folder.mkdir(parents=True, exist_ok=True)
    probe = Probe()
    rows: dict[str, list[float]] = {name: [] for name in DEGRADE}
    originals = []
    try:
        for name, path in gallery().items():
            image = Image.open(path).convert("RGB")
            original = probe.run(path, ["aesthetics"])["aesthetics"]["score"]
            originals.append(original)
            for kind, degrade in DEGRADE.items():
                out = folder / f"{name.replace('/', '_')}-{kind.replace(' ', '_')}.jpg"
                degrade(image).save(out, quality=90)
                rows[kind].append(original - probe.run(out, ["aesthetics"])["aesthetics"]["score"])
        faces = m1_face_eval_rows()
        sharp, blurred = [], []
        for face in faces[:20]:
            crop = Image.open(face["path"]).convert("RGB")
            out = folder / f"face-{face['index']}-blur.jpg"
            crop.filter(ImageFilter.GaussianBlur(6)).save(out, quality=90)
            for target, image_path in ((sharp, face["path"]), (blurred, out)):
                found = probe.run(image_path, ["faces"])["faces"]
                best = max((f for f in found if isinstance(f, dict)), key=lambda f: iou(f["box"], face["box"]), default=None)
                if best and iou(best["box"], face["box"]) > 0.3:
                    target.append(best["quality"])
    finally:
        probe.stop()
    print(f"== quality: the aesthetics score of {len(originals)} gallery photos (median {statistics.median(originals):.2f})"
          " against degraded copies")
    for kind, deltas in rows.items():
        print(f"  {kind:<12} scored lower in {sum(d > 0 for d in deltas)}/{len(deltas)}, by {statistics.median(deltas):+.2f} (median)")
    if sharp and blurred:
        print(f"  face capture quality: sharp {statistics.median(sharp):.2f}, blurred 6px {statistics.median(blurred):.2f} "
              f"(median of {len(sharp)} / {len(blurred)} faces found)")
    results["quality"] = {"deltas": rows, "originals": originals, "faces": {"sharp": sharp, "blurred": blurred}}


# --- faces ---------------------------------------------------------------------------------------------------------


def m1_face_eval_rows() -> list[dict[str, Any]]:
    import m1_face_eval

    rows = m1_face_eval.faces()
    for row in rows:
        width, height = row["size"]
        x1, y1, x2, y2 = row["box"]
        row["box"] = [x1 / width, y1 / height, (x2 - x1) / width, (y2 - y1) / height]
    return rows


def iou(a: list[float], b: list[float]) -> float:
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    w, h = max(0.0, min(ax2, bx2) - max(a[0], b[0])), max(0.0, min(ay2, by2) - max(a[1], b[1]))
    union = a[2] * a[3] + b[2] * b[3] - w * h
    return w * h / union if union else 0.0


def faces(args: argparse.Namespace, results: dict[str, Any]) -> None:
    labelled = m1_face_eval_rows()
    probe = Probe()
    found: dict[str, list[dict[str, Any]]] = {}
    try:
        for path in sorted({row["path"] for row in labelled}):
            found[path] = [f for f in probe.run(path, ["faces"])["faces"] if isinstance(f, dict)]
    finally:
        probe.stop()
    matched = sum(1 for row in labelled if any(iou(f["box"], row["box"]) > 0.3 for f in found[row["path"]]))
    extra = sum(1 for path, detected in found.items() for f in detected
                if not any(iou(f["box"], row["box"]) > 0.3 for row in labelled if row["path"] == path))
    print(f"== faces: Vision found {matched}/{len(labelled)} of the labelled faces (buffalo_l: 45/45); "
          f"{extra} detections are none of them (faces too small or turned for the labels, or not faces)")
    results["faces"] = {"matched": matched, "labelled": len(labelled), "extra": extra}


# --- speed ---------------------------------------------------------------------------------------------------------

TASKS = ["classify", "aesthetics", "ocr", "animals", "barcodes", "faces", "featureprint"]


def speed(args: argparse.Namespace, results: dict[str, Any]) -> None:
    photos = list(gallery().values())[:24]
    table: dict[str, dict[str, float]] = {}
    memory = {}
    for cpu in (False, True):
        probe = Probe()
        try:
            for path in photos[:2]:
                probe.run(path, TASKS, cpu=cpu)
            times: dict[str, list[float]] = {task: [] for task in TASKS + ["all"]}
            for path in photos:
                for task in TASKS:
                    times[task].append(probe.run(path, [task], cpu=cpu)["ms"][task])
                start = time.perf_counter()
                probe.run(path, TASKS, cpu=cpu)
                times["all"].append((time.perf_counter() - start) * 1000)
            memory["cpu" if cpu else "default"] = probe.footprint()
        finally:
            probe.stop()
        table["cpu" if cpu else "default"] = {task: statistics.median(values) for task, values in times.items()}
    print(f"== speed: median ms per 1440px preview over {len(photos)} photos, warm")
    print(f"  {'request':<14} {'as Vision chooses':>18} {'CPU alone':>10}")
    for task in TASKS + ["all"]:
        print(f"  {task:<14} {table['default'][task]:>18.1f} {table['cpu'][task]:>10.1f}")
    print(f"  memory of the process with every request loaded: {memory['default'] / 2**20:.0f} MB "
          f"(CPU alone {memory['cpu'] / 2**20:.0f} MB)")
    results["speed"] = {"ms": table, "memory": memory}


# --- library: a contact sheet ----------------------------------------------------------------------------------------


def library(args: argparse.Namespace) -> None:
    out = Path(args.out).expanduser()
    (out / "img").mkdir(parents=True, exist_ok=True)
    photos = library_previews(args.sample)
    probe = Probe()
    rows = []
    started = time.perf_counter()
    try:
        for index, (name, path) in enumerate(photos.items()):
            result = probe.run(path, TASKS[:2] + ["animals", "barcodes", "documents", "smudge"])
            thumb = out / "img" / f"{index}.jpg"
            image = Image.open(path).convert("RGB")
            image.thumbnail((360, 360))
            image.save(thumb, quality=80)
            rows.append({"name": name, "thumb": f"img/{index}.jpg", **result})
            if index % 200 == 0:
                print(f"  {index}/{len(photos)}", flush=True)
    finally:
        probe.stop()
    elapsed = time.perf_counter() - started

    def card(row: dict[str, Any], note: str) -> str:
        return (f"<figure><img src='{row['thumb']}' loading=lazy><figcaption>{html.escape(row['name'].split('#')[0])}"
                f"<br>{html.escape(note)}</figcaption></figure>")

    def tags_of(row: dict[str, Any]) -> str:
        return ", ".join(c["label"] for c in row["classify"][:6] if c["confidence"] >= 0.3) if isinstance(row["classify"], list) else ""

    sections = [
        ("Marked utility (would be archived: screenshots, receipts, documents)",
         [r for r in rows if isinstance(r["aesthetics"], dict) and r["aesthetics"]["utility"]],
         lambda r: f"score {r['aesthetics']['score']:.2f}; {tags_of(r)}"),
        ("Lowest aesthetics score (blurry, dark?)",
         sorted((r for r in rows if isinstance(r["aesthetics"], dict) and not r["aesthetics"]["utility"]),
                key=lambda r: r["aesthetics"]["score"])[:60], lambda r: f"score {r['aesthetics']['score']:.2f}"),
        ("Highest aesthetics score", sorted((r for r in rows if isinstance(r["aesthetics"], dict)),
                                             key=lambda r: -r["aesthetics"]["score"])[:60],
         lambda r: f"score {r['aesthetics']['score']:.2f}"),
        ("Lens smudge (macOS 26), confidence above 0.5",
         [r for r in rows if isinstance(r.get("smudge"), dict) and r["smudge"].get("confidence", 0) > 0.5],
         lambda r: f"smudge {r['smudge']['confidence']:.2f}"),
        ("Documents found (macOS 26)", [r for r in rows if isinstance(r.get("documents"), list) and r["documents"]],
         lambda r: f"{r['documents'][0]['tables']} tables, {len(r['documents'][0]['lines'])} lines"),
        ("Cats and dogs", [r for r in rows if isinstance(r["animals"], list) and r["animals"]],
         lambda r: ", ".join(a["label"] for a in r["animals"])),
        ("QR and bar codes", [r for r in rows if isinstance(r["barcodes"], list) and r["barcodes"]],
         lambda r: r["barcodes"][0]["symbology"]),
        ("A random 120, with their tags", random.Random(1).sample(rows, min(120, len(rows))), tags_of),
    ]
    body = [f"<h1>Apple Vision on {len(rows)} photos of this library</h1><p>{elapsed / max(len(rows), 1) * 1000:.0f} ms "
            f"per photo for classify, aesthetics, animals, barcodes, documents and smudge together. Check each section by "
            "eye: what is marked that should not be, and (in the random sample) what is not marked that should be.</p>"]
    for title, chosen, note in sections:
        body.append(f"<h2>{html.escape(title)}: {len(chosen)}</h2><div class=grid>"
                    + "".join(card(r, note(r)) for r in chosen[:300]) + "</div>")
    style = ("body{font:13px -apple-system;margin:20px}.grid{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;width:180px}"
             "img{width:180px;height:180px;object-fit:cover;border-radius:6px}figcaption{font-size:11px;color:#555}")
    (out / "index.html").write_text(f"<!doctype html><meta charset=utf-8><style>{style}</style>" + "".join(body))
    (out / "results.json").write_text(json.dumps(rows, ensure_ascii=False))
    summary = {title: len(chosen) for title, chosen, _ in sections}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"open {out / 'index.html'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("all", "ocr", "tags", "utility", "quality", "faces", "speed"):
        sub = commands.add_parser(name)
        sub.add_argument("--out", default=str(WORK / "results.json"))
        sub.add_argument("--ppocr", help="m1_ocr_eval.py's results for PP-OCRv6, to compare against")
    sub = commands.add_parser("library")
    sub.add_argument("--sample", type=int, default=2000)
    sub.add_argument("--out", default="~/Desktop/vision-report")
    args = parser.parse_args()
    if args.command == "library":
        library(args)
        return
    WORK.mkdir(parents=True, exist_ok=True)
    build_probe()
    results = json.loads(Path(args.out).read_text()) if Path(args.out).exists() else {}
    steps = {"ocr": ocr, "tags": tags, "utility": utility, "quality": quality, "faces": faces, "speed": speed}
    for name, step in steps.items():
        if args.command in (name, "all"):
            step(args, results)
            Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main()
