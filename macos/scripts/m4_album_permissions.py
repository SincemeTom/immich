"""M4: end-to-end check of shared album permissions through the public API.

Signs up (or logs in) an admin, makes four users and shares an album of the admin's with them, one of each kind of
member: a viewer, a viewer allowed to download (downloader), an editor and a manager. Then checks what each can do:
see the photos, download the originals (one, or the album), add and remove photos, rename the album, manage its
members and shared links, delete it. Takes the album, the photos and the users away at the end.

Usage (python with httpx and pillow, e.g. uv run --with httpx --with pillow):
  m4_album_permissions.py --url http://127.0.0.1:2283 --email admin@example.com --password ...
"""

from __future__ import annotations

import argparse
import io
import secrets
import sys
import time
from datetime import UTC, datetime
from typing import Any

import httpx
from PIL import Image

results: list[tuple[str, bool, str]] = []
PASSWORD = "m4-album-permissions"


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}")
    return ok


def login(client: httpx.Client, email: str, password: str, sign_up: bool = False) -> str:
    if sign_up and not client.get("/api/server/config").json().get("isInitialized"):
        client.post(
            "/api/auth/admin-sign-up", json={"email": email, "name": "Admin", "password": password}
        ).raise_for_status()
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    response.raise_for_status()
    token: str = response.json()["accessToken"]
    return token


