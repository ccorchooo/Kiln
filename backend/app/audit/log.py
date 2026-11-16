"""Append-only, hash-chained audit log.

Rows can't be updated or deleted (SQLite triggers), and each row's hash covers the
previous row's hash, so editing the file directly breaks `verify()`.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import time
from dataclasses import dataclass
from typing import Any

from app.db import Database

GENESIS = "0" * 64

# Keys whose values must never be written to the audit log.
_SECRET_KEYS = {"password", "sudo_password", "totp", "code", "token", "secret", "api_key"}


def _scrub(details: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in details.items():
        if key.lower() in _SECRET_KEYS:
            out[key] = "[redacted]"
        elif isinstance(val, dict):
            out[key] = _scrub(val)
        else:
            out[key] = val
    return out


@dataclass
class AuditEntry:
    id: int
    ts: float
    event: str
    actor: str
    ip: str | None
    session_id: str | None
    outcome: str
    details: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


def _digest(
    prev: str, ts: float, event: str, actor: str, ip: str | None, session_id: str | None, outcome: str, details: str
) -> str:
    payload = json.dumps([prev, ts, event, actor, ip, session_id, outcome, details], separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


class AuditLog:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._lock = asyncio.Lock()

    async def record(
        self,
        event: str,
        *,
        outcome: str = "ok",
        actor: str = "user",
        ip: str | None = None,
        session_id: str | None = None,
        **details: Any,
    ) -> None:
        body = json.dumps(_scrub(details), sort_keys=True, default=str)
        async with self._lock:
            async with self.db.conn.execute("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1") as cur:
                row = await cur.fetchone()
            prev = row[0] if row else GENESIS
            ts = time.time()
            digest = _digest(prev, ts, event, actor, ip, session_id, outcome, body)
            await self.db.conn.execute(
                "INSERT INTO audit_log(ts, event, actor, ip, session_id, outcome, details, prev_hash, hash) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (ts, event, actor, ip, session_id, outcome, body, prev, digest),
            )

    async def query(
        self,
        *,
        event: str | None = None,
        outcome: str | None = None,
        since: float | None = None,
        until: float | None = None,
        search: str | None = None,
        limit: int = 200,
        before_id: int | None = None,
    ) -> list[AuditEntry]:
        clauses, args = [], []  # type: list[str], list[Any]
        if event:
            clauses.append("event LIKE ?")
            args.append(event.replace("*", "%"))
        if outcome:
            clauses.append("outcome = ?")
            args.append(outcome)
        if since is not None:
            clauses.append("ts >= ?")
            args.append(since)
        if until is not None:
            clauses.append("ts <= ?")
            args.append(until)
        if search:
            clauses.append("(details LIKE ? OR event LIKE ?)")
            args += [f"%{search}%", f"%{search}%"]
        if before_id is not None:
            clauses.append("id < ?")
            args.append(before_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        args.append(max(1, min(limit, 5000)))
        sql = (
            "SELECT id, ts, event, actor, ip, session_id, outcome, details "  # noqa: S608 - clauses are fixed
            f"FROM audit_log {where} ORDER BY id DESC LIMIT ?"
        )
        async with self.db.conn.execute(sql, args) as cur:
            rows = await cur.fetchall()
        return [AuditEntry(r[0], r[1], r[2], r[3], r[4], r[5], r[6], json.loads(r[7])) for r in rows]

    async def verify(self) -> tuple[bool, int | None]:
        """Walk the chain. Returns (ok, first_bad_id)."""
        prev = GENESIS
        async with self.db.conn.execute(
            "SELECT id, ts, event, actor, ip, session_id, outcome, details, prev_hash, hash FROM audit_log ORDER BY id"
        ) as cur:
            async for r in cur:
                if r[8] != prev or _digest(prev, r[1], r[2], r[3], r[4], r[5], r[6], r[7]) != r[9]:
                    return False, int(r[0])
                prev = r[9]
        return True, None


def to_csv(entries: list[AuditEntry]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "ts", "event", "actor", "ip", "session_id", "outcome", "details"])
    for e in entries:
        w.writerow(
            [
                e.id,
                e.ts,
                e.event,
                e.actor,
                e.ip or "",
                e.session_id or "",
                e.outcome,
                json.dumps(e.details, sort_keys=True),
            ]
        )
    return buf.getvalue()
