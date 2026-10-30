"""The thresholds of face recognition: the detection score (minScore), and the clustering's distance (maxDistance) and
core size (minFaces), replayed the way the server clusters (PersonService.handleRecognizeFaces).

Faces: the 45 of the main library, labelled by hand (m1_face_eval.py), and LFW (Labeled Faces in the Wild, from
huggingface.co/datasets/logasja/lfw): its people with two photos or more, up to eight each, and a thousand with one,
who stand for the strangers of a library. The detection score is measured on the main library: every detection down
to 0.3, the ones not labelled checked by eye.

Usage (with the machine-learning venv's python):
  m1_face_thresholds.py embed --lfw /tmp/face-eval/lfw --out /tmp/face-eval/embeddings.npz [--model buffalo_l]
  m1_face_thresholds.py cluster /tmp/face-eval/embeddings.npz
  m1_face_thresholds.py detect --out /tmp/face-eval/detections.json
"""

import argparse
import json
import random
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from m1_face_eval import faces, iou  # noqa: E402
from m1_ocr_eval import Service  # noqa: E402


def request(service: Service, data: bytes, model: str, min_score: float) -> dict:
    entries = {"facial-recognition": {"detection": {"modelName": model, "options": {"minScore": min_score}},
                                      "recognition": {"modelName": model}}}
    response = service.client.post("/predict", data={"entries": json.dumps(entries)}, files={"image": data})
    response.raise_for_status()
    return response.json()


def vector(face: dict) -> np.ndarray:
    raw = face["embedding"]
    v = np.array(json.loads(raw) if isinstance(raw, str) else raw, dtype=np.float32)
    return v / np.linalg.norm(v)


def embed(args: argparse.Namespace) -> None:
    labels, vectors, sources = [], [], []
    service = Service()
    try:
        for face in faces():
            body = request(service, Path(face["path"]).read_bytes(), args.model, 0.7)
            sx, sy = body["imageWidth"] / face["size"][0], body["imageHeight"] / face["size"][1]
            box = [face["box"][0] * sx, face["box"][1] * sy, face["box"][2] * sx, face["box"][3] * sy]
            best = max(body["facial-recognition"], default=None,
                       key=lambda f: iou(box, [f["boundingBox"][k] for k in ("x1", "y1", "x2", "y2")]))
            if best is not None:
                labels.append(f"library:{face['person']}")
                vectors.append(vector(best))
                sources.append("library")
        missed = 0
        paths = sorted(Path(args.lfw).glob("*.jpg"))
        for index, path in enumerate(paths):
            body = request(service, path.read_bytes(), args.model, 0.7)
            found = body["facial-recognition"]
            if not found:
                missed += 1
                continue
            # LFW centres the face it is labelled for; others in the frame are bystanders
            cx, cy = body["imageWidth"] / 2, body["imageHeight"] / 2
            centre = min(found, key=lambda f: (((f["boundingBox"]["x1"] + f["boundingBox"]["x2"]) / 2 - cx) ** 2
                                               + ((f["boundingBox"]["y1"] + f["boundingBox"]["y2"]) / 2 - cy) ** 2))
            labels.append(f"lfw:{path.stem.rsplit('_', 1)[0]}")
            vectors.append(vector(centre))
            sources.append("lfw")
            if index % 1000 == 0:
                print(f"  {index}/{len(paths)}", flush=True)
        print(f"  LFW: no face found in {missed} of {len(paths)}")
    finally:
        service.stop()
    np.savez(args.out, labels=np.array(labels), vectors=np.stack(vectors), sources=np.array(sources))


def cluster(vectors: np.ndarray, max_distance: float, min_faces: int, order: list[int]) -> np.ndarray:
    """PersonService.handleRecognizeFaces over every face, in the order the jobs run, then the deferred ones"""
    distances = 1 - vectors @ vectors.T
    person = np.full(len(vectors), -1)
    people = 0

    def nearest(i: int, count: int | None, with_person: bool) -> list[int]:
        candidates = np.where(distances[i] <= max_distance)[0]
        if with_person:
            candidates = candidates[person[candidates] >= 0]
        candidates = candidates[np.argsort(distances[i][candidates], kind="stable")]
        return list(candidates[:count] if count else candidates)

    def assign(i: int, core: bool) -> None:
        nonlocal people
        matches = nearest(i, min_faces, False)
        group = next((person[m] for m in matches if person[m] >= 0), -1)
        if group < 0:
            with_person = nearest(i, 1, True)
            group = person[with_person[0]] if with_person else -1
        if group < 0 and core:
            group = people
            people += 1
        person[i] = group

    deferred = []
    for i in order:
        matches = nearest(i, min_faces, False)
        if min_faces > 1 and len(matches) <= 1:
            continue  # only itself: skipped, and not tried again
        if len(matches) >= min_faces:
            assign(i, True)
        else:
            deferred.append(i)
    for i in deferred:
        assign(i, False)
    return person