def photo(color: tuple[int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (640, 480), color).save(buffer, "JPEG", quality=90)
    return buffer.getvalue()


def upload(client: httpx.Client, token: str, name: str, color: tuple[int, int, int]) -> str:
    now = datetime.now(UTC).isoformat()
    response = client.post(
        "/api/assets",
        headers={"Authorization": f"Bearer {token}"},
        data={"fileCreatedAt": now, "fileModifiedAt": now, "filename": name},
        files={"assetData": (name, photo(color), "image/jpeg")},
    )
    response.raise_for_status()
    asset_id: str = response.json()["id"]
    return asset_id


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:2283")
    parser.add_argument("--email", required=True, help="an admin's; signed up if the instance has none yet")
    parser.add_argument("--password", required=True)
    args = parser.parse_args()

    client = httpx.Client(base_url=args.url, timeout=60)
    admin_token = login(client, args.email, args.password, sign_up=True)
    as_admin = {"Authorization": f"Bearer {admin_token}"}

    run = secrets.token_hex(3)
    kinds = ["viewer", "downloader", "editor", "manager", "invitee"]
    users: dict[str, dict[str, Any]] = {}
    tokens: dict[str, dict[str, str]] = {}
    album_id = None
    assets: list[tuple[str, str]] = []
    try:
        for kind in kinds:
            email = f"m4-{kind}-{run}@example.com"
            response = client.post(
                "/api/admin/users",
                headers=as_admin,
                json={"email": email, "name": f"M4 {kind}", "password": PASSWORD, "shouldChangePassword": False},
            )
            response.raise_for_status()
            users[kind] = response.json()
            tokens[kind] = {"Authorization": f"Bearer {login(client, email, PASSWORD)}"}

        owner_photo = upload(client, admin_token, f"m4-owner-{run}.jpg", (200, 90, 90))
        assets.append((admin_token, owner_photo))
        editor_photo = upload(
            client, tokens["editor"]["Authorization"].split()[1], f"m4-editor-{run}.jpg", (90, 200, 90)
        )
        assets.append((tokens["editor"]["Authorization"].split()[1], editor_photo))

        response = client.post(
            "/api/albums",
            headers=as_admin,
            json={
                "albumName": f"M4 permissions {run}",
                "assetIds": [owner_photo],
                "albumUsers": [
                    {"userId": users["viewer"]["id"], "role": "viewer"},
                    {"userId": users["downloader"]["id"], "role": "viewer", "allowDownload": True},
                    {"userId": users["editor"]["id"], "role": "editor"},
                    {"userId": users["manager"]["id"], "role": "editor", "isManager": True},
                ],
            },
        )
        response.raise_for_status()
        album = response.json()
        album_id = album["id"]
        members = {member["user"]["id"]: member for member in album["albumUsers"]}

        print("members, as returned")
        expected = {
            "viewer": ("viewer", False, False),
            "downloader": ("viewer", True, False),
            "editor": ("editor", True, False),
            "manager": ("editor", True, True),
        }
        for kind, (role, download, manager) in expected.items():
            member = members[users[kind]["id"]]
            check(
                f"{kind}: {role}, download {download}, manager {manager}",
                (member["role"], member["allowDownload"], member["isManager"]) == (role, download, manager),
                f"{member['role']}, {member['allowDownload']}, {member['isManager']}",
            )

        # the preview is made in the background, after the upload
        for _ in range(60):
            if (
                client.get(
                    f"/api/assets/{owner_photo}/thumbnail", params={"size": "preview"}, headers=as_admin
                ).status_code
                == 200
            ):
                break
            time.sleep(1)

        print("seeing and downloading the owner's photo")
        for kind in ["viewer", "downloader", "editor", "manager"]:
            headers = tokens[kind]
            preview = client.get(f"/api/assets/{owner_photo}/thumbnail", params={"size": "preview"}, headers=headers)
            original = client.get(f"/api/assets/{owner_photo}/original", headers=headers)
            fullsize = client.get(f"/api/assets/{owner_photo}/thumbnail", params={"size": "fullsize"}, headers=headers)
            archive = client.post("/api/download/info", json={"albumId": album_id}, headers=headers)
            can = kind != "viewer"
            location = fullsize.headers.get("location", "")
            check(f"{kind} sees the preview", preview.status_code == 200, str(preview.status_code))
            check(
                f"{kind} {'downloads' if can else 'cannot download'} the original",
                (original.status_code == 200) == can,
                str(original.status_code),
            )
            # the full size of a JPEG is its original, for who can download it; the preview otherwise
            check(
                f"{kind}'s full size is {'the original' if can else 'the preview'}",
                fullsize.is_redirect and (("original" in location) == can) and (can or "size=preview" in location),
                f"{fullsize.status_code} {location}",
            )
            check(
                f"{kind} {'downloads' if can else 'cannot download'} the album",
                (archive.status_code == 201) == can,
                str(archive.status_code),
            )

        print("adding and removing photos")
        for kind in ["viewer", "downloader"]:
            response = client.put(f"/api/albums/{album_id}/assets", json={"ids": [owner_photo]}, headers=tokens[kind])
            check(f"{kind} cannot add photos", response.status_code == 400, str(response.status_code))
        response = client.put(f"/api/albums/{album_id}/assets", json={"ids": [editor_photo]}, headers=tokens["editor"])
        check(
            "editor adds a photo of theirs",
            response.status_code == 200 and response.json()[0]["success"],
            response.text,
        )
        response = client.request(
            "DELETE", f"/api/albums/{album_id}/assets", json={"ids": [owner_photo]}, headers=tokens["editor"]
        )
        check(
            "editor cannot remove the owner's photo",
            response.status_code == 200 and response.json()[0].get("error") == "no_permission",
            response.text,
        )
        response = client.request(
            "DELETE", f"/api/albums/{album_id}/assets", json={"ids": [editor_photo]}, headers=tokens["manager"]
        )
        check(
            "manager removes the editor's photo",
            response.status_code == 200 and response.json()[0]["success"],
            response.text,
        )

        print("managing the album")
        response = client.patch(f"/api/albums/{album_id}", json={"albumName": "renamed"}, headers=tokens["editor"])
        check("editor cannot rename the album", response.status_code == 400, str(response.status_code))
        response = client.patch(
            f"/api/albums/{album_id}", json={"description": "by the manager"}, headers=tokens["manager"]
        )
        check("manager changes the description", response.status_code == 200, str(response.status_code))
        response = client.put(
            f"/api/albums/{album_id}/users",
            json={"albumUsers": [{"userId": users["invitee"]["id"], "role": "viewer"}]},
            headers=tokens["editor"],
        )
        check("editor cannot invite", response.status_code == 400, str(response.status_code))
        response = client.put(
            f"/api/albums/{album_id}/users",
            json={"albumUsers": [{"userId": users["invitee"]["id"], "role": "viewer"}]},
            headers=tokens["manager"],
        )
        check("manager invites", response.status_code == 200, str(response.status_code))
        response = client.put(
            f"/api/albums/{album_id}/user/{users['invitee']['id']}", json={"role": "editor"}, headers=tokens["editor"]
        )
        check("editor cannot change a role", response.status_code == 400, str(response.status_code))
        response = client.put(
            f"/api/albums/{album_id}/user/{users['invitee']['id']}",
            json={"role": "viewer", "allowDownload": True},
            headers=tokens["manager"],
        )
        check("manager lets a viewer download", response.status_code == 204, str(response.status_code))
        response = client.put(
            f"/api/albums/{album_id}/user/{users['downloader']['id']}", json={"role": "viewer"}, headers=as_admin
        )
        members = {
            m["user"]["id"]: m for m in client.get(f"/api/albums/{album_id}", headers=as_admin).json()["albumUsers"]
        }
        check(
            "a viewer keeps downloading when the role is set again without it",
            response.status_code == 204 and members[users["downloader"]["id"]]["allowDownload"],
            str(members[users["downloader"]["id"]]),
        )
        check("the invited viewer downloads", members[users["invitee"]["id"]]["allowDownload"])
        response = client.request(
            "DELETE", f"/api/albums/{album_id}/user/{users['invitee']['id']}", headers=tokens["editor"]
        )
        check("editor cannot remove a member", response.status_code == 400, str(response.status_code))
        response = client.request(
            "DELETE", f"/api/albums/{album_id}/user/{users['invitee']['id']}", headers=tokens["manager"]
        )
        check("manager removes a member", response.status_code == 204, str(response.status_code))
        response = client.request(
            "DELETE", f"/api/albums/{album_id}/user/{users['viewer']['id']}", headers=tokens["viewer"]
        )
        check("a viewer leaves", response.status_code == 204, str(response.status_code))
        response = client.request(
            "DELETE", f"/api/albums/{album_id}/user/{album['albumUsers'][0]['user']['id']}", headers=tokens["manager"]
        )
        check("manager cannot remove the owner", response.status_code == 400, str(response.status_code))

        for kind, can in [("editor", False), ("manager", True)]:
            response = client.post(
                "/api/shared-links", json={"type": "ALBUM", "albumId": album_id}, headers=tokens[kind]
            )
            check(
                f"{kind} {'makes' if can else 'cannot make'} a shared link",
                (response.status_code == 201) == can,
                str(response.status_code),
            )
            if response.status_code == 201:
                client.delete(f"/api/shared-links/{response.json()['id']}", headers=tokens[kind])

        response = client.delete(f"/api/albums/{album_id}", headers=tokens["manager"])
        check("manager cannot delete the album", response.status_code == 400, str(response.status_code))
    finally:
        if album_id:
            client.delete(f"/api/albums/{album_id}", headers=as_admin)
        for token, asset_id in assets:
            client.request(
                "DELETE",
                "/api/assets",
                json={"ids": [asset_id], "force": True},
                headers={"Authorization": f"Bearer {token}"},
            )
        for user in users.values():
            client.request("DELETE", f"/api/admin/users/{user['id']}", json={"force": True}, headers=as_admin)

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
