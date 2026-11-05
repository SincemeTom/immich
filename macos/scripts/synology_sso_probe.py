#!/usr/bin/env python3
"""Can Synology's own SSO Server stand in for a password, for the Synology Photos album sync?  Read-only.

Two rounds, each with its own browser login, as an authorization code can be used once:

  1. the code itself to SYNO.API.Auth login v7 (`type=code`, PKCE), as DSM's own SSO login may do;
  2. the code to the SSO Server's token endpoint, then the access token to Synology Photos, three ways.

Whichever gives a Synology session reads who the account is and how many albums it has. The session is then kept
(mode 0600, outside the repository) and not logged out, so that `--recheck`, run the next day, tells whether it still
works: what decides whether SSO could be used without anyone there at 3 in the morning.

Needs an OIDC application in SSO Server (Application Portal > SSO Server > Application, or SSO Server > Application
list), with a redirect URI this script can listen on: http://127.0.0.1:8765/callback. Another redirect URI works too:
paste the address the browser ends up on. Not Immich's own: Immich would use the code first.

Nothing on Synology is changed. A failed login may count towards DSM's auto block, so at most 4 logins are tried.

results.json has no token, code, secret, sid, name or e-mail: names of fields, error codes, times. session.json has
the sid: delete it, or run --recheck, which logs it out.

usage: synology_sso_probe.py            # the two rounds
       synology_sso_probe.py --recheck  # whether the kept session still works, then log it out
"""
import base64
import getpass
import hashlib
import http.server
import json
import os
import secrets
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.home() / "Documents" / "immich-scratch" / "synology"
SESSION_FILE = ROOT / "sso-session.json"
SESSION = "ImmichSsoProbe"
LISTEN = ("127.0.0.1", 8765)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def keys(value):
    """the shape of a JSON value without any of its values"""
    if isinstance(value, dict):
        return {k: keys(v) for k, v in value.items()}
    if isinstance(value, list):
        return [keys(value[0])] if value else []
    return type(value).__name__


class Client:
    def __init__(self, base, verify):
        self.base = base.rstrip("/")
        self.context = ssl.create_default_context() if verify else ssl._create_unverified_context()

    def request(self, url, data=None, headers=None):
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        request = urllib.request.Request(url, data=body, headers=headers or {})
        if body is not None:
            request.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=60) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode(errors="replace")

    def call(self, api, method, version, sid=None, headers=None, path="entry.cgi", **params):
        data = {"api": api, "method": method, "version": str(version)}
        for key, value in params.items():
            if value is not None:
                data[key] = json.dumps(value) if isinstance(value, (list, dict)) else str(value)
        if sid:
            data["_sid"] = sid
        status, text = self.request(f"{self.base}/webapi/{path}", data, headers)
        try:
            return json.loads(text)
        except ValueError:
            return {"success": False, "error": {"code": f"HTTP {status}, not JSON"}}


def error_of(body):
    return None if body.get("success") else body.get("error", {}).get("code")


def read_photos(client, sid, headers=None):
    """who the account is in Synology Photos, and how many albums it has: only counts are kept"""
    me = client.call("SYNO.Foto.UserInfo", "me", 1, sid=sid, headers=headers)
    result = {"me": error_of(me) or "ok", "me_fields": sorted(me.get("data", {}).keys())}
    if me.get("success"):
        albums = client.call("SYNO.Foto.Browse.Album", "list", 2, sid=sid, headers=headers, offset=0, limit=500)
        result["albums"] = error_of(albums) or len(albums.get("data", {}).get("list", []))
    return result


