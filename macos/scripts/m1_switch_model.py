"""M1: switches the smart search model of a library that already has photos, with `immichctl clip-model`, then
re-indexes it the way the web UI's Jobs page does (Smart Search > All), and checks Chinese search works after.

Usage (with the machine-learning venv's python; the instance must have run m0_e2e.py):
  m1_switch_model.py --url http://127.0.0.1:2284 --immichctl ".../bin/immichctl" --model XLM-Roberta-...
"""

import argparse
import subprocess
import sys
import time

import httpx

EMAIL, PASSWORD = "m0@immich.local", "m0-password"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--immichctl", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    started = time.time()
    switch = subprocess.run([args.immichctl, "clip-model", args.model], capture_output=True, text=True)
    print(switch.stdout.rstrip())
    if switch.returncode != 0:
        sys.exit(f"immichctl clip-model failed: {switch.stderr}")
    print(f"  (switch and warm-up: {time.time() - started:.0f}s)")

    client = httpx.Client(base_url=args.url, timeout=60)
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            if client.get("/api/server/ping").json().get("res") == "pong":
                break
        except httpx.HTTPError:
            pass
        time.sleep(1)
    login = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    login.raise_for_status()
    client.headers["Authorization"] = f"Bearer {login.json()['accessToken']}"

    model = client.get("/api/system-config").json()["machineLearning"]["clip"]["modelName"]
    results = [("the server uses the new model", model == args.model, model)]

    # Administration > Jobs > Smart Search > All
    started = time.time()
    client.put("/api/jobs/smartSearch", json={"command": "start", "force": True}).raise_for_status()
    # the queue must have taken the work before it can be seen to be done
    time.sleep(2)
    while True:
        queues = {queue["name"]: queue["statistics"] for queue in client.get("/api/queues").json()}
        work = queues["smartSearch"]
        if not (work["active"] or work["waiting"] or work["delayed"]):
            break
        time.sleep(1)
    print(f"  re-indexed in {time.time() - started:.0f}s")

    # photos whose files are still there: m0_e2e.py uploads both, and m1_restore.py only ever trashes the falcon
    queries = [("a small Japanese shop at night", "japanese-shop.jpg"), ("an old black and white photo", "portrait.jpg")]
    if args.model.startswith(("XLM-", "nllb-")) or "SigLIP2" in args.model:
        queries += [("夜晚的日本小店", "japanese-shop.jpg"), ("黑白老照片", "portrait.jpg")]
    for query, expected in queries:
        hits = client.post("/api/search/smart", json={"query": query, "size": 3}).json()["assets"]["items"]
        top = [hit["originalFileName"] for hit in hits]
        results.append((f"after re-indexing, '{query}' ranks {expected} first", bool(top) and top[0] == expected,
                        ", ".join(top)))

    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    passed = sum(ok for _, ok, _ in results)
    print(f"Result: {passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
