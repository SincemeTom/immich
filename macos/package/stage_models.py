"""Stages the machine learning models for the .pkg: exactly the files the service downloads, in its folder layout, with
the marker that tells `immichctl warm` they are complete. That is each model's Hugging Face repository (same
organization and revision, no ArmNN or RKNN files), and for OCR on the older model exports, which Hugging Face does not
have, the detection and recognition models RapidOCR names, checked against their SHA-256 (models/ocr/legacy.py). A file
already on this Mac that matches is cloned (APFS: no extra space), anything else is downloaded. Nothing this Mac made
(CoreML's compiled copies, locks) is taken.

Run with the release's Python, which has huggingface_hub and immich_ml (PYTHONPATH=<release>/ml):
  stage_models.py SOURCE_MODELS DEST CLIP FACE OCR
"""

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

from immich_ml.config import settings
from immich_ml.schemas import ModelTask, ModelType

IGNORED = (".armnn", ".rknn")
MARKER = ".immich-native-downloaded"


def stage(task: ModelTask, name: str, source_root: Path, dest_root: Path) -> int:
    relative = Path(task.value) / name
    if not settings.legacy_models:
        relative /= settings.model_revision
    source, dest = source_root / relative, dest_root / relative
    repo = f"{settings.model_organization}/{name}"
    files = [
        f for f in HfApi().list_repo_tree(repo, revision=settings.model_revision, recursive=True)
        if hasattr(f, "size") and not f.path.endswith(IGNORED)
    ]
    cloned = downloaded = 0
    for entry in files:
        target = dest / entry.path
        target.parent.mkdir(parents=True, exist_ok=True)
        local = source / entry.path
        if local.is_file() and local.stat().st_size == entry.size:
            subprocess.run(["cp", "-c", str(local), str(target)], check=True)
            cloned += 1
        else:
            fetched = hf_hub_download(repo, entry.path, revision=settings.model_revision, local_dir=dest)
            if Path(fetched).stat().st_size != entry.size:
                raise SystemExit(f"{repo}/{entry.path}: downloaded {Path(fetched).stat().st_size} bytes, not {entry.size}")
            downloaded += 1
        if target.stat().st_size != entry.size:
            raise SystemExit(f"{target}: {target.stat().st_size} bytes, not {entry.size}")
    if task == ModelTask.OCR and settings.legacy_models:
        for model_type in (ModelType.DETECTION, ModelType.RECOGNITION):
            size = stage_rapidocr(name, model_type, source, dest)
            files.append(type("Staged", (), {"size": size})())
    # what hf_hub_download keeps beside the files it fetched
    shutil.rmtree(dest / ".cache", ignore_errors=True)
    (dest / MARKER).touch()
    size = sum(f.size for f in files)
    print(f"  {relative}: {len(files)} files, {size / 1e9:.2f} GB ({cloned} from this Mac, {downloaded} downloaded)")
    return size


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def stage_rapidocr(name: str, model_type: ModelType, source: Path, dest: Path) -> int:
    """An OCR model of the older exports, from where TextModel.download() fetches it, as its own folder holds it"""
    from rapidocr.inference_engine.base import FileInfo, InferSession
    from rapidocr.utils.download_file import DownloadFile, DownloadFileInput
    from rapidocr.utils.typings import EngineType, LangDet, LangRec, OCRVersion, TaskType
    from rapidocr.utils.typings import ModelType as RapidModelType

    detects = model_type == ModelType.DETECTION
    language = name.split("__")[0] if "__" in name else "CH"
    version, size = name.split("__")[-1].rsplit("_", 1)
    info = InferSession.get_model_url(
        FileInfo(
            engine_type=EngineType.ONNXRUNTIME,
            ocr_version=OCRVersion(version),
            task_type=TaskType.DET if detects else TaskType.REC,
            lang_type=LangDet.CH if detects else LangRec[language],
            model_type=RapidModelType(size),
        )
    )
    relative = Path(model_type.value) / "model.onnx"
    local, target = source / relative, dest / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if local.is_file() and sha256(local) == info["SHA256"]:
        subprocess.run(["cp", "-c", str(local), str(target)], check=True)
        how = "from this Mac"
    else:
        DownloadFile.run(DownloadFileInput(file_url=info["model_dir"], sha256=info["SHA256"], save_path=target, logger=None))
        how = "downloaded"
    if sha256(target) != info["SHA256"]:
        raise SystemExit(f"{target}: not the SHA-256 RapidOCR gives")
    print(f"    {relative}: {target.stat().st_size / 1e6:.0f} MB, SHA-256 checked ({how})")
    return target.stat().st_size


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit(__doc__)
    source, dest = Path(sys.argv[1]), Path(sys.argv[2])
    total = 0
    for task, name in zip((ModelTask.SEARCH, ModelTask.FACIAL_RECOGNITION, ModelTask.OCR), sys.argv[3:]):
        total += stage(task, name, source, dest)
    print(f"  {total / 1e9:.2f} GB of models")


if __name__ == "__main__":
    main()
