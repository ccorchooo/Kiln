"""Credential storage (single user)."""

from __future__ import annotations

import time

from app.auth.passwords import hash_password
from app.db import Database


class Credentials:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def get(self) -> tuple[str | None, str | None]:
        async with self.db.conn.execute("SELECT password_hash, totp_secret FROM credentials WHERE id = 1") as cur:
            row = await cur.fetchone()
        return (row[0], row[1]) if row else (None, None)

    async def is_setup(self) -> bool:
        return (await self.get())[0] is not None

    async def set_password(self, password: str) -> None:
        await self.set_password_hash(hash_password(password))

    async def set_password_hash(self, digest: str) -> None:
        await self.db.conn.execute(
            "INSERT INTO credentials(id, password_hash, updated_at) VALUES(1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at",
            (digest, time.time()),
        )

    async def set_totp(self, secret: str | None) -> None:
        await self.db.conn.execute(
            "UPDATE credentials SET totp_secret = ?, updated_at = ? WHERE id = 1", (secret, time.time())
        )

    async def consume_totp_window(self, code: str, window: int) -> bool:
        """Record a used code; False if it was already used (replay)."""
        await self.db.conn.execute("DELETE FROM totp_used WHERE window < ?", (window - 4,))
        cur = await self.db.conn.execute("INSERT OR IGNORE INTO totp_used(code, window) VALUES(?, ?)", (code, window))
        return (cur.rowcount or 0) > 0
