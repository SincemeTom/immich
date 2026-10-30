"""Face recognition models compared on the faces of the main library, labelled by hand: how well each tells people
apart at the distance the server clusters them (machineLearning.facialRecognition.maxDistance, 0.5), its speed and
memory. Each model runs in a machine learning service of its own, as in m1_ocr_eval.py.

The labels: the 45 faces of the main library (most from five shots of one audience, IMG_5561-5565), as 13 people,
checked by eye on crops. Each model detects the faces of each preview again; a detected face takes the label of the
labelled box it overlaps most.

Usage (with the machine-learning venv's python):
  m1_face_eval.py --out /tmp/face-eval/results.json [--models buffalo_l,antelopev2]
"""

import argparse
import itertools
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from m1_ocr_eval import Service  # noqa: E402

# by face, in the order of the query below: who it is
PEOPLE = {
    "A": [0, 16, 20, 33, 36],  # long hair, glasses, white top, phone
    "B": [1, 18, 28, 37],  # orange beret
    "C": [2, 12, 21, 32, 38],  # long hair, grey top
    "D": [3, 10, 22, 29, 34],  # bald, red hoodie
    "E": [4, 14, 23, 27],  # girl, glasses, striped top
    "F": [5, 11, 26, 35],  # the dancer, in a headdress
    "G": [6, 40],  # glasses, black top, at the side
    "H": [9, 15, 24, 30],  # glasses, dark top, back row
    "I": [7, 13, 25],  # cap
    "J": [8, 17, 31],  # glasses, dark top, phone light
    "K": [19, 39],  # short curly hair
    "L": [41, 44],  # short hair, glasses, pink
    "M": [42, 43],  # black top, at the shelves
}
MAX_DISTANCE = 0.5


def faces() -> list[dict[str, Any]]:
    out = subprocess.run(
        ["immichctl", "psql", "-At", "-F", "\t", "-c",
         'select a."originalFileName", p.path, f."imageWidth", f."imageHeight", f."boundingBoxX1", f."boundingBoxY1", '
         'f."boundingBoxX2", f."boundingBoxY2" from asset_face f join asset a on a.id = f."assetId" '
         "join asset_file p on p.\"assetId\" = a.id and p.type = 'preview' and not p.\"isEdited\" "
         'where f."deletedAt" is null and a."deletedAt" is null order by a."fileCreatedAt"'],
        capture_output=True, text=True, check=True).stdout
    label = {index: person for person, indexes in PEOPLE.items() for index in indexes}
    rows = []
    for index, line in enumerate(out.splitlines()):
        name, path, width, height, *box = line.split("\t")
        rows.append({"index": index, "name": name, "path": path, "size": (int(width), int(height)),
                     "box": [float(v) for v in box], "person": label[index]})
    if len(rows) != len(label):
        sys.exit(f"{len(rows)} faces in the library, {len(label)} labelled")
    return rows


def iou(a: list[float], b: list[float]) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def evaluate(model: str, labelled: list[dict[str, Any]]) -> dict[str, Any]:
    service = Service()
    idle = service.rss()
    entries = {"facial-recognition": {"detection": {"modelName": model, "options": {"minScore": 0.7}},
                                      "recognition": {"modelName": model}}}
    try:
        paths = sorted({face["path"] for face in labelled})
        start = time.perf_counter()
        service.client.post("/predict", data={"entries": json.dumps(entries)},
                            files={"image": Path(paths[0]).read_bytes()}).raise_for_status()
        first = time.perf_counter() - start
        embeddings: dict[int, np.ndarray] = {}
        timings, detected = [], 0
        for path in paths:
            data = Path(path).read_bytes()
            runs = []
            for _ in range(3):
                start = time.perf_counter()
                response = service.client.post("/predict", data={"entries": json.dumps(entries)}, files={"image": data})
                runs.append(time.perf_counter() - start)
                response.raise_for_status()
            timings.append(statistics.median(runs[1:]))
            body = response.json()
            found = body["facial-recognition"]
            detected += len(found)
            for face in [f for f in labelled if f["path"] == path]:
                # the labelled box, in the coordinates of the image the model saw
                sx, sy = body["imageWidth"] / face["size"][0], body["imageHeight"] / face["size"][1]
                box = [face["box"][0] * sx, face["box"][1] * sy, face["box"][2] * sx, face["box"][3] * sy]
                scored = [(iou(box, [f["boundingBox"][k] for k in ("x1", "y1", "x2", "y2")]), f) for f in found]
                best = max(scored, key=lambda pair: pair[0], default=(0.0, None))
                if best[1] is not None and best[0] > 0.3:
                    vector = np.array(json.loads(best[1]["embedding"]) if isinstance(best[1]["embedding"], str)
                                      else best[1]["embedding"], dtype=np.float32)
                    embeddings[face["index"]] = vector / np.linalg.norm(vector)
        loaded = service.rss()
    finally:
        service.stop()

    person = {face["index"]: face["person"] for face in labelled}
    same, different = [], []
    for a, b in itertools.combinations(sorted(embeddings), 2):
        d = float(1 - embeddings[a] @ embeddings[b])
        (same if person[a] == person[b] else different).append(d)
    same_arr, diff_arr = np.array(same), np.array(different)
    # the chance that a pair of one person is closer than a pair of two: ROC AUC
    auc = float((same_arr[:, None] < diff_arr[None, :]).mean() + 0.5 * (same_arr[:, None] == diff_arr[None, :]).mean())
    return {
        "model": model, "first": first, "idle": idle, "loaded": loaded, "peak": service.peak,
        "median": statistics.median(timings), "detected": detected, "matched": len(embeddings),
        "same": {"pairs": len(same), "within": int((same_arr <= MAX_DISTANCE).sum()),
                 "median": float(np.median(same_arr)), "max": float(same_arr.max())},
        "different": {"pairs": len(different), "within": int((diff_arr <= MAX_DISTANCE).sum()),
                      "median": float(np.median(diff_arr)), "min": float(diff_arr.min())},
        "auc": auc,
        # the gap between the farthest pair of one person and the closest pair of two: wider, the easier to cluster
        "margin": float(diff_arr.min() - same_arr.max()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/face-eval/results.json")
    parser.add_argument("--models", default="buffalo_l,antelopev2")
    args = parser.parse_args()
    labelled = faces()
    results = json.loads(Path(args.out).read_text()) if Path(args.out).exists() else {}
    for model in args.models.split(","):
        if model not in results:
            print(f"== {model}", flush=True)
            results[model] = evaluate(model, labelled)
            Path(args.out).write_text(json.dumps(results, indent=1))
    print(f"{'model':12} {'faces':>9} {'same <= 0.5':>12} {'different <= 0.5':>17} {'same median/max':>16} "
          f"{'diff median/min':>16} {'AUC':>6} {'margin':>7} {'per photo':>9} {'RSS':>7}")
    for model, r in results.items():
        print(f"{model:12} {r['matched']:>4}/{len(labelled):<4} {r['same']['within']:>5}/{r['same']['pairs']:<6} "
              f"{r['different']['within']:>8}/{r['different']['pairs']:<8} "
              f"{r['same']['median']:>7.3f}/{r['same']['max']:.3f} {r['different']['median']:>7.3f}/{r['different']['min']:.3f} "
              f"{r['auc']:>6.3f} {r['margin']:>7.3f} {r['median'] * 1000:>7.0f}ms {r['loaded'] / 2**20:>5.0f}MB")


if __name__ == "__main__":
    main()
