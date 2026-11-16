from __future__ import annotations

import sqlite3

import pytest

from app.state import AppState


async def test_chain_verifies(state: AppState) -> None:
    for i in range(5):
        await state.audit.record("test.event", n=i)
    ok, bad = await state.audit.verify()
    assert ok and bad is None


async def test_append_only(state: AppState) -> None:
    await state.audit.record("test.event")
    with pytest.raises(sqlite3.IntegrityError):
        await state.db.conn.execute("UPDATE audit_log SET outcome = 'x'")
    with pytest.raises(sqlite3.IntegrityError):
        await state.db.conn.execute("DELETE FROM audit_log")


async def test_tampering_breaks_chain(state: AppState) -> None:
    for i in range(3):
        await state.audit.record("test.event", n=i)
    await state.db.conn.execute("DROP TRIGGER audit_no_update")
    await state.db.conn.execute(
        "UPDATE audit_log SET details = '{\"n\": 99}' WHERE event = 'test.event' AND id = "
        "(SELECT MIN(id) FROM audit_log WHERE event = 'test.event')"
    )
    ok, bad = await state.audit.verify()
    assert not ok and bad is not None


async def test_secrets_are_scrubbed(state: AppState) -> None:
    await state.audit.record("test.secret", password="hunter2hunter2", nested={"api_key": "sk-x"}, cmd="ls")
    row = (await state.audit.query(event="test.secret"))[0]
    assert row.details["password"] == "[redacted]"
    assert row.details["nested"]["api_key"] == "[redacted]"
    assert row.details["cmd"] == "ls"


async def test_query_filters(state: AppState) -> None:
    await state.audit.record("a.one", outcome="ok")
    await state.audit.record("a.two", outcome="failed")
    await state.audit.record("b.one", outcome="ok")
    assert {r.event for r in await state.audit.query(event="a.*")} == {"a.one", "a.two"}
    assert [r.event for r in await state.audit.query(outcome="failed")] == ["a.two"]
