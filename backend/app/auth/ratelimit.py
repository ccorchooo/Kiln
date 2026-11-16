"""Per-IP login failure tracking with exponential backoff and hard lockout (persisted)."""

from __future__ import annotations

import time
from dataclasses import dataclass

from app.config import AuthConfig
from app.db import Database

MAX_BACKOFF_SECONDS = 15 * 60
# Failure counters decay after a day without failures.
FORGET_AFTER_SECONDS = 24 * 3600


@dataclass
class Throttle:
    retry_after: float  # seconds until the next attempt is allowed (0 = allowed now)
    locked_out: bool
    failures: int


class LoginRateLimiter:
    def __init__(self, db: Database, cfg: AuthConfig) -> None:
        self.db = db
        self.cfg = cfg

    def _backoff(self, count: int) -> float:
        if count < self.cfg.backoff_after:
            return 0.0
        return float(min(2 ** (count - self.cfg.backoff_after + 1), MAX_BACKOFF_SECONDS))

    async def check(self, ip: str, now: float | None = None) -> Throttle:
        now = time.time() if now is None else now
        async with self.db.conn.execute(
            "SELECT count, last_failure, locked_until FROM login_failures WHERE ip = ?", (ip,)
        ) as cur:
            row = await cur.fetchone()
        if row is None:
            return Throttle(0.0, False, 0)
        count, last, locked_until = int(row[0]), float(row[1]), float(row[2])
        if locked_until > now:
            return Throttle(locked_until - now, True, count)
        if now - last > FORGET_AFTER_SECONDS:
            await self.reset(ip)
            return Throttle(0.0, False, 0)
        wait = last + self._backoff(count) - now
        return Throttle(max(0.0, wait), False, count)

    async def fail(self, ip: str, now: float | None = None) -> Throttle:
        now = time.time() if now is None else now
        await self.db.conn.execute(
            "INSERT INTO login_failures(ip, count, last_failure) VALUES(?, 1, ?) "
            "ON CONFLICT(ip) DO UPDATE SET count = count + 1, last_failure = excluded.last_failure",
            (ip, now),
        )
        async with self.db.conn.execute("SELECT count FROM login_failures WHERE ip = ?", (ip,)) as cur:
            row = await cur.fetchone()
        count = int(row[0]) if row else 1
        if count >= self.cfg.lockout_threshold:
            until = now + self.cfg.lockout_minutes * 60
            await self.db.conn.execute("UPDATE login_failures SET locked_until = ? WHERE ip = ?", (until, ip))
            return Throttle(until - now, True, count)
        return Throttle(self._backoff(count), False, count)

    async def reset(self, ip: str) -> None:
        await self.db.conn.execute("DELETE FROM login_failures WHERE ip = ?", (ip,))