def score(labels: np.ndarray, person: np.ndarray) -> dict:
    """B-cubed precision and recall over the faces put in a person; and the faces left out, and the people"""
    placed = np.where(person >= 0)[0]
    by_person = defaultdict(list)
    for i in placed:
        by_person[person[i]].append(i)
    by_label = Counter(labels)
    precision = recall = 0.0
    for members in by_person.values():
        counts = Counter(labels[members])
        for i in members:
            precision += counts[labels[i]] / len(members)
            recall += counts[labels[i]] / by_label[labels[i]]
    # people of one face are not people anyone can find, and the server leaves them out too
    recurring = {label for label, count in by_label.items() if count >= 2}
    in_recurring = np.isin(labels, list(recurring))
    impure = sum(1 for members in by_person.values() if len(set(labels[members])) > 1)
    return {
        "precision": precision / max(len(placed), 1),
        "recall": recall / max(len(placed), 1),
        "placed": float((person[in_recurring] >= 0).mean()),
        "strangers placed": float((person[~in_recurring] >= 0).mean()) if (~in_recurring).any() else 0.0,
        "people": len(by_person),
        "true people": len(recurring),
        "mixed": impure,
    }


def run_cluster(args: argparse.Namespace) -> None:
    data = np.load(args.embeddings)
    labels, vectors, sources = data["labels"], data["vectors"], data["sources"]
    order = list(range(len(labels)))
    random.Random(7).shuffle(order)
    print(f"{len(labels)} faces, {len(set(labels))} people ({(sources == 'library').sum()} of the main library)")
    print(f"{'maxDist':>7} {'minFaces':>8} {'precision':>9} {'recall':>7} {'placed':>7} {'strangers':>9} "
          f"{'people/true':>12} {'mixed':>6} {'library P/R/placed':>20}")
    library = np.where(sources == "library")[0]
    for max_distance in (0.4, 0.45, 0.5, 0.55, 0.6):
        for min_faces in (1, 2, 3, 5):
            person = cluster(vectors, max_distance, min_faces, order)
            s = score(labels, person)
            lib = score(labels[library], person[library])
            print(f"{max_distance:7.2f} {min_faces:8} {s['precision']:9.3f} {s['recall']:7.3f} {s['placed']:7.3f} "
                  f"{s['strangers placed']:9.3f} {s['people']:>5}/{s['true people']:<6} {s['mixed']:6} "
                  f"{lib['precision']:6.3f}/{lib['recall']:.3f}/{lib['placed']:.2f}", flush=True)


def detect(args: argparse.Namespace) -> None:
    """Every detection down to 0.3 on the photos of the main library, with whether it is a labelled face"""
    out = subprocess.run(
        ["immichctl", "psql", "-At", "-F", "\t", "-c",
         'select a."originalFileName", f.path from asset a join asset_file f on f."assetId" = a.id '
         "and f.type = 'preview' and not f.\"isEdited\" where a.\"deletedAt\" is null order by a.\"fileCreatedAt\""],
        capture_output=True, text=True, check=True).stdout
    labelled = defaultdict(list)
    for face in faces():
        labelled[face["path"]].append(face)
    found = []
    service = Service()
    try:
        for name, path in (line.split("\t") for line in out.splitlines() if line):
            body = request(service, Path(path).read_bytes(), args.model, 0.3)
            for face in body["facial-recognition"]:
                box = [face["boundingBox"][k] for k in ("x1", "y1", "x2", "y2")]
                overlap = 0.0
                for known in labelled[path]:
                    sx, sy = body["imageWidth"] / known["size"][0], body["imageHeight"] / known["size"][1]
                    kb = [known["box"][0] * sx, known["box"][1] * sy, known["box"][2] * sx, known["box"][3] * sy]
                    overlap = max(overlap, iou(box, kb))
                found.append({"name": name, "path": path, "score": face["score"], "box": box,
                              "size": [body["imageWidth"], body["imageHeight"]], "labelled": overlap > 0.3})
    finally:
        service.stop()
    Path(args.out).write_text(json.dumps(found, indent=1))
    for low, high in ((0.3, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 1.01)):
        band = [f for f in found if low <= f["score"] < high]
        print(f"score {low:.1f}-{min(high, 1):.1f}: {len(band):3} detections, {sum(f['labelled'] for f in band):3} labelled")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    e = sub.add_parser("embed")
    e.add_argument("--lfw", default="/tmp/face-eval/lfw")
    e.add_argument("--out", default="/tmp/face-eval/embeddings.npz")
    e.add_argument("--model", default="buffalo_l")
    c = sub.add_parser("cluster")
    c.add_argument("embeddings")
    d = sub.add_parser("detect")
    d.add_argument("--out", default="/tmp/face-eval/detections.json")
    d.add_argument("--model", default="buffalo_l")
    args = parser.parse_args()
    {"embed": embed, "cluster": run_cluster, "detect": detect}[args.command](args)


if __name__ == "__main__":
    main()