def wait_for_code(authorize_url, redirect_uri, state):
    parsed = urllib.parse.urlparse(redirect_uri)
    received = {}
    if parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost") and parsed.port == LISTEN[1]:

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                received.update({k: v[0] for k, v in query.items()})
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write("Done, you can close this tab and go back to the terminal.\n".encode())

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(LISTEN, Handler)
        thread = threading.Thread(target=server.handle_request, daemon=True)
        thread.start()
        print(f"\nopen this in the browser, and log in (it should open by itself):\n\n  {authorize_url}\n")
        webbrowser.open(authorize_url)
        thread.join(timeout=300)
        server.server_close()
        if not received:
            sys.exit("no answer within 5 minutes")
    else:
        print(f"\nopen this in the browser, and log in:\n\n  {authorize_url}\n")
        webbrowser.open(authorize_url)
        pasted = input("paste the whole address the browser ended up on: ").strip()
        received = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(pasted).query).items()}

    if received.get("error"):
        sys.exit(f"SSO Server refused: {received.get('error')} {received.get('error_description', '')}")
    if received.get("state") != state:
        sys.exit("the state did not come back: not this login's answer")
    if not received.get("code"):
        sys.exit("no code in the answer")
    return received["code"]


def authorize(config, client_id, redirect_uri):
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email groups",
            "state": state,
            "nonce": secrets.token_urlsafe(16),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    code = wait_for_code(f"{config['authorization_endpoint']}?{query}", redirect_uri, state)
    return code, verifier


def keep_session(base, verify, sid, how, auth_version, auth_path):
    ROOT.mkdir(parents=True, exist_ok=True)
    SESSION_FILE.write_text(
        json.dumps(
            {
                "base": base,
                "verify": verify,
                "sid": sid,
                "how": how,
                "auth_version": auth_version,
                "auth_path": auth_path,
                "at": now(),
            }
        )
    )
    os.chmod(SESSION_FILE, 0o600)


