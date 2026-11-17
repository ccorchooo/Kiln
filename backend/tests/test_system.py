from __future__ import annotations

import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.auth.sessions import COOKIE_NAME
from app.config import Config
from app.main import create_app
from app.state import AppState
from app.system import admin
from app.system.admin import AdminError
from tests.conftest import ORIGIN, PASSWORD

Ctx = tuple[TestClient, AppState, dict[str, str]]


@pytest.fixture
def config(tmp_path: Path) -> Config:
    cfg = Config()
    cfg.data_dir = str(tmp_path / "data")
    cfg.server.web_root = str(tmp_path / "no-web")
    cfg.files.jail_root = str(tmp_path)
    return cfg


@pytest.fixture
def fx(config: Config) -> Iterator[Ctx]:
    app = create_app(config)
    with TestClient(app, base_url=ORIGIN, headers={"origin": ORIGIN}) as c:
        state: AppState = app.state.kiln
        c.portal.call(state.credentials.set_password, PASSWORD)  # type: ignore[union-attr]
        r = c.post("/api/auth/unlock", json={"password": PASSWORD})
        assert r.status_code == 200
        c.portal.call(state.db.conn.execute, "UPDATE sessions SET reauth_until = 0")  # type: ignore[union-attr]
        yield c, state, {"x-csrf-token": r.json()["csrf"]}


def reauth(c: TestClient, h: dict[str, str]) -> None:
    assert c.post("/api/auth/reauth", json={"password": PASSWORD}, headers=h).status_code == 200


# --------------------------------------------------------------------------- parsers


def test_parse_search_repo_and_aur() -> None:
    out = (
        "extra/htop 3.3.0-1 [installed]\n"
        "    Interactive process viewer\n"
        "aur/htop-git 3.3.0.r1-1 (+12 0.50) (Out-of-date: 2024-01-01)\n"
        "    htop from git\n"
    )
    rows = admin.parse_search(out)
    assert rows == [
        {
            "repo": "extra",
            "name": "htop",
            "version": "3.3.0-1",
            "installed": True,
            "description": "Interactive process viewer",
        },
        {
            "repo": "aur",
            "name": "htop-git",
            "version": "3.3.0.r1-1",
            "installed": False,
            "description": "htop from git",
        },  # noqa: E501
    ]


def test_parse_updates() -> None:
    out = "linux 6.11.1-1 -> 6.11.2-1\ngarbage line\nmesa 24.2.3-1 -> 24.2.4-1 [ignored]\n"
    assert admin.parse_updates(out) == [
        {"name": "linux", "from": "6.11.1-1", "to": "6.11.2-1"},
        {"name": "mesa", "from": "24.2.3-1", "to": "24.2.4-1"},
    ]


def test_merge_services_adds_unloaded_files_and_skips_templates() -> None:
    units = [{"unit": "sshd.service", "description": "OpenSSH", "load": "loaded", "active": "active", "sub": "running"}]
    files = [
        {"unit_file": "sshd.service", "state": "enabled"},
        {"unit_file": "cups.service", "state": "disabled"},
        {"unit_file": "getty@.service", "state": "enabled"},
        {"unit_file": "foo.socket", "state": "enabled"},
    ]
    rows = admin.merge_services(units, files)
    assert [r["unit"] for r in rows] == ["cups.service", "sshd.service"]
    assert rows[1]["enabled"] == "enabled" and rows[1]["active"] == "active"
    assert rows[0]["active"] == "inactive" and rows[0]["enabled"] == "disabled"


@pytest.mark.parametrize(
    "bad",
    [
        {"unit": "sshd; rm -rf /"},
        {"priority": "loud"},
        {"grep": "x" * 201},
        {"since": "$(reboot)"},
        {"lines": 99999},
        {"lines": True},
    ],
)
def test_journal_argv_rejects_bad_filters(bad: dict[str, Any]) -> None:
    with pytest.raises(AdminError):
        admin.journal_argv(bad)


def test_journal_argv_builds_filters() -> None:
    argv = admin.journal_argv({"unit": "kiln.service", "user": True, "priority": "err", "grep": "fail.*x", "lines": 50})
    assert argv[:7] == ["journalctl", "--no-pager", "-o", "json", "-f", "-n", "50"]
    assert ["--user-unit", "kiln.service"] == argv[argv.index("--user-unit") : argv.index("--user-unit") + 2]
    assert "--grep" in argv and "fail.*x" in argv and "-p" in argv


def test_journal_entry_decodes_binary_messages() -> None:
    e = admin.journal_entry('{"MESSAGE": [104, 105], "PRIORITY": "3", "__REALTIME_TIMESTAMP": "2000000"}')
    assert e is not None and e["msg"] == "hi" and e["prio"] == 3 and e["t"] == 2.0
    assert admin.journal_entry("not json") is None


