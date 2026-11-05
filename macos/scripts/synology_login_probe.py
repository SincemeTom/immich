#!/usr/bin/env python3
"""Which login a NAS account may use: tries the photo app's Web API login with a few session names, as error 402
(permission denied) for accounts that are not administrators may come from the session name the server sends.

Stops at the first that works (at most 5 tries, under DSM's default of 10 failed logins in 5 minutes before an IP is
blocked); for it, reads who the account is in the photo app, then logs out. The password is asked for, not echoed,
and sent in the POST body only. Nothing on the NAS is changed.

Usage: macos/scripts/synology_login_probe.py https://nas.example.com:5001 ACCOUNT [--insecure]
"""

import getpass
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

# (path, session): what the server sends now first, then what the NAS's own apps send
TRIES = [
    ("/webapi/entry.cgi", "Immich"),
    ("/webapi/entry.cgi", "SynologyPhotos"),
    ("/webapi/entry.cgi", "webui"),
    ("/photo/webapi/entry.cgi", "SynologyPhotos"),
    ("/webapi/entry.cgi", None),
]

AUTH_ERRORS = {
    400: "wrong account or password",
    401: "account disabled",
    402: "permission denied",
    403: "2-step verification code needed (the login itself was let in)",
    404: "wrong 2-step verification code",
    406: "2-step verification must be set up first",
    407: "this IP is blocked",
    408: "password expired",
    409: "password expired",
    410: "password must be changed",
}


def post(context, url, params, sid=None):
    if sid:
        params = {**params, "_sid": sid}
    data = urllib.parse.urlencode(params).encode()
    request = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        return json.loads(response.read().decode())


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__.strip().splitlines()[-1])
        sys.exit(64)
    base, account = args[0].rstrip("/"), args[1]
    if "://" not in base:
        base = "https://" + base
    context = ssl.create_default_context()
    if "--insecure" in sys.argv:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    password = getpass.getpass(f"Password for {account}: ")

    for path, session in TRIES:
        url = base + path
        label = f"{path} session={session or '(none)'}"
        params = {"api": "SYNO.API.Auth", "version": "6", "method": "login", "account": account,
                  "passwd": password, "format": "sid"}
        if session:
            params["session"] = session
        try:
            answer = post(context, url, params)
        except urllib.error.HTTPError as error:
            print(f"  {label}: HTTP {error.code}")
            continue
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            print(f"  {label}: {error}")
            continue

        if not answer.get("success"):
            code = (answer.get("error") or {}).get("code")
            print(f"  {label}: error {code} - {AUTH_ERRORS.get(code, 'unknown')}")
            if code in (400, 401, 407, 408, 409, 410):
                print("stopped: this is about the account, not how it logs in")
                return
            if code == 403:
                print(f"\n=> {label} lets the account in (it asks for its code next)")
                return
            continue

        sid = answer["data"]["sid"]
        try:
            me = post(context, base + "/webapi/entry.cgi",
                      {"api": "SYNO.Foto.UserInfo", "version": "1", "method": "me"}, sid)
            photos = (f"photo app user id {me['data'].get('id')}" if me.get("success")
                      else f"photo app error {(me.get('error') or {}).get('code')}")
        finally:
            logout = {"api": "SYNO.API.Auth", "version": "6", "method": "logout"}
            if session:
                logout["session"] = session
            try:
                post(context, url, logout, sid)
            except Exception:  # noqa: BLE001 - only tidying up
                pass
        print(f"  {label}: logged in, {photos}")
        print(f"\n=> {label} works")
        return

    print("\n=> none worked")


if __name__ == "__main__":
    main()
