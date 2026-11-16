"""Auth API: login/unlock (+TOTP step), lock, logout, re-auth, panic, sessions, TOTP management."""

from __future__ import annotations

import asyncio
import io
import secrets
import time
from typing import Annotated, Any

import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.auth.deps import (
    AnySessionDep,
    RecentAuthDep,
    SessionDep,
    StateDep,
    client_ip,
    optional_session,
)
from app.auth.passwords import (
    MIN_PASSWORD_LENGTH,
    hash_password,
    needs_rehash,
    new_totp_secret,
    totp_uri,
    totp_window,
    verify_password,
)
from app.auth.sessions import COOKIE_NAME, Session
from app.state import AppState

router = APIRouter(prefix="/api/auth", tags=["auth"])

TOTP_CHALLENGE_SECONDS = 120
PENDING_TOTP_KEY = "auth.pending_totp_secret"


class PasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


class TotpIn(BaseModel):
    challenge: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=6, max_length=8)


class CodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class ChangePasswordIn(BaseModel):
    current: str = Field(min_length=1, max_length=1024)
    new: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=1024)


def _ua(request: Request) -> str:
    return request.headers.get("user-agent", "unknown")


def _set_cookie(response: Response, state: AppState, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/",
        max_age=int(state.config.auth.session_absolute_days * 86400),
    )


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", secure=True, httponly=True, samesite="strict")


def _throttled(retry_after: float, locked_out: bool) -> HTTPException:
    return HTTPException(
        429,
        detail={
            "code": "locked_out" if locked_out else "throttled",
            "retry_after": round(retry_after, 1),
            "message": "Too many attempts. Try again later.",
        },
        headers={"Retry-After": str(int(retry_after) + 1)},
    )


async def _state_payload(state: AppState, sess: Session | None) -> dict[str, Any]:
    pw, totp = await state.credentials.get()
    payload: dict[str, Any] = {
        "setup": pw is not None,
        "authenticated": sess is not None,
        "locked": bool(sess and sess.locked),
        "idle_lock_minutes": state.config.auth.idle_lock_minutes,
    }
    if sess is not None:
        payload |= {"csrf": sess.csrf_token, "session_id": sess.id}
        if not sess.locked:
            payload |= {
                "totp_enabled": totp is not None,
                "reauth_until": sess.reauth_until,
                "display_name": state.config.user.display_name,
                "assistant_name": state.config.user.assistant_name,
            }
    return payload


async def _check_throttle(state: AppState, ip: str) -> None:
    t = await state.limiter.check(ip)
    if t.retry_after > 0:
        await state.audit.record("auth.throttled", outcome="denied", ip=ip, failures=t.failures)
        raise _throttled(t.retry_after, t.locked_out)


async def _fail(state: AppState, ip: str, event: str, **details: Any) -> HTTPException:
    t = await state.limiter.fail(ip)
    await state.audit.record(event, outcome="failed", ip=ip, failures=t.failures, **details)
    if t.locked_out:
        state.events.publish("auth.lockout", {"ip": ip}, lock_safe=False)
        return _throttled(t.retry_after, True)
    return HTTPException(
        401, detail={"code": "bad_credentials", "message": "That didn't match.", "retry_after": t.retry_after}
    )


async def _finish_login(
    request: Request, response: Response, state: AppState, existing: Session | None
) -> dict[str, Any]:
    ip = client_ip(request)
    await state.limiter.reset(ip)
    if existing is not None:
        token = await state.sessions.unlock(existing.id)
        await state.audit.record("auth.unlock", ip=ip, session_id=existing.id)
        sid = existing.id
    else:
        sess, token = await state.sessions.create(ip, _ua(request))
        await state.audit.record("auth.login", ip=ip, session_id=sess.id, user_agent=sess.user_agent)
        sid = sess.id
    _set_cookie(response, state, token)
    state.events.publish("session.unlocked", {}, session_id=sid, lock_safe=True)
    fresh = await state.sessions.lookup(token, touch=False)
    return await _state_payload(state, fresh)


