#!/usr/bin/env bash
# M0: reproduces the CoreML crash seen when a gunicorn worker compiles models for the first time.
# Clears only the CoreML artifacts, starts the service in the given mode, sends one request per model, counts crashes.
# Usage: macos/scripts/m0-ml-repro-crash.sh gunicorn|single [rounds]
set -uo pipefail

mode="${1:?usage: $0 gunicorn|single [rounds]}"
rounds="${2:-3}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ml="$repo/machine-learning"
cache="${MACHINE_LEARNING_CACHE_FOLDER:-$HOME/Library/Caches/immich-m0/models}"
port=3006
logs=/tmp/immich-m0
mkdir -p "$logs"

stop() { pkill -f "immich_ml" >/dev/null 2>&1; sleep 1; }

for round in $(seq 1 "$rounds"); do
  stop
  find "$cache" -type d -name coreml -prune -exec rm -rf {} +
  log="$logs/repro-$mode-$round.log"
  case "$mode" in
    gunicorn)
      MACHINE_LEARNING_CACHE_FOLDER="$cache" nohup "$repo/macos/scripts/m0-ml-serve.sh" coreml "$port" >"$log" 2>&1 &
      ;;
    single)
      (cd "$ml" && PYTHONPATH="$ml" MACHINE_LEARNING_CACHE_FOLDER="$cache" HF_HOME="$HOME/Library/Caches/immich-m0/hf" \
        MACHINE_LEARNING_MODEL_TTL=0 nohup .venv/bin/python -c \
        "import uvicorn; uvicorn.run('immich_ml.main:app', host='127.0.0.1', port=$port)" >"$log" 2>&1 &)
      ;;
    *) echo "unknown mode: $mode" >&2; exit 1 ;;
  esac
  "$ml/.venv/bin/python" "$repo/macos/scripts/m0_ml_bench.py" run --url "http://127.0.0.1:$port" --label "$mode" \
    --runs 1 --out "$logs/repro-$mode-$round.json" >"$logs/repro-$mode-$round.bench" 2>&1
  bench=$?
  crashes=$(grep -c -E "SIGABRT|failed assertion" "$log")
  echo "round $round: bench exit $bench, crashes $crashes"
done
stop