def probe():
    base = input("DSM address, such as https://nas.example.com:5001: ").strip()
    if not base:
        sys.exit("no address")
    verify = input("check the HTTPS certificate? [Y/n]: ").strip().lower() != "n"
    client = Client(base, verify)

    status, text = client.request(f"{client.base}/webman/sso/.well-known/openid-configuration")
    if status != 200:
        sys.exit(f"no OpenID configuration at {base} (HTTP {status})")
    config = json.loads(text)

    client_id = input("SSO Server application ID (client_id): ").strip()
    client_secret = getpass.getpass("its secret (client_secret, not shown): ")
    redirect_uri = (
        input(f"redirect URI [http://127.0.0.1:{LISTEN[1]}/callback]: ").strip()
        or f"http://127.0.0.1:{LISTEN[1]}/callback"
    )

    info = client.call("SYNO.API.Info", "query", 1, query="SYNO.API.Auth")
    auth = info.get("data", {}).get("SYNO.API.Auth", {})
    auth_version = min(auth.get("maxVersion", 6), 7)
    auth_path = auth.get("path", "entry.cgi")
    results = {
        "at": now(),
        "auth_version": auth_version,
        "auth_path": auth_path,
        "openid_configuration": sorted(config.keys()),
        "grant_types": config.get("grant_types_supported"),
        "scopes": config.get("scopes_supported"),
        "rounds": {},
    }
    logins = 0
    session = None

    print("\nround 1 of 2: the code itself to DSM's login")
    code, verifier = authorize(config, client_id, redirect_uri)
    round1 = []
    for extra in ({}, {"client_id": client_id, "redirect_uri": redirect_uri}):
        logins += 1
        body = client.call(
            "SYNO.API.Auth",
            "login",
            auth_version,
            path=auth_path,
            type="code",
            code=code,
            code_verifier=verifier,
            session=SESSION,
            format="sid",
            **extra,
        )
        attempt = {"with": sorted(extra.keys()), "error": error_of(body), "fields": sorted(body.get("data", {}).keys())}
        round1.append(attempt)
        sid = body.get("data", {}).get("sid")
        if sid:
            attempt["photos"] = read_photos(client, sid)
            session = session or ("code to SYNO.API.Auth login", sid)
            break
        # a code DSM did take but refused is used up: no point in a second try
        if error_of(body) not in (101, 114, 120):
            break
    results["rounds"]["code_to_dsm_login"] = round1
    print(f"  {json.dumps(round1)}")

    print("\nround 2 of 2: the code to SSO Server, then its token to Synology Photos")
    code, verifier = authorize(config, client_id, redirect_uri)
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    status, text = client.request(
        config["token_endpoint"],
        {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri, "code_verifier": verifier},
        {"Authorization": f"Basic {basic}"},
    )
    del client_secret
    try:
        tokens = json.loads(text)
    except ValueError:
        tokens = {}
    round2 = {
        "token_endpoint": status,
        "token_fields": keys(tokens),
        "expires_in": tokens.get("expires_in"),
        "refresh_token": "refresh_token" in tokens,
        "error": tokens.get("error"),
    }
    access_token = tokens.get("access_token")
    if access_token:
        status, text = client.request(config["userinfo_endpoint"], headers={"Authorization": f"Bearer {access_token}"})
        round2["userinfo"] = status
        attempts = {}
        attempts["bearer_header"] = read_photos(client, None, {"Authorization": f"Bearer {access_token}"})
        attempts["as_sid"] = read_photos(client, access_token)
        if logins < 4:
            logins += 1
            body = client.call(
                "SYNO.API.Auth",
                "login",
                auth_version,
                path=auth_path,
                type="token",
                access_token=access_token,
                session=SESSION,
                format="sid",
            )
            attempt = {"error": error_of(body), "fields": sorted(body.get("data", {}).keys())}
            sid = body.get("data", {}).get("sid")
            if sid:
                attempt["photos"] = read_photos(client, sid)
                session = session or ("access token to SYNO.API.Auth login", sid)
            attempts["login_with_access_token"] = attempt
        round2["attempts"] = attempts
    results["rounds"]["code_to_token_endpoint"] = round2
    print(f"  {json.dumps(round2)}")
    results["logins_tried"] = logins

    out = ROOT / f"sso-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    if session:
        how, sid = session
        keep_session(client.base, verify, sid, how, auth_version, auth_path)
        results["session"] = {"how": how, "kept": str(SESSION_FILE)}
        print(f"\na Synology session, by {how}: kept for --recheck in {SESSION_FILE}")
        print("run `synology_sso_probe.py --recheck` tomorrow, and the day after")
    else:
        print("\nno Synology session came out of SSO")
    (out / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
    print(f"done: {out}/results.json (no token, code, secret, sid, name or e-mail)")


def recheck():
    if not SESSION_FILE.exists():
        sys.exit(f"no session kept: {SESSION_FILE}")
    kept = json.loads(SESSION_FILE.read_text())
    client = Client(kept["base"], kept["verify"])
    age = datetime.now(timezone.utc) - datetime.fromisoformat(kept["at"])
    photos = read_photos(client, kept["sid"])
    result = {"at": now(), "how": kept["how"], "hours": round(age.total_seconds() / 3600, 1), **photos}
    print(json.dumps(result))
    log = ROOT / "sso-recheck.jsonl"
    with log.open("a") as file:
        file.write(json.dumps(result) + "\n")
    if photos["me"] == "ok" and input("still works: keep it for another recheck? [Y/n]: ").strip().lower() != "n":
        print(f"kept; logged in {log}")
        return
    client.call(
        "SYNO.API.Auth",
        "logout",
        kept.get("auth_version", 6),
        sid=kept["sid"],
        path=kept.get("auth_path", "entry.cgi"),
        session=SESSION,
    )
    SESSION_FILE.unlink()
    print(f"logged out, and {SESSION_FILE} deleted; logged in {log}")


if __name__ == "__main__":
    try:
        recheck() if "--recheck" in sys.argv[1:] else probe()
    except KeyboardInterrupt:
        sys.exit(1)