@router.get("/state")
async def auth_state(state: StateDep, sess: Annotated[Session | None, Depends(optional_session)]) -> dict[str, Any]:
    return await _state_payload(state, sess)


@router.post("/unlock")
async def unlock(
    body: PasswordIn,
    request: Request,
    response: Response,
    state: StateDep,
    sess: Annotated[Session | None, Depends(optional_session)],
) -> dict[str, Any]:
    ip = client_ip(request)
    if sess is not None and not sess.csrf_ok(request.headers.get("x-csrf-token")):
        raise HTTPException(403, detail={"code": "csrf", "message": "Missing or invalid CSRF token"})
    await _check_throttle(state, ip)
    pw_hash, totp_secret = await state.credentials.get()
    if pw_hash is None:
        verify_password(None, body.password)  # keep timing uniform
        raise HTTPException(
            409, detail={"code": "setup_required", "message": "No password set. Run `kiln set-password` on the host."}
        )
    if not verify_password(pw_hash, body.password):
        raise await _fail(state, ip, "auth.password_failed", session_id=sess.id if sess else None)
    if needs_rehash(pw_hash):
        await state.credentials.set_password_hash(hash_password(body.password))
    if totp_secret:
        challenge = secrets.token_urlsafe(24)
        await state.db.conn.execute("DELETE FROM totp_challenges WHERE expires_at < ?", (time.time(),))
        await state.db.conn.execute(
            "INSERT INTO totp_challenges(id, ip, expires_at) VALUES(?,?,?)",
            (challenge, ip, time.time() + TOTP_CHALLENGE_SECONDS),
        )
        return {"step": "totp", "challenge": challenge}
    return await _finish_login(request, response, state, sess)


@router.post("/totp")
async def totp_step(
    body: TotpIn,
    request: Request,
    response: Response,
    state: StateDep,
    sess: Annotated[Session | None, Depends(optional_session)],
) -> dict[str, Any]:
    ip = client_ip(request)
    if sess is not None and not sess.csrf_ok(request.headers.get("x-csrf-token")):
        raise HTTPException(403, detail={"code": "csrf", "message": "Missing or invalid CSRF token"})
    await _check_throttle(state, ip)
    async with state.db.conn.execute(
        "SELECT ip, expires_at FROM totp_challenges WHERE id = ?", (body.challenge,)
    ) as cur:
        row = await cur.fetchone()
    if row is None or row[0] != ip or row[1] < time.time():
        raise HTTPException(401, detail={"code": "challenge_expired", "message": "Please enter your password again."})
    _, secret = await state.credentials.get()
    window = totp_window(secret or "", body.code)
    if secret is None or window is None or not await state.credentials.consume_totp_window(body.code, window):
        raise await _fail(state, ip, "auth.totp_failed")
    await state.db.conn.execute("DELETE FROM totp_challenges WHERE id = ?", (body.challenge,))
    return await _finish_login(request, response, state, sess)


@router.post("/lock")
async def lock(sess: AnySessionDep, request: Request, state: StateDep) -> dict[str, Any]:
    await state.sessions.lock(sess.id)
    await state.audit.record("auth.lock", ip=client_ip(request), session_id=sess.id)
    state.events.publish("session.locked", {}, session_id=sess.id, lock_safe=True)
    return {"locked": True}


