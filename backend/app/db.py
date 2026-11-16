"""SQLite storage. One connection, WAL mode, schema migrations by version number."""

from __future__ import annotations

import os
from pathlib import Path

import aiosqlite

MIGRATIONS: list[str] = [
    # 1: credentials, sessions, rate limiting, audit, settings
    """
    CREATE TABLE credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        totp_secret TEXT,
        updated_at REAL NOT NULL
    );
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,              -- public id (shown in UI, used for revoke)
        token_hash TEXT NOT NULL UNIQUE,  -- sha256 of the cookie token
        csrf_token TEXT NOT NULL,
        created_at REAL NOT NULL,
        last_seen REAL NOT NULL,
        last_active REAL NOT NULL,        -- last user interaction (for auto-lock)
        expires_at REAL NOT NULL,         -- absolute expiry
        locked INTEGER NOT NULL DEFAULT 0,
        reauth_until REAL NOT NULL DEFAULT 0,
        ip TEXT NOT NULL,
        user_agent TEXT NOT NULL
    );
    CREATE TABLE login_failures (
        ip TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        last_failure REAL NOT NULL,
        locked_until REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE totp_challenges (
        id TEXT PRIMARY KEY,
        ip TEXT NOT NULL,
        expires_at REAL NOT NULL
    );
    CREATE TABLE totp_used (
        code TEXT NOT NULL,
        window INTEGER NOT NULL,
        PRIMARY KEY (code, window)
    );
    CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        ip TEXT,
        session_id TEXT,
        outcome TEXT NOT NULL,
        details TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
    );
    CREATE INDEX audit_ts ON audit_log(ts);
    CREATE INDEX audit_event ON audit_log(event);
    CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,
]


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("database not open")
        return self._conn

    async def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fresh = not self.path.exists()
        self._conn = await aiosqlite.connect(self.path, isolation_level=None)
        if fresh:
            os.chmod(self.path, 0o600)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.execute("PRAGMA busy_timeout=5000")
        await self._migrate()

    async def _migrate(self) -> None:
        async with self.conn.execute("PRAGMA user_version") as cur:
            row = await cur.fetchone()
        version = int(row[0]) if row else 0
        for idx, script in enumerate(MIGRATIONS[version:], start=version + 1):
            await self.conn.executescript(f"BEGIN; {script}; PRAGMA user_version = {idx}; COMMIT;")

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def get_setting(self, key: str) -> str | None:
        async with self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
            row = await cur.fetchone()
        return str(row[0]) if row else None

    async def set_setting(self, key: str, value: str) -> None:
        await self.conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
