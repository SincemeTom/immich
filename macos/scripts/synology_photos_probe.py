#!/usr/bin/env python3
"""Reads what the Synology Photos sync will need, from the user's own Synology, without changing anything there.

Run it in a terminal; it asks for the address, the account and the password (and the 2-step code if asked), and
writes what Synology answered to ~/Documents/immich-scratch/synology/<time>/, outside the repository (filenames, names
and album titles are private). Nothing is sent anywhere else, and the password is not written.

    python3 macos/scripts/synology_photos_probe.py

What it reads:
  apis.json            the SYNO.Foto* / SYNO.FotoTeam* APIs and their versions
  me.json              the account
  albums.json          the albums of the account, with their sharing
  shared_with_me.json  the albums others share with the account
  items/<album>.json   what is in each album (filename, size, time taken, folder)
  folders.json         the folders those items are in (personal space and shared space)
  errors.json          every call that failed, with Synology's error code
"""

import getpass
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ITEM_ADDITIONAL = ["resolution", "orientation", "video_meta", "provider_user_id", "exif", "thumbnail"]
ALBUM_ADDITIONAL = ["sharing_info", "thumbnail", "provider_count"]
PAGE = 500


class Synology:
    def __init__(self, base, verify):
        self.base = base.rstrip("/")
        self.sid = None
        self.errors = []
        self.context = None if verify else ssl._create_unverified_context()

    def call(self, api, method, version, **params):
        query = {"api": api, "method": method, "version": str(version)}
        for key, value in params.items():
            query[key] = json.dumps(value) if isinstance(value, (list, dict)) else str(value)
        if self.sid:
            query["_sid"] = self.sid
        request = urllib.request.Request(
            f"{self.base}/webapi/entry.cgi",
            data=urllib.parse.urlencode(query).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=60) as response:
                body = json.loads(response.read().decode())
        except (urllib.error.URLError, ValueError) as error:
            body = {"success": False, "error": {"code": -1, "message": str(error)}}
        if not body.get("success"):
            self.errors.append({"api": api, "method": method, "version": version, "error": body.get("error")})
        return body

    def pages(self, api, method, version, key, **params):
        everything, offset = [], 0
        while True:
            body = self.call(api, method, version, offset=offset, limit=PAGE, **params)
            if not body.get("success"):
                return everything, body
            page = body.get("data", {}).get(key, [])
            everything += page
            if len(page) < PAGE:
                return everything, body
            offset += PAGE


def save(folder, name, data):
    path = os.path.join(folder, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main():
    base = input("Synology address (e.g. https://192.168.1.10:5001): ").strip()
    if not base.startswith("http"):
        base = "https://" + base
    verify = input("Check its HTTPS certificate? [y/N, no for a self-signed one]: ").strip().lower() == "y"
    account = input("Account: ").strip()
    password = getpass.getpass("Password (not shown, not saved): ")

    syno = Synology(base, verify)
    out = os.path.expanduser(f"~/Documents/immich-scratch/synology/{time.strftime('%Y%m%d-%H%M%S')}")
    os.makedirs(out, exist_ok=True)

    info = syno.call("SYNO.API.Info", "query", 1, query="SYNO.API.Auth,SYNO.Foto.,SYNO.FotoTeam.")
    save(out, "apis.json", info)
    auth_version = min(info.get("data", {}).get("SYNO.API.Auth", {}).get("maxVersion", 6), 7)

    login = dict(account=account, passwd=password, session="ImmichProbe", format="sid")
    body = syno.call("SYNO.API.Auth", "login", auth_version, **login)
    if not body.get("success") and body.get("error", {}).get("code") in (403, 406):
        login["otp_code"] = input("2-step verification code: ").strip()
        body = syno.call("SYNO.API.Auth", "login", auth_version, **login)
    del password, login
    if not body.get("success"):
        print(f"cannot log in: {body.get('error')}", file=sys.stderr)
        save(out, "errors.json", syno.errors)
        sys.exit(1)
    syno.sid = body["data"]["sid"]
    print(f"logged in (Auth v{auth_version}); writing to {out}")

    try:
        save(out, "me.json", syno.call("SYNO.Foto.UserInfo", "me", 1))

        albums, last = syno.pages("SYNO.Foto.Browse.Album", "list", 2, "list", additional=ALBUM_ADDITIONAL)
        if not albums and not last.get("success"):
            albums, last = syno.pages("SYNO.Foto.Browse.Album", "list", 1, "list", additional=ALBUM_ADDITIONAL)
        save(out, "albums.json", albums)
        print(f"{len(albums)} albums")

        shared, _ = syno.pages(
            "SYNO.Foto.Sharing.Misc", "list_shared_with_me_album", 2, "list", additional=ALBUM_ADDITIONAL
        )
        save(out, "shared_with_me.json", shared)
        print(f"{len(shared)} albums shared with the account")

        folder_ids = {}
        for album in albums + shared:
            items, _ = syno.pages(
                "SYNO.Foto.Browse.Item", "list", 1, "list", album_id=album["id"], additional=ITEM_ADDITIONAL
            )
            if not items and album.get("passphrase"):
                items, _ = syno.pages(
                    "SYNO.Foto.Browse.Item", "list", 1, "list", passphrase=album["passphrase"],
                    additional=ITEM_ADDITIONAL,
                )
            save(out, f"items/{album['id']}.json", items)
            for item in items:
                if "folder_id" in item:
                    folder_ids.setdefault(item["folder_id"], item.get("owner_user_id"))
            print(f"  album {album['id']}: {len(items)} items (says {album.get('item_count')})")

        folders = {}
        for folder_id in sorted(folder_ids):
            for api in ("SYNO.Foto.Browse.Folder", "SYNO.FotoTeam.Browse.Folder"):
                body = syno.call(api, "get", 1, id=folder_id)
                if body.get("success"):
                    folders[folder_id] = {"api": api, **body["data"].get("folder", body["data"])}
                    break
        save(out, "folders.json", folders)
        print(f"{len(folders)} of {len(folder_ids)} folders read")
    finally:
        syno.call("SYNO.API.Auth", "logout", auth_version, session="ImmichProbe")
        save(out, "errors.json", syno.errors)

    print(f"done: {out} ({len(syno.errors)} calls failed, see errors.json)")


if __name__ == "__main__":
    main()