async def test_systemctl_root_falls_back_to_sudo(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], bytes | None]] = []
    replies = iter(
        [
            (1, "Failed: Interactive authentication required."),
            (1, "Sorry, try again.\nsudo: no password was provided"),
            (0, ""),
        ]
    )

    async def fake_run(argv: list[str], stdin: bytes | None = None, timeout: float = 30.0) -> tuple[int, str]:  # noqa: ASYNC109
        calls.append((argv, stdin))
        return next(replies)

    monkeypatch.setattr(admin, "run", fake_run)
    with pytest.raises(AdminError) as e1:
        await admin.systemctl_root(["reboot"], None)
    assert e1.value.code == "sudo_required"
    assert calls[0][0] == ["systemctl", "--no-ask-password", "reboot"]
    with pytest.raises(AdminError) as e2:
        await admin.systemctl_root(["reboot"], "wrong")
    assert e2.value.code == "sudo_rejected"
    await admin.systemctl_root(["restart", "cups.service"], "right")
    argv, stdin = calls[2]
    assert argv == ["sudo", "-k", "-S", "-p", "", "--", "systemctl", "restart", "cups.service"]
    assert stdin == b"right\n"


# --------------------------------------------------------------------------- routes


def test_processes_and_signal(fx: Ctx) -> None:
    c, state, h = fx
    listing = c.get("/api/system/processes").json()["processes"]
    assert any(p["pid"] for p in listing) and {"pid", "name", "cpu", "rss", "mine"} <= set(listing[0])
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])  # noqa: S603
    try:
        # Stopping a process needs a fresh password.
        r = c.post(f"/api/system/processes/{child.pid}/signal", json={}, headers=h)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "reauth_required"
        reauth(c, h)
        assert c.post(f"/api/system/processes/{child.pid}/signal", json={}, headers=h).status_code == 200
        assert child.wait(timeout=5) != 0
        r = c.post("/api/system/processes/1/signal", json={"force": True}, headers=h)
        assert r.status_code == 400 and r.json()["detail"]["code"] == "protected"
    finally:
        child.kill()

    async def q() -> list[Any]:
        return await state.audit.query(event="system.*")

    events = c.portal.call(q)  # type: ignore[union-attr]
    assert any(e.event == "system.process_signal" for e in events)


def test_service_action_validates_and_protects_kiln(fx: Ctx) -> None:
    c, _, h = fx
    reauth(c, h)
    r = c.post("/api/system/services/x;reboot.service", json={"action": "restart", "user": True}, headers=h)
    assert r.status_code in {400, 404}
    r = c.post("/api/system/services/kiln.service", json={"action": "stop", "user": True}, headers=h)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "protected"
    r = c.post("/api/system/services/sshd.service", json={"action": "explode"}, headers=h)
    assert r.status_code == 422


def test_power_needs_recent_auth(fx: Ctx) -> None:
    c, _, h = fx
    r = c.post("/api/system/power/reboot", json={}, headers=h)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "reauth_required"
    reauth(c, h)
    assert c.post("/api/system/power/selfdestruct", json={}, headers=h).status_code == 422


def test_logs_ws_streams_entries(fx: Ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    c, _, _ = fx
    lines = '{"MESSAGE":"hello","PRIORITY":"3","__REALTIME_TIMESTAMP":"1000000","SYSLOG_IDENTIFIER":"t"}\\n'
    monkeypatch.setattr(admin, "journal_argv", lambda f: ["printf", lines + "not json\\n"])
    hdr = {"origin": ORIGIN, "host": "kiln.test", "cookie": f"{COOKIE_NAME}={c.cookies.get(COOKIE_NAME)}"}
    with c.websocket_connect("/ws/logs", headers=hdr) as ws:
        ws.send_json({"type": "filter", "lines": 10})
        seen: list[dict[str, Any]] = []
        while not any(m["type"] == "ended" for m in seen):
            seen.append(ws.receive_json())
    kinds = [m["type"] for m in seen]
    assert kinds[0] == "reset" and "entries" in kinds and "error" in kinds
    entry = next(m for m in seen if m["type"] == "entries")["entries"][0]
    assert entry["msg"] == "hello" and entry["prio"] == 3 and entry["ident"] == "t"


def test_logs_ws_requires_session(config: Config) -> None:
    app = create_app(config)
    with TestClient(app, base_url=ORIGIN) as c, pytest.raises(Exception):  # noqa: B017, PT011
        with c.websocket_connect("/ws/logs", headers={"origin": ORIGIN, "host": "kiln.test"}) as ws:
            ws.receive_json()
