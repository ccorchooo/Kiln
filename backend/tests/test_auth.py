from __future__ import annotations

import time

import httpx
import pyotp

from app.auth.sessions import COOKIE_NAME
from app.state import AppState
from tests.conftest import PASSWORD, login


async def test_state_before_setup(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/auth/state")
    assert r.json() == {"setup": False, "authenticated": False, "locked": False, "idle_lock_minutes": 10.0}


async def test_unlock_without_setup_is_409(client: httpx.AsyncClient) -> None:
    r = await client.post("/api/auth/unlock", json={"password": "whatever123"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "setup_required"


async def test_login_sets_strict_secure_cookie(client: httpx.AsyncClient, state: AppState) -> None:
    await state.credentials.set_password(PASSWORD)
    r = await client.post("/api/auth/unlock", json={"password": PASSWORD})
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    for flag in ("httponly", "secure", "samesite=strict", "path=/"):
        assert flag in cookie
    body = r.json()
    assert body["authenticated"] and not body["locked"] and body["display_name"] == "Augusto"
    rows = await state.audit.query(event="auth.login")
    assert len(rows) == 1


async def test_wrong_password_is_401_and_audited(client: httpx.AsyncClient, state: AppState) -> None:
    await state.credentials.set_password(PASSWORD)
    r = await client.post("/api/auth/unlock", json={"password": "nope nope nope"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "bad_credentials"
    assert (await state.audit.query(event="auth.password_failed"))[0].outcome == "failed"


async def test_backoff_then_429(client: httpx.AsyncClient, state: AppState) -> None:
    await state.credentials.set_password(PASSWORD)
    for _ in range(state.config.auth.backoff_after):
        await client.post("/api/auth/unlock", json={"password": "wrong wrong"})
    r = await client.post("/api/auth/unlock", json={"password": PASSWORD})
    assert r.status_code == 429
    assert r.json()["detail"]["retry_after"] > 0
    assert "retry-after" in r.headers


async def test_lockout_after_threshold(state: AppState) -> None:
    lim = state.limiter
    t0 = 1_000_000.0
    t = None
    for i in range(state.config.auth.lockout_threshold):
        t = await lim.fail("10.0.0.9", now=t0 + i * 10_000)  # spaced out so backoff never blocks
    assert t is not None and t.locked_out
    chk = await lim.check("10.0.0.9", now=t0 + 9 * 10_000 + 60)
    assert chk.locked_out and chk.retry_after > 0
    # other IPs unaffected
    assert (await lim.check("10.0.0.10", now=t0)).retry_after == 0


async def test_csrf_required_for_state_changes(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    assert (await client.post("/api/auth/lock")).status_code == 403
    r = await client.post("/api/auth/lock", headers={"x-csrf-token": csrf})
    assert r.status_code == 200
    assert (await client.get("/api/auth/state")).json()["locked"] is True


async def test_cross_origin_rejected(client: httpx.AsyncClient, state: AppState) -> None:
    await state.credentials.set_password(PASSWORD)
    r = await client.post("/api/auth/unlock", json={"password": PASSWORD}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "bad_origin"
    r = await client.post("/api/auth/unlock", json={"password": PASSWORD}, headers={"origin": ""})
    assert r.status_code == 403


async def test_locked_session_blocks_api_and_unlock_rotates_token(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    old_token = client.cookies.get(COOKIE_NAME)
    await client.post("/api/auth/lock", headers={"x-csrf-token": csrf})
    assert (await client.get("/api/audit")).status_code == 423
    r = await client.post("/api/auth/unlock", json={"password": PASSWORD}, headers={"x-csrf-token": csrf})
    assert r.status_code == 200
    new_token = client.cookies.get(COOKIE_NAME)
    assert new_token != old_token
    assert await state.sessions.lookup(old_token) is None
    assert len(await state.sessions.list()) == 1  # same session, not a new one
    assert (await client.get("/api/audit")).status_code == 200


async def test_auto_lock_after_idle(state: AppState) -> None:
    sess, token = await state.sessions.create("127.0.0.1", "test")
    later = time.time() + state.config.auth.idle_lock_minutes * 60 + 5
    found = await state.sessions.lookup(token, now=later)
    assert found is not None and found.locked


async def test_absolute_expiry(state: AppState) -> None:
    _, token = await state.sessions.create("127.0.0.1", "test")
    later = time.time() + state.config.auth.session_absolute_days * 86400 + 1
    assert await state.sessions.lookup(token, now=later) is None


async def test_totp_flow_and_replay(client: httpx.AsyncClient, state: AppState) -> None:
    await state.credentials.set_password(PASSWORD)
    secret = pyotp.random_base32()
    await state.credentials.set_totp(secret)
    r = await client.post("/api/auth/unlock", json={"password": PASSWORD})
    assert r.json()["step"] == "totp"
    challenge = r.json()["challenge"]
    assert COOKIE_NAME not in client.cookies  # no session before the second factor
    code = pyotp.TOTP(secret).now()
    r = await client.post("/api/auth/totp", json={"challenge": challenge, "code": code})
    assert r.status_code == 200 and r.json()["authenticated"]
    # replaying the same code with a fresh challenge fails
    client.cookies.clear()
    r = await client.post("/api/auth/unlock", json={"password": PASSWORD})
    r = await client.post("/api/auth/totp", json={"challenge": r.json()["challenge"], "code": code})
    assert r.status_code == 401


async def test_totp_bad_challenge(client: httpx.AsyncClient, state: AppState) -> None:
    r = await client.post("/api/auth/totp", json={"challenge": "made-up", "code": "123456"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "challenge_expired"


async def test_reauth_required_for_security_settings(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    h = {"x-csrf-token": csrf}
    sid = (await client.get("/api/auth/state")).json()["session_id"]
    await state.db.conn.execute("UPDATE sessions SET reauth_until = 0 WHERE id = ?", (sid,))
    r = await client.post("/api/auth/totp/setup", headers=h)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "reauth_required"
    assert (await client.post("/api/auth/reauth", json={"password": "wrong pass"}, headers=h)).status_code == 401
    assert (await client.post("/api/auth/reauth", json={"password": PASSWORD}, headers=h)).status_code == 200
    r = await client.post("/api/auth/totp/setup", headers=h)
    assert r.status_code == 200 and r.json()["qr_svg"].startswith("<?xml")


async def test_panic_kills_everything(client: httpx.AsyncClient, state: AppState) -> None:
    called: list[bool] = []

    async def hook() -> None:
        called.append(True)

    state.panic_hooks.append(hook)
    csrf = await login(client, state)
    await state.sessions.create("100.64.0.2", "phone")
    r = await client.post("/api/auth/panic", headers={"x-csrf-token": csrf})
    assert r.status_code == 200 and r.json()["sessions_killed"] == 2
    assert called == [True]
    assert await state.sessions.list() == []
    assert (await client.get("/api/auth/state")).json()["authenticated"] is False


async def test_revoke_other_session(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    other, other_token = await state.sessions.create("100.64.0.2", "phone")
    sessions = (await client.get("/api/auth/sessions")).json()
    assert {s["id"] for s in sessions} >= {other.id}
    r = await client.delete(f"/api/auth/sessions/{other.id}", headers={"x-csrf-token": csrf})
    assert r.status_code == 200
    assert await state.sessions.lookup(other_token) is None


async def test_change_password_signs_out_others(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    _, other_token = await state.sessions.create("100.64.0.2", "phone")
    r = await client.post(
        "/api/auth/password",
        json={"current": PASSWORD, "new": "a brand new passphrase"},
        headers={"x-csrf-token": csrf},
    )
    assert r.status_code == 200
    assert await state.sessions.lookup(other_token) is None
    assert len(await state.sessions.list()) == 1


async def test_security_headers(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/health")
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert "unsafe-inline" not in r.headers["content-security-policy"].split("script-src")[1].split(";")[0]
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["strict-transport-security"].startswith("max-age=")
    assert "microphone=(self)" in r.headers["permissions-policy"]
    assert r.headers["cache-control"] == "no-store"


async def test_unknown_api_is_json_404(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/nope")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_found"
