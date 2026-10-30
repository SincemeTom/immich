"""Network shares, end to end: added, tested, mounted, used by an external library, unmounted, dropped and mounted
again, across the NAS going away and coming back and the server restarting, then removed, on a fresh test instance.

The NAS is an NFS server rclone runs on 127.0.0.1 (the instance's server.env sets IMMICH_NETWORK_SHARES_NFS_PORT to its
port), serving a local folder, so the script can stop and start it, and check the files on the "NAS" itself.

The first time the instance's node reads a network volume, macOS asks whether it may: click Allow.

Usage (with the machine-learning venv's python, which has httpx):
  m1_network_shares.py --url http://127.0.0.1:2288 --home ~/Library/Application\\ Support/Immich-p4 --nas /tmp/immich-p4/nas
  ... --purge   also runs `immichctl uninstall --purge` with a share mounted, which must leave the NAS's files alone
"""

import argparse
import hashlib
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

import httpx

EMAIL, PASSWORD = "p4@immich.local", "p4-password"
REPO = Path(__file__).resolve().parents[2]
E2E = REPO / "e2e/test-assets"
SAMPLES = ["formats/jpg/el_torcal_rocks.jpg", "formats/heic/IMG_2682.heic", "albums/nature/prairie_falcon.jpg",
           "albums/nature/tanners_ridge.jpg", "albums/nature/cyclamen_persicum.jpg"]

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}", flush=True)
    return ok


def poll(condition: Callable[[], Any], timeout: float, interval: float = 2) -> tuple[Any, float]:
    """The first truthy value of condition within timeout, and how long it took"""
    start = time.time()
    value = condition()
    while not value and time.time() - start < timeout:
        time.sleep(interval)
        value = condition()
    return value, time.time() - start


def nfs_mounts() -> dict[str, str]:
    out = subprocess.run(["/sbin/mount", "-t", "nfs"], capture_output=True, text=True).stdout
    mounts = {}
    for line in out.splitlines():
        source, _, rest = line.partition(" on ")
        path, _, options = rest.rpartition(" (")
        mounts[path] = options
    return mounts


def snapshot(folder: Path) -> dict[str, str]:
    return {str(p.relative_to(folder)): hashlib.sha1(p.read_bytes()).hexdigest()
            for p in sorted(folder.rglob("*")) if p.is_file()}