@router.post("/heartbeat")
async def heartbeat(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    """Client reports recent user interaction; drives server-side auto-lock."""
    await state.sessions.mark_active(sess.id)
    return {"ok": True}


@router.post("/logout")
async def logout(sess: AnySessionDep, request: Request, response: Response, state: StateDep) -> dict[str, Any]:
    await state.sessions.revoke(sess.id)
    await state.audit.record("auth.logout", ip=client_ip(request), session_id=sess.id)
    state.events.publish("session.ended", {}, session_id=sess.id, lock_safe=True)
    _clear_cookie(response)
    return {"ok": True}


@router.post("/reauth")
async def reauth(body: PasswordIn, sess: SessionDep, request: Request, state: StateDep) -> dict[str, Any]:
    ip = client_ip(request)
    await _check_throttle(state, ip)
    pw_hash, _ = await state.credentials.get()
    if not verify_password(pw_hash, body.password):
        raise await _fail(state, ip, "auth.reauth_failed", session_id=sess.id)
    await state.limiter.reset(ip)
    until = await state.sessions.grant_reauth(sess.id)
    await state.audit.record("auth.reauth", ip=ip, session_id=sess.id)
    return {"reauth_until": until}


@router.post("/panic")
async def panic(sess: AnySessionDep, request: Request, response: Response, state: StateDep) -> dict[str, Any]:
    """Kill every session and every registered process (terminals, AI tools). Allowed while locked."""
    results = await asyncio.gather(*(hook() for hook in state.panic_hooks), return_exceptions=True)
    errors = [repr(r) for r in results if isinstance(r, BaseException)]
    count = await state.sessions.revoke_all()
    await state.audit.record(
        "auth.panic",
        ip=client_ip(request),
        session_id=sess.id,
        sessions_killed=count,
        hooks=len(state.panic_hooks),
        hook_errors=errors,
    )
    state.events.publish("session.ended", {"reason": "panic"}, lock_safe=True)
    _clear_cookie(response)
    return {"ok": True, "sessions_killed": count}


@router.get("/sessions")
async def list_sessions(sess: SessionDep, state: StateDep) -> list[dict[str, object]]:
    return [s.public(sess.id) for s in await state.sessions.list()]


@router.delete("/sessions/{sid}")
async def revoke_session(sid: str, sess: SessionDep, request: Request, state: StateDep) -> dict[str, Any]:
    if not await state.sessions.revoke(sid):
        raise HTTPException(404, detail={"code": "not_found", "message": "No such session"})
    await state.audit.record("auth.session_revoked", ip=client_ip(request), session_id=sess.id, revoked=sid)
    state.events.publish("session.ended", {"reason": "revoked"}, session_id=sid, lock_safe=True)
    return {"ok": True}


@router.post("/password")
async def change_password(
    body: ChangePasswordIn, sess: RecentAuthDep, request: Request, state: StateDep
) -> dict[str, Any]:
    pw_hash, _ = await state.credentials.get()
    if not verify_password(pw_hash, body.current):
        raise await _fail(state, client_ip(request), "auth.password_change_failed", session_id=sess.id)
    await state.credentials.set_password(body.new)
    # Sign out every other device.
    for other in await state.sessions.list():
        if other.id != sess.id:
            await state.sessions.revoke(other.id)
            state.events.publish("session.ended", {"reason": "password_changed"}, session_id=other.id, lock_safe=True)
    await state.audit.record("auth.password_changed", ip=client_ip(request), session_id=sess.id)
    return {"ok": True}


def _qr_svg(data: str) -> str:
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode()


@router.post("/totp/setup")
async def totp_setup(sess: RecentAuthDep, state: StateDep) -> dict[str, Any]:
    secret = new_totp_secret()
    await state.db.set_setting(PENDING_TOTP_KEY, secret)
    uri = totp_uri(secret)
    return {"secret": secret, "uri": uri, "qr_svg": _qr_svg(uri)}


@router.post("/totp/enable")
async def totp_enable(body: CodeIn, sess: RecentAuthDep, request: Request, state: StateDep) -> dict[str, Any]:
    pending = await state.db.get_setting(PENDING_TOTP_KEY)
    window = totp_window(pending or "", body.code)
    if pending is None or window is None:
        raise HTTPException(400, detail={"code": "bad_code", "message": "That code didn't match. Check the clock."})
    await state.credentials.consume_totp_window(body.code, window)
    await state.credentials.set_totp(pending)
    await state.db.conn.execute("DELETE FROM settings WHERE key = ?", (PENDING_TOTP_KEY,))
    await state.audit.record("auth.totp_enabled", ip=client_ip(request), session_id=sess.id)
    return {"totp_enabled": True}


@router.post("/totp/disable")
async def totp_disable(sess: RecentAuthDep, request: Request, state: StateDep) -> dict[str, Any]:
    await state.credentials.set_totp(None)
    await state.audit.record("auth.totp_disabled", ip=client_ip(request), session_id=sess.id)
    return {"totp_enabled": False}
