"""The memory of the machine learning service with every model of a configuration loaded, as when a library is first
processed: smart search (both halves), faces and OCR. Usage: m1_ml_memory.py CLIP FACE OCR OCR_RESOLUTION"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from m1_ocr_eval import Service, previews  # noqa: E402

clip, face, ocr, resolution = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
image = next(iter(previews(["IMG_5561.HEIC"]).values())).read_bytes()
service = Service()
try:
    steps = [
        ("clip visual", {"clip": {"visual": {"modelName": clip}}}, {"image": image}),
        ("clip textual", {"clip": {"textual": {"modelName": clip}}}, None),
        ("faces", {"facial-recognition": {"detection": {"modelName": face, "options": {"minScore": 0.7}},
                                          "recognition": {"modelName": face}}}, {"image": image}),
        ("ocr", {"ocr": {"detection": {"modelName": ocr, "options": {"minScore": 0.5, "maxResolution": resolution}},
                         "recognition": {"modelName": ocr, "options": {"minScore": 0.8}}}}, {"image": image}),
    ]
    for label, entries, files in steps:
        start = time.perf_counter()
        data = {"entries": json.dumps(entries)} | ({} if files else {"text": "海边的日落"})
        service.client.post("/predict", data=data, files=files).raise_for_status()
        print(f"  {label:13} loaded in {time.perf_counter() - start:5.1f}s: footprint {service.footprint() / 2**30:5.2f} GB,"
              f" RSS {service.rss() / 2**30:5.2f} GB", flush=True)
    # then the shapes a library brings: portrait and landscape, lines of text of every length
    others = sorted(Path("/tmp/ocr-eval/synthetic").glob("*.jpg")) + sorted(Path("/tmp/ocr-eval").glob("*.jpg"))
    for path in others:
        for _, entries, _ in steps[2:]:
            service.client.post("/predict", data={"entries": json.dumps(entries)},
                                files={"image": path.read_bytes()}).raise_for_status()
    print(f"  after {len(others)} more photos: footprint {service.footprint() / 2**30:5.2f} GB, "
          f"RSS {service.rss() / 2**30:5.2f} GB, peak RSS {service.peak / 2**30:.2f} GB")
finally:
    service.stop()