class Nas:
    """rclone serving a local folder over NFS, as the NAS"""

    def __init__(self, folder: Path, port: int) -> None:
        self.folder, self.port = folder, port
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        self.process = subprocess.Popen(
            ["rclone", "serve", "nfs", str(self.folder), "--addr", f"127.0.0.1:{self.port}", "--vfs-cache-mode", "off"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)

    def stop(self) -> None:
        if self.process:
            self.process.kill()
            self.process.wait()
            self.process = None


class Instance:
    def __init__(self, url: str, home: Path) -> None:
        self.client = httpx.Client(base_url=url, timeout=120)
        self.home = home
        self.ctl = home / "bin/immichctl"

    def sql(self, query: str) -> list[list[str]]:
        out = subprocess.run([str(self.ctl), "psql", "-At", "-F", "\t", "-c", query], capture_output=True, text=True,
                             check=True)
        return [line.split("\t") for line in out.stdout.splitlines() if line]

    def login(self) -> str:
        c = self.client
        if not c.get("/api/server/config").json().get("isInitialized"):
            c.post("/api/auth/admin-sign-up", json={"email": EMAIL, "name": "P4", "password": PASSWORD}).raise_for_status()
        body = c.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()
        c.headers["Authorization"] = f"Bearer {body['accessToken']}"
        return str(body["userId"])

    def wait(self, timeout: int = 600) -> None:
        deadline, quiet = time.time() + timeout, 0
        while time.time() < deadline:
            queues = {q["name"]: q["statistics"] for q in self.client.get("/api/queues").json()}
            busy = any(s["active"] or s["waiting"] or s["delayed"] for s in queues.values())
            quiet = 0 if busy else quiet + 1
            if quiet >= 3:
                return
            time.sleep(1)
        sys.exit("queues did not drain in time")

    def shares(self) -> list[dict[str, Any]]:
        response = self.client.get("/api/admin/network-shares")
        response.raise_for_status()
        return list(response.json())

    def share(self, share_id: str) -> dict[str, Any]:
        return next(s for s in self.shares() if s["id"] == share_id)

    def library_assets(self, library_id: str) -> dict[str, bool]:
        """Each asset's file name, and whether it is offline"""
        rows = self.sql(f'select "originalFileName", "isOffline" from asset where "libraryId" = \'{library_id}\'')
        return {name: offline == "t" for name, offline in rows}

    def scan(self, library_id: str) -> None:
        self.client.post(f"/api/libraries/{library_id}/scan").raise_for_status()
        time.sleep(2)
        self.wait()

    def restart_server(self) -> None:
        subprocess.run([str(self.ctl), "restart", "server"], check=True, capture_output=True)
        poll(lambda: self.client.get("/api/server/ping").status_code == 200, 120)
        self.login()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2288")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--nas", type=Path, required=True)
    parser.add_argument("--nfs-port", type=int, default=12049)
    parser.add_argument("--purge", action="store_true")
    args = parser.parse_args()

    immich = Instance(args.url, args.home)
    c = immich.client
    user_id = immich.login()
    mounts_dir = (args.home / "mounts").resolve()

    shutil.rmtree(args.nas, ignore_errors=True)
    (args.nas / "2024").mkdir(parents=True)
    for sample in SAMPLES:
        shutil.copy2(E2E / sample, args.nas / "2024" / Path(sample).name)
    (args.nas / "notes.txt").write_text("not a photo\n")
    before = snapshot(args.nas)
    nas = Nas(args.nas, args.nfs_port)

    print("== the feature")
    check("the server offers network shares", c.get("/api/server/features").json().get("networkShares") is True)
    check("none yet", immich.shares() == [])
    check("the web page is served", httpx.get(f"{args.url}/admin/network-shares").status_code == 200)

    print("== testing a share")
    test = c.post("/api/admin/network-shares/test", json={"host": "nas.invalid", "exportPath": "/photo"}).json()
    check("a host that does not resolve is unreachable", test["errorReason"] == "unreachable", test.get("message", ""))
    test = c.post("/api/admin/network-shares/test", json={"host": "127.0.0.1", "exportPath": "/"}).json()
    check("a NAS without NFS running is unreachable", test["errorReason"] == "unreachable", test.get("message", ""))
    nas.start()
    test = c.post("/api/admin/network-shares/test", json={"host": "127.0.0.1", "exportPath": "/volume1/nope"}).json()
    check("a folder the NAS does not have is not found", test["errorReason"] == "not-found", test.get("message", ""))

    def tested() -> dict[str, Any] | None:
        body = c.post("/api/admin/network-shares/test", json={"host": "127.0.0.1", "exportPath": "/"}).json()
        if body["success"]:
            return body
        if body["errorReason"] == "mac-permission":
            print("    macOS is asking whether node may access network volumes: click Allow", flush=True)
            return None
        return body

    test, took = poll(tested, 300, 5)
    check("a share that works lists its top level", bool(test) and test["success"] and test["entries"] == ["2024", "notes.txt"],
          f"{test} in {took:.0f}s")
    leftovers = [p.name for p in mounts_dir.iterdir()] if mounts_dir.exists() else []
    check("testing leaves nothing mounted or behind",
          not any(".test-" in path for path in nfs_mounts()) and not leftovers, f"folders: {leftovers}")

    print("== adding a share")
    bad = c.post("/api/admin/network-shares", json={"name": "Wrong", "host": "127.0.0.1", "exportPath": "/volume1/nope"})
    check("one that does not mount is refused, and not kept",
          bad.status_code == 400 and immich.shares() == [] and not any(mounts_dir.iterdir()), bad.text[:160])
    invalid = c.post("/api/admin/network-shares", json={"name": "X", "host": "bad host;rm", "exportPath": "/"})
    check("a host that is not one is refused", invalid.status_code == 400, invalid.text[:120])
    response = c.post("/api/admin/network-shares", json={"name": "NAS 照片", "host": "127.0.0.1", "exportPath": "/"})
    share = response.json()
    mount_path = str(mounts_dir / "NAS 照片")
    check("added and mounted", response.status_code == 201 and share["status"] == "mounted", response.text[:200])
    check("on a folder named after it, under the install", share["mountPath"] == mount_path, share["mountPath"])
    check("with its size", share.get("totalBytes", 0) > 0 and share.get("availableBytes", 0) > 0,
          f"{share.get('availableBytes')} of {share.get('totalBytes')}")
    options = nfs_mounts().get(mount_path, "")
    check("mounted soft, hidden from Finder", "nobrowse" in options or "dontbrowse" in options, options)
    duplicate = c.post("/api/admin/network-shares", json={"name": "NAS 照片", "host": "127.0.0.1", "exportPath": "/"})
    check("a second share with the same name is refused", duplicate.status_code == 400)

    print("== an external library on it")
    library = c.post("/api/libraries", json={"ownerId": user_id, "name": "NAS", "importPaths": [f"{mount_path}/2024"]})
    library.raise_for_status()
    library_id = library.json()["id"]
    immich.scan(library_id)
    assets = immich.library_assets(library_id)
    check("its photos are imported", len(assets) == len(SAMPLES) and not any(assets.values()), str(assets))
    check("the share lists the library", immich.share(share["id"])["libraries"] == ["NAS"])
    refused = c.delete(f"/api/admin/network-shares/{share['id']}")
    check("removing the share is refused while the library uses it", refused.status_code == 400, refused.text[:160])

    print("== unmounting it")
    response = c.post(f"/api/admin/network-shares/{share['id']}/unmount").json()
    check("unmounted, and stays so", response["status"] == "unmounted" and not response["enabled"]
          and mount_path not in nfs_mounts())
    immich.scan(library_id)
    assets = immich.library_assets(library_id)
    check("a scan keeps its photos online", len(assets) == len(SAMPLES) and not any(assets.values()), str(assets))
    time.sleep(70)
    check("the minute check leaves it unmounted", mount_path not in nfs_mounts())
    response = c.post(f"/api/admin/network-shares/{share['id']}/mount").json()
    check("mounted again", response["status"] == "mounted" and response["enabled"] and mount_path in nfs_mounts())

    print("== the NAS goes away")
    nas.stop()
    status, took = poll(lambda: (lambda s: s if s["status"] != "mounted" else None)(immich.share(share["id"])), 60)
    check("shown as not responding", bool(status) and status["status"] == "unresponsive", f"after {took:.0f}s")
    start = time.time()
    immich.scan(library_id)
    assets = immich.library_assets(library_id)
    check("a scan keeps its photos online", len(assets) == len(SAMPLES) and not any(assets.values()),
          f"{assets}, scan took {time.time() - start:.0f}s")
    responsive = c.get("/api/server/ping", timeout=10).status_code == 200
    check("the server still answers", responsive)

    print("== the NAS comes back")
    nas.start()
    # two minute checks without an answer unmount it, then each check tries to mount it
    status, took = poll(lambda: immich.share(share["id"])["status"] == "mounted", 300, 5)
    check("mounted again by itself", bool(status), f"after {took:.0f}s")
    immich.scan(library_id)
    assets = immich.library_assets(library_id)
    check("its photos are all there, online", len(assets) == len(SAMPLES) and not any(assets.values()), str(assets))

    print("== the mount drops")
    subprocess.run(["/sbin/umount", "-f", mount_path], check=True)
    mounted, took = poll(lambda: mount_path in nfs_mounts(), 90, 3)
    check("the minute check mounts it again", bool(mounted), f"after {took:.0f}s")

    print("== the server restarts")
    subprocess.run(["/sbin/umount", "-f", mount_path], check=True)
    immich.restart_server()
    mounted, took = poll(lambda: mount_path in nfs_mounts(), 60, 2)
    check("mounted when the server starts", bool(mounted), f"{took:.0f}s after it answered")

    print("== changing it")
    response = c.put(f"/api/admin/network-shares/{share['id']}", json={"name": "群晖"}).json()
    check("renamed, on the same folder", response["name"] == "群晖" and response["mountPath"] == mount_path)
    response = c.put(f"/api/admin/network-shares/{share['id']}", json={"readOnly": True}).json()
    options = nfs_mounts().get(mount_path, "")
    check("read only: mounted again read only", response["status"] == "mounted" and "read-only" in options, options)
    response = c.put(f"/api/admin/network-shares/{share['id']}", json={"readOnly": False}).json()
    options = nfs_mounts().get(mount_path, "")
    check("read-write again", response["status"] == "mounted" and "read-only" not in options, options)

    print("== removing it")
    c.delete(f"/api/libraries/{library_id}").raise_for_status()
    immich.wait()
    response = c.delete(f"/api/admin/network-shares/{share['id']}")
    check("removed once no library uses it", response.status_code == 204, response.text[:160])
    check("unmounted, and its folder removed", mount_path not in nfs_mounts() and not Path(mount_path).exists())
    check("none left", immich.shares() == [])
    check("the files on the NAS are untouched", snapshot(args.nas) == before)

    log = args.home / "logs/server.log"
    if log.exists():
        lines = [line for line in log.read_text(errors="replace").splitlines() if "network share" in line.lower()]
        print("== server log\n" + "\n".join(f"    {line[-160:]}" for line in lines[-12:]))

    if args.purge:
        print("== uninstall --purge with a share mounted")
        response = c.post("/api/admin/network-shares", json={"name": "purge", "host": "127.0.0.1", "exportPath": "/"})
        check("mounted before", response.status_code == 201 and response.json()["status"] == "mounted")
        out = subprocess.run([str(immich.ctl), "uninstall", "--purge"], capture_output=True, text=True)
        check("uninstalled", out.returncode == 0, (out.stdout + out.stderr).strip().splitlines()[-1])
        check("nothing left mounted", not any(str(mounts_dir) in path for path in nfs_mounts()))
        check("the install is gone", not args.home.exists())
        check("the files on the NAS are untouched", snapshot(args.nas) == before)

    nas.stop()
    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
