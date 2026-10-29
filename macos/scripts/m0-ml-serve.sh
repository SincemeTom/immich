#!/usr/bin/env bash
# M0: runs the machine learning service natively, with CoreML (as shipped) or forced onto the CPU (as a baseline).
# Usage: macos/scripts/m0-ml-serve.sh coreml|cpu [port]
set -euo pipefail

mode="${1:?usage: $0 coreml|cpu [port]}"
port="${2:-3003}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ml="$repo/machine-learning"

if [ ! -x "$ml/.venv/bin/python" ]; then
  echo "missing $ml/.venv: run 'uv sync --frozen --extra cpu' in machine-learning with an arm64 Python 3.12" >&2
  exit 1
fi

export PATH="$ml/.venv/bin:$PATH"
export PYTHONPATH="$ml"
export IMMICH_HOST=127.0.0.1
export IMMICH_PORT="$port"
export MACHINE_LEARNING_CACHE_FOLDER="${MACHINE_LEARNING_CACHE_FOLDER:-$HOME/Library/Caches/immich-m0/models}"
export HF_HOME="${HF_HOME:-$HOME/Library/Caches/immich-m0/hf}"
export MACHINE_LEARNING_MODEL_TTL=0
mkdir -p "$MACHINE_LEARNING_CACHE_FOLDER" "$HF_HOME"
cd "$ml"

case "$mode" in
  coreml)
    # the same entry point as the container: gunicorn forking a uvicorn worker
    exec python -m immich_ml
    ;;
  cpu)
    # immich_ml offers no setting for the provider, so the default is replaced before the app loads
    exec python -c "
import immich_ml.sessions.ort as ort
ort._providers_default = lambda: ['CPUExecutionProvider']
import uvicorn
uvicorn.run('immich_ml.main:app', host='127.0.0.1', port=$port)
"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
