"""Server-side sessions. The cookie carries a random token; the DB stores only its SHA-256."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass
from typing import Any

from app.config import AuthConfig
from app.db import Database

COOKIE_NAME = "kiln_session"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class Session:
    id: str
    csrf_token: str
    created_at: float
    last_seen: float
    last_active: float
    expires_at: float
    locked: bool
    reauth_until: float
    ip: str
    user_agent: str

    def recently_authenticated(self, now: float | None = None) -> bool:
        return self.reauth_until > (time.time() if now is None else now)

    def csrf_ok(self, supplied: str | None) -> bool:
        return bool(supplied) and hmac.compare_digest(self.csrf_token, supplied or "")

    def public(self, current_id: str | None = None) -> dict[str, object]:
        return {
            "id": self.id,
            "created_at": self.created_at,
            "last_seen": self.last_seen,
            "expires_at": self.expires_at,
            "locked": self.locked,
            "ip": self.ip,
            "user_agent": self.user_agent,
            "current": self.id == current_id,
        }


_COLS = "id, csrf_token, created_at, last_seen, last_active, expires_at, locked, reauth_until, ip, user_agent"


def _row(r: Any) -> Session:
    v: tuple[Any, ...] = tuple(r)
    return Session(v[0], v[1], v[2], v[3], v[4], v[5], bool(v[6]), v[7], v[8], v[9])


class SessionStore:
    def __init__(self, db: Database, cfg: AuthConfig) -> None:
        self.db = db
        self.cfg = cfg

    async def create(self, ip: str, user_agent: str, now: float | None = None) -> tuple[Session, str]:
        now = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        sess = Session(
            id=secrets.token_urlsafe(9),
            csrf_token=secrets.token_urlsafe(32),
            created_at=now,
            last_seen=now,
            last_active=now,
            expires_at=now + self.cfg.session_absolute_days * 86400,
            locked=False,
            reauth_until=now + self.cfg.reauth_window_minutes * 60,  # a fresh login counts as recent auth
            ip=ip,
            user_agent=user_agent[:300],
        )
        await self.db.conn.execute(
            f"INSERT INTO sessions(token_hash, {_COLS}) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                _hash(token),
                sess.id,
                sess.csrf_token,
                sess.created_at,
                sess.last_seen,
                sess.last_active,
                sess.expires_at,
                int(sess.locked),
                sess.reauth_until,
                sess.ip,
                sess.user_agent,
            ),
        )
        return sess, token

    async def lookup(self, token: str | None, now: float | None = None, touch: bool = True) -> Session | None:
        """Return the session for a cookie token, or None if missing/expired. Applies auto-lock."""
        if not token or len(token) > 128:
            return None
        now = time.time() if now is None else now
        async with self.db.conn.execute(f"SELECT {_COLS} FROM sessions WHERE token_hash = ?", (_hash(token),)) as cur:
            row = await cur.fetchone()
        return await self._validate(row, now, touch)

    async def get(self, sid: str, now: float | None = None) -> Session | None:
        """Look up by public id (e.g. for long-lived sockets after a token rotation)."""
        async with self.db.conn.execute(f"SELECT {_COLS} FROM sessions WHERE id = ?", (sid,)) as cur:
            row = await cur.fetchone()
        return await self._validate(row, time.time() if now is None else now, touch=False)

    async def _validate(self, row: object | None, now: float, touch: bool) -> Session | None:
        if row is None:
            return None
        sess = _row(row)
        if sess.expires_at <= now or sess.last_seen + self.cfg.session_idle_hours * 3600 <= now:
            await self.revoke(sess.id)
            return None
        idle_lock = self.cfg.idle_lock_minutes * 60
        if not sess.locked and idle_lock > 0 and now - sess.last_active > idle_lock:
            sess.locked = True
            sess.reauth_until = 0
            await self.db.conn.execute("UPDATE sessions SET locked = 1, reauth_until = 0 WHERE id = ?", (sess.id,))
        if touch and now - sess.last_seen > 30:
            sess.last_seen = now
            await self.db.conn.execute("UPDATE sessions SET last_seen = ? WHERE id = ?", (now, sess.id))
        return sess

    async def mark_active(self, sid: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        await self.db.conn.execute(
            "UPDATE sessions SET last_active = ?, last_seen = ? WHERE id = ? AND locked = 0", (now, now, sid)
        )

    async def lock(self, sid: str) -> None:
        await self.db.conn.execute("UPDATE sessions SET locked = 1, reauth_until = 0 WHERE id = ?", (sid,))

    async def unlock(self, sid: str, now: float | None = None) -> str:
        """Unlock and rotate the cookie token (prevents fixation). Returns the new token."""
        now = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        await self.db.conn.execute(
            "UPDATE sessions SET locked = 0, token_hash = ?, last_active = ?, last_seen = ?, "
            "reauth_until = ? WHERE id = ?",
            (_hash(token), now, now, now + self.cfg.reauth_window_minutes * 60, sid),
        )
        return token

    async def grant_reauth(self, sid: str, now: float | None = None) -> float:
        until = (time.time() if now is None else now) + self.cfg.reauth_window_minutes * 60
        await self.db.conn.execute("UPDATE sessions SET reauth_until = ? WHERE id = ?", (until, sid))
        return until

    async def revoke(self, sid: str) -> bool:
        cur = await self.db.conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        return (cur.rowcount or 0) > 0

    async def revoke_all(self) -> int:
        cur = await self.db.conn.execute("DELETE FROM sessions")
        return cur.rowcount or 0

    async def list(self) -> list[Session]:
        async with self.db.conn.execute(f"SELECT {_COLS} FROM sessions ORDER BY last_seen DESC") as cur:
            return [_row(r) for r in await cur.fetchall()]

    async def purge_expired(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        await self.db.conn.execute(
            "DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?",
            (now, now - self.cfg.session_idle_hours * 3600),
        )
