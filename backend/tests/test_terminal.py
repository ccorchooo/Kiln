from __future__ import annotations

import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from app import routes_terminal
from app.auth.sessions import COOKIE_NAME
from app.config import Config
from app.main import create_app
from app.state import AppState
from tests.conftest import ORIGIN, PASSWORD


@pytest.fixture
def tc(config: Config) -> Iterator[tuple[TestClient, AppState, dict[str, str]]]:
    config.terminal.shell = "/bin/sh"
    app = create_app(config)
    with TestClient(app, base_url=ORIGIN, headers={"origin": ORIGIN}) as c:
        state: AppState = app.state.kiln
        c.portal.call(state.credentials.set_password, PASSWORD)  # type: ignore[union-attr]
        r = c.post("/api/auth/unlock", json={"password": PASSWORD})
        assert r.status_code == 200
        yield c, state, {"x-csrf-token": r.json()["csrf"]}


def _ws_headers(c: TestClient) -> dict[str, str]:
    # The session cookie is Secure, so the jar will not send it over ws://; pass it explicitly.
    return {"origin": ORIGIN, "host": "kiln.test", "cookie": f"{COOKIE_NAME}={c.cookies.get(COOKIE_NAME)}"}


def _new(c: TestClient, h: dict[str, str], **body: Any) -> dict[str, Any]:
    r = c.post("/api/terminals", json={"cols": 80, "rows": 24, **body}, headers=h)
    assert r.status_code == 200, r.text
    out: dict[str, Any] = r.json()
    return out


def _recv(ws: WebSocketTestSession) -> dict[str, Any]:
    msg: dict[str, Any] = ws.receive()
    if msg["type"] == "websocket.close":
        raise WebSocketDisconnect(msg.get("code", 1000), msg.get("reason"))
    return msg


def _read_until(ws: WebSocketTestSession, needle: bytes, limit: int = 400) -> bytes:
    got = b""
    for _ in range(limit):
        msg = _recv(ws)
        if msg.get("bytes"):
            got += msg["bytes"]
            if needle in got:
                return got
    raise AssertionError(f"never saw {needle!r}; got {got[-200:]!r}")


def _read_json_until(ws: WebSocketTestSession, kind: str, limit: int = 400) -> dict[str, Any]:
    for _ in range(limit):
        msg = _recv(ws)
        if msg.get("text"):
            import json

            data: dict[str, Any] = json.loads(msg["text"])
            if data.get("type") == kind:
                return data
    raise AssertionError(f"never saw {kind}")


def _attach(c: TestClient, tid: str) -> Any:
    return c.websocket_connect(f"/ws/terminal/{tid}", headers=_ws_headers(c))


