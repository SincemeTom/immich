"""M1: restores a database backup through the API the web UI uses (Administration > Maintenance > Restore), on a
native install, and checks the data comes back.

1. creates a backup of the current state, then moves an asset to the trash so the database differs from it
2. enters maintenance mode, which restarts the server into its maintenance worker
3. starts the restore of that backup, follows its progress, and waits for the server to come back out
4. checks the asset is out of the trash again, with its search embedding, and the restore point backup taken before

Usage (with the machine-learning venv's python, which has httpx; the instance must have run m0_e2e.py):
  m1_restore.py --url http://127.0.0.1:2284
"""

import argparse
import gzip
import sys
import time

import httpx

EMAIL, PASSWORD = "m0@immich.local", "m0-password"


def wait(what: str, condition, timeout: int = 300, interval: float = 1.0):  # type: ignore[no-untyped-def]
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = condition()
            if result:
                return result
        except httpx.HTTPError:
            pass  # the server restarts between modes
        time.sleep(interval)
    sys.exit(f"timed out waiting for {what}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2283")
    args = parser.parse_args()
    client = httpx.Client(base_url=args.url, timeout=60)

    login = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    login.raise_for_status()
    client.headers["Authorization"] = f"Bearer {login.json()['accessToken']}"

    print("== take a backup, then change the database")
    before = {b["filename"] for b in client.get("/api/admin/database-backups").json()["backups"]}
    client.post("/api/jobs", json={"name": "backup-database"}).raise_for_status()
    backups = wait(
        "the backup",
        lambda: [
            b for b in client.get("/api/admin/database-backups").json()["backups"] if b["filename"] not in before
        ],
    )
    backup = backups[0]["filename"]
    body = client.get(f"/api/admin/database-backups/{backup}").content
    print(f"  backup {backup}: {len(body)} bytes, {len(gzip.decompress(body))} bytes of SQL")

    hits = client.post("/api/search/smart", json={"query": "a bird of prey", "size": 1}).json()["assets"]["items"]
    falcon = hits[0]
    assert falcon["originalFileName"] == "prairie_falcon.jpg", falcon["originalFileName"]
    # to the trash, not deleted for good: that would remove its files, which restoring the database cannot bring back
    client.request("DELETE", "/api/assets", json={"ids": [falcon["id"]]}).raise_for_status()
    wait("the delete", lambda: client.get(f"/api/assets/{falcon['id']}").json()["isTrashed"], timeout=60)
    print(f"  moved {falcon['originalFileName']} ({falcon['id']}) to the trash")

    print("== restore it the way the web UI does")
    response = client.post("/api/admin/maintenance", json={"action": "start"})
    response.raise_for_status()
    client.cookies.update(response.cookies)
    wait("maintenance mode", lambda: client.get("/api/admin/maintenance/status").json()["active"])
    print("  in maintenance mode")
    restore = {"action": "restore_database", "restoreBackupFilename": backup}
    client.post("/api/admin/maintenance", json=restore).raise_for_status()

    seen: list[str] = []

    def finished() -> bool:
        status = client.get("/api/admin/maintenance/status").json()
        step = f"{status.get('task')} {status.get('progress', '')}".strip()
        if status.get("error"):
            sys.exit(f"restore failed: {status['error']}")
        if status["active"] and step not in seen:
            seen.append(step)
            print(f"    {step}")
        return not status["active"]

    started = time.time()
    wait("the restore", finished, timeout=600, interval=0.5)
    wait("the server", lambda: client.get("/api/server/ping").json().get("res") == "pong", timeout=180)
    print(f"  back out of maintenance mode in {time.time() - started:.0f}s")

    print("== check")
    login = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    login.raise_for_status()
    client.headers["Authorization"] = f"Bearer {login.json()['accessToken']}"
    results = []
    asset = client.get(f"/api/assets/{falcon['id']}").json()
    results.append(("the trashed asset is back", not asset["isTrashed"], f"{asset['originalFileName']}, in trash: no"))
    hits = client.post("/api/search/smart", json={"query": "a bird of prey", "size": 1}).json()["assets"]["items"]
    top = hits[0]["originalFileName"] if hits else "nothing"
    results.append(("its search embedding is back", bool(hits) and hits[0]["id"] == falcon["id"], f"top hit {top}"))
    points = [b for b in client.get("/api/admin/database-backups").json()["backups"]
              if b["filename"].startswith("restore-point-")]
    results.append(("a restore point was taken before restoring", bool(points), points[0]["filename"] if points else ""))
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    passed = sum(ok for _, ok, _ in results)
    print(f"\nResult: {passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
