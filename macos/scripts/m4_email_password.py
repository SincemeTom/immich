"""End-to-end check of PUT /users/me asking the current password to change the login email or the password
(macos/verification/m4-email-password.md).

usage (python with httpx, e.g. uv run --with httpx): m4_email_password.py [URL] [ADMIN_EMAIL] [ADMIN_PASSWORD]
       (default http://127.0.0.1:2291, admin@example.com / m4-admin-pass; a scratch server, it creates a user)
"""

import sys
import uuid

import httpx

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:2291"
ADMIN = (sys.argv[2], sys.argv[3]) if len(sys.argv) > 3 else ("admin@example.com", "m4-admin-pass")

failures = []


def check(name, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {name}{'' if condition else f'  ({detail})'}")
    if not condition:
        failures.append(name)


def login(email, password):
    response = httpx.post(f"{URL}/api/auth/login", json={"email": email, "password": password})
    return response.json()["accessToken"] if response.status_code == 201 else None


def client(token):
    return httpx.Client(base_url=f"{URL}/api", headers={"Authorization": f"Bearer {token}"}, timeout=30)


admin = client(login(*ADMIN))
tag = uuid.uuid4().hex[:8]
email, password = f"m4-email-{tag}@example.com", "m4-email-pass"
user = admin.post(
    "/admin/users", json={"email": email, "password": password, "name": "M4 Email", "shouldChangePassword": False}
).json()

me = client(login(email, password))
new_email = f"m4-email-new-{tag}@example.com"

response = me.put("/users/me", json={"email": new_email})
check("email without the password: 400", response.status_code == 400, response.text)
check("  says the current password is required", "Current password is required" in response.text, response.text)

response = me.put("/users/me", json={"email": new_email, "currentPassword": "wrong"})
check("email with a wrong password: 400 Wrong password", response.status_code == 400 and "Wrong password" in response.text, response.text)
check("  email unchanged", me.get("/users/me").json()["email"] == email)

response = me.put("/users/me", json={"name": "M4 Renamed", "email": email})
check("name, same email, no password: 200", response.status_code == 200 and response.json()["name"] == "M4 Renamed", response.text)

response = me.put("/users/me", json={"email": new_email, "currentPassword": password})
check("email with the password: 200", response.status_code == 200 and response.json()["email"] == new_email, response.text)
check("  logs in with the new email", login(new_email, password) is not None)
check("  not with the old one", login(email, password) is None)

response = me.put("/users/me", json={"password": "m4-email-pass-2"})
check("new password without the current one: 400", response.status_code == 400, response.text)
response = me.put("/users/me", json={"password": "m4-email-pass-2", "currentPassword": password})
check("new password with the current one: 200", response.status_code == 200, response.text)
check("  logs in with it", login(new_email, "m4-email-pass-2") is not None)

first = f"m4-email-first-{tag}@example.com"
must = admin.post("/admin/users", json={"email": first, "password": "given-by-admin", "name": "M4 First"}).json()
response = client(login(first, "given-by-admin")).put("/users/me", json={"password": "m4-own-pass"})
check("first password of a user who must change it: 200", response.status_code == 200, response.text)

for created in (user, must):
    admin.delete(f"/admin/users/{created['id']}", params={"force": "true"})

print(f"\n{'all passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
