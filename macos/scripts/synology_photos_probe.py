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
  folders.json         the folders those items are in (personal space and shared space; others' are refused, 642)
  sharing.json         who each album is shared with and how, as each of two calls answers
  users.json           the users and groups an album may be shared with
  user_settings.json, team_space.json   the account's and the shared space's settings
  errors.json          every call that failed, with Synology's error code
  summary.json         the shape of all that, without any name, filename, path or passphrase
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

        # who an album is shared with, and how: the earlier probe's call answered an empty list for every album, so
        # each of the ways Synology's own web page may use is tried, and what each answers is kept
        sharing = {}
        for album in albums:
            if not album.get("passphrase"):
                continue
            tries = {
                "album_get": syno.call(
                    "SYNO.Foto.Browse.Album", "get", 2, id=[album["id"]], additional=["sharing_info"]
                ),
                "passphrase_get": syno.call("SYNO.Foto.Sharing.Passphrase", "get", 1, passphrase=album["passphrase"]),
            }
            sharing[album["id"]] = {name: body for name, body in tries.items() if body.get("success")}
        save(out, "sharing.json", sharing)
        save(out, "users.json", syno.call("SYNO.Foto.Sharing.Misc", "list_user_group", 1, team_space_sharable=False))
        save(out, "user_settings.json", syno.call("SYNO.Foto.Setting.User", "get", 1))
        save(out, "team_space.json", syno.call("SYNO.Foto.Setting.TeamSpace", "get", 1))

        save(out, "summary.json", summarize(albums, shared, out, folders, sharing))
    finally:
        syno.call("SYNO.API.Auth", "logout", auth_version, session="ImmichProbe")
        save(out, "errors.json", syno.errors)

    print(f"done: {out} ({len(syno.errors)} calls failed, see errors.json)")
    print("summary.json has no names, filenames or paths: it is what may go into the repository")


def summarize(albums, shared, out, folders, sharing):
    """The shape of what was read, with no name, filename, path or passphrase in it"""
    me = None
    items_by_owner, item_keys, additional_keys, types = {}, set(), set(), {}
    with_size = with_time = with_folder = 0
    total = 0
    for album in albums:
        me = me or album.get("owner_user_id")
        with open(os.path.join(out, f"items/{album['id']}.json"), encoding="utf-8") as f:
            items = json.load(f)
        for item in items:
            total += 1
            owner = "me" if item.get("owner_user_id") == me else f"user {item.get('owner_user_id')}"
            items_by_owner[owner] = items_by_owner.get(owner, 0) + 1
            item_keys |= set(item)
            additional_keys |= set(item.get("additional", {}))
            types[item.get("type")] = types.get(item.get("type"), 0) + 1
            with_size += "filesize" in item
            with_time += "time" in item
            with_folder += "folder_id" in item
    roots = {}
    for folder in folders.values():
        depth = len([part for part in folder.get("name", "").split("/") if part])
        key = f"{folder['api']} depth {depth}"
        roots[key] = roots.get(key, 0) + 1
    return {
        "albums": len(albums),
        "albums_shared_by_link": sum(1 for a in albums if a.get("passphrase")),
        "albums_shared_with_me": len(shared),
        "album_keys": sorted({k for a in albums for k in a}),
        "album_additional_keys": sorted({k for a in albums for k in a.get("additional", {})}),
        "items": total,
        "items_by_owner": items_by_owner,
        "item_types": types,
        "item_keys": sorted(item_keys),
        "item_additional_keys": sorted(additional_keys),
        "items_with_filesize_time_folder": [with_size, with_time, with_folder],
        "folders_by_api_and_depth": roots,
        "folder_keys": sorted({k for f in folders.values() for k in f}),
        "sharing_answered_by": {
            name: sum(1 for s in sharing.values() if name in s) for name in ("album_get", "passphrase_get")
        },
        "sharing_shape": {
            name: shape(next((s[name]["data"] for s in sharing.values() if name in s), None))
            for name in ("album_get", "passphrase_get")
        },
    }


def shape(value, depth=8):
    """The keys and types of a JSON value, without the values"""
    if depth == 0:
        return type(value).__name__
    if isinstance(value, dict):
        return {key: shape(item, depth - 1) for key, item in value.items()}
    if isinstance(value, list):
        return [shape(value[0], depth - 1)] if value else []
    return type(value).__name__


if __name__ == "__main__":
    main()