def _ready(ws: WebSocketTestSession) -> tuple[bytes, dict[str, Any]]:
    replay = ws.receive_bytes()
    return replay, ws.receive_json()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_create_echo_resize_replay_and_kick(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    info = _new(c, h)
    assert set(info) == {"id", "title", "shell", "cwd", "created_at"} and info["shell"] == "/bin/sh"
    tid = info["id"]
    with _attach(c, tid) as ws:
        replay, ready = _ready(ws)
        assert ready["type"] == "ready" and ready["alive"] is True and ready["exit_code"] is None
        ws.send_json({"type": "resize", "cols": 100, "rows": 30})
        ws.send_json({"type": "ping"})
        assert _read_json_until(ws, "pong")
        ws.send_bytes(b"echo kiln-$((40+2))\n")
        _read_until(ws, b"kiln-42")
        listing = c.get("/api/terminals").json()
        assert listing[0]["id"] == tid and listing[0]["attached"] is True
    # Re-attach: the replay buffer holds the earlier output.
    with _attach(c, tid) as ws2:
        replay, _ = _ready(ws2)
        assert b"kiln-42" in replay
        # A second consumer kicks the first.
        with _attach(c, tid) as ws3:
            _ready(ws3)
            with pytest.raises(WebSocketDisconnect) as exc:
                for _ in range(50):
                    _recv(ws2)
            assert exc.value.code == 4409
    assert c.get("/api/terminals").json()[0]["alive"] is True  # detaching never kills


def test_exit_reports_code_and_alive_false(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    tid = _new(c, h)["id"]
    with _attach(c, tid) as ws:
        _ready(ws)
        ws.send_bytes(b"exit 3\n")
        msg = _read_json_until(ws, "exit")
        assert msg["code"] == 3
    entry = next(t for t in c.get("/api/terminals").json() if t["id"] == tid)
    assert entry["alive"] is False and entry["exit_code"] == 3
    # Reattaching shows the final state.
    with _attach(c, tid) as ws2:
        _, ready = _ready(ws2)
        assert ready["alive"] is False and ready["exit_code"] == 3
        assert _read_json_until(ws2, "exit")["code"] == 3


def test_delete_kills_and_unknown_404(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    info = _new(c, h)
    pid = state.terminals.terms[info["id"]].pid
    assert _alive(pid)
    assert c.delete(f"/api/terminals/{info['id']}", headers=h).json() == {"ok": True}
    assert not _alive(pid)
    assert c.get("/api/terminals").json() == []
    assert c.delete(f"/api/terminals/{info['id']}", headers=h).status_code == 404
    with pytest.raises(WebSocketDisconnect) as exc, _attach(c, info["id"]):
        pass
    assert exc.value.code == 4404


def test_requires_session_and_csrf(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, _, h = tc
    r = c.post("/api/terminals", json={"cols": 80, "rows": 24})
    assert r.status_code == 403
    assert c.post("/api/auth/lock", headers=h).status_code == 200
    assert c.get("/api/terminals").status_code == 423


def test_max_sessions(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    state.config.terminal.max_sessions = 1
    _new(c, h)
    r = c.post("/api/terminals", json={"cols": 80, "rows": 24}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "too_many"


def test_cwd_confined_to_home(tc: tuple[TestClient, AppState, dict[str, str]], tmp_path: Path) -> None:
    c, _, h = tc
    home = str(tmp_path.resolve())
    (tmp_path / "proj").mkdir()
    assert _new(c, h, cwd="/etc")["cwd"] == home
    assert _new(c, h, cwd=str(tmp_path / "nope"))["cwd"] == home
    assert _new(c, h)["cwd"] == home
    assert _new(c, h, cwd=str(tmp_path / "proj"))["cwd"] == str(tmp_path.resolve() / "proj")


def test_env_scrubbed(tc: tuple[TestClient, AppState, dict[str, str]], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KILN_SECRET_TEST", "hunter2")
    c, _, h = tc
    tid = _new(c, h)["id"]
    with _attach(c, tid) as ws:
        _ready(ws)
        ws.send_bytes(b"echo a=${KILN_SECRET_TEST:-unset} b=$KILN_TERMINAL t=$TERM\n")
        out = _read_until(ws, b"t=xterm-256color")
        assert b"a=unset b=1" in out and b"hunter2" not in out


def test_locked_session_cannot_open_and_open_ws_closed(
    tc: tuple[TestClient, AppState, dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(routes_terminal, "RECHECK_S", 0.1)
    monkeypatch.setattr(routes_terminal, "TITLE_S", 0.1)
    c, state, h = tc
    info = _new(c, h)
    pid = state.terminals.terms[info["id"]].pid
    with _attach(c, info["id"]) as ws:
        _ready(ws)
        assert c.post("/api/auth/lock", headers=h).status_code == 200
        with pytest.raises(WebSocketDisconnect) as exc:
            for _ in range(200):
                _recv(ws)
        assert exc.value.code == 4423
    assert _alive(pid)  # locking leaves shells running
    with pytest.raises(WebSocketDisconnect) as exc2, _attach(c, info["id"]):
        pass
    assert exc2.value.code == 4401


def test_panic_hook_kills_everything(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    pids = [state.terminals.terms[_new(c, h)["id"]].pid for _ in range(2)]
    assert state.panic_hooks
    for hook in state.panic_hooks:
        c.portal.call(hook)  # type: ignore[union-attr]
    assert not any(_alive(p) for p in pids)
    assert c.get("/api/terminals").json() == []
    ends = c.portal.call(lambda: state.audit.query(event="terminal.end"))  # type: ignore[union-attr]
    assert {e.details["reason"] for e in ends} == {"panic"}


def test_audit_start_and_end_without_contents(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    tid = _new(c, h)["id"]
    with _attach(c, tid) as ws:
        _ready(ws)
        ws.send_bytes(b"echo topsecret-contents\n")
        _read_until(ws, b"topsecret-contents")
        ws.send_bytes(b"exit\n")
        _read_json_until(ws, "exit")
    time.sleep(0.1)
    start = c.portal.call(lambda: state.audit.query(event="terminal.start"))  # type: ignore[union-attr]
    end = c.portal.call(lambda: state.audit.query(event="terminal.end"))  # type: ignore[union-attr]
    assert len(start) == 1 and start[0].details["id"] == tid and start[0].details["shell"] == "/bin/sh"
    assert start[0].session_id and start[0].ip
    assert len(end) == 1 and end[0].details["reason"] == "exit" and end[0].details["exit_code"] == 0
    assert "duration_s" in end[0].details
    everything = c.portal.call(lambda: state.audit.query(limit=500))  # type: ignore[union-attr]
    assert "topsecret" not in str([e.details for e in everything])


def test_detached_terminal_expires(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    state.config.terminal.keep_alive_minutes = 0.01  # 0.6s
    info = _new(c, h)
    pid = state.terminals.terms[info["id"]].pid
    deadline = time.time() + 8
    while time.time() < deadline and _alive(pid):
        time.sleep(0.1)
    assert not _alive(pid)
    ends = c.portal.call(lambda: state.audit.query(event="terminal.end"))  # type: ignore[union-attr]
    assert ends and ends[0].details["reason"] == "expired"


def test_scrollback_is_bounded(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    state.config.terminal.scrollback_bytes = 2048
    tid = _new(c, h)["id"]
    with _attach(c, tid) as ws:
        _ready(ws)
        ws.send_bytes(
            b"i=0; while [ $i -lt 400 ]; do echo line-$i-xxxxxxxxxxxxxxxx; i=$((i+1)); done; echo DONE-$((1+1))\n"
        )
        _read_until(ws, b"DONE-2\r\n")
    assert len(state.terminals.terms[tid].buffer) <= 2048


# ---------------------------------------------------------------- snippets


def test_snippets_crud_validation_limit(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, state, h = tc
    assert c.get("/api/snippets").json() == []
    r = c.post("/api/snippets", json={"name": "zeta", "command": "ls -la", "description": "list"}, headers=h)
    assert r.status_code == 201
    a = r.json()
    c.post("/api/snippets", json={"name": "alpha", "command": "echo SECRETCMD"}, headers=h)
    assert [s["name"] for s in c.get("/api/snippets").json()] == ["alpha", "zeta"]
    r = c.put(f"/api/snippets/{a['id']}", json={"name": "zeta2", "command": "pwd"}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "zeta2" and r.json()["description"] == ""
    assert c.put("/api/snippets/nope", json={"name": "x", "command": "y"}, headers=h).status_code == 404
    for bad in (
        {"name": "", "command": "x"},
        {"name": "n" * 81, "command": "x"},
        {"name": "n", "command": ""},
        {"name": "n", "command": "c" * 4097},
        {"name": "n", "command": "c", "description": "d" * 301},
    ):
        assert c.post("/api/snippets", json=bad, headers=h).status_code == 422, bad
    assert c.post("/api/snippets", json={"name": "n", "command": "c"}).status_code == 403
    assert c.delete(f"/api/snippets/{a['id']}", headers=h).json() == {"ok": True}
    assert c.delete(f"/api/snippets/{a['id']}", headers=h).status_code == 404
    events = c.portal.call(lambda: state.audit.query(search="snippet."))  # type: ignore[union-attr]
    assert {e.event for e in events} == {"snippet.created", "snippet.updated", "snippet.deleted"}
    assert "SECRETCMD" not in str([e.details for e in events]) and "pwd" not in str([e.details for e in events])


def test_snippet_limit(tc: tuple[TestClient, AppState, dict[str, str]]) -> None:
    c, _, h = tc
    for i in range(routes_terminal.MAX_SNIPPETS):
        assert c.post("/api/snippets", json={"name": f"s{i}", "command": "true"}, headers=h).status_code == 201
    r = c.post("/api/snippets", json={"name": "one-more", "command": "true"}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "too_many"
