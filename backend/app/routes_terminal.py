"""Terminal sessions (REST + /ws/terminal) and saved command snippets."""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.auth.deps import SessionDep, StateDep, client_ip, websocket_session
from app.state import AppState
from app.terminal.manager import EXIT, KICKED, RESYNC, Consumer, TerminalError

router = APIRouter()

RECHECK_S = 2.0
TITLE_S = 1.0
MAX_INPUT_FRAME = 64 * 1024
MAX_SNIPPETS = 200


# ---------------------------------------------------------------- terminals


class TerminalIn(BaseModel):
    cwd: str | None = Field(default=None, max_length=4096)
    # Typed into the new shell (e.g. a package install from the System app); the user sees and runs it.
    command: str | None = Field(default=None, max_length=4096)
    cols: int = Field(default=80, ge=1, le=10000)
    rows: int = Field(default=24, ge=1, le=10000)


@router.post("/api/terminals")
async def create_terminal(body: TerminalIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    try:
        term = await state.terminals.create(body.cwd, body.cols, body.rows, client_ip(request), sess.id)
    except TerminalError as exc:
        status = 409 if exc.code == "too_many" else 500
        raise HTTPException(status, detail={"code": exc.code, "message": exc.message}) from exc
    if body.command:
        state.terminals.write(term.id, (body.command.replace("\n", " ") + "\n").encode())
    return {
        "id": term.id,
        "title": term.title(),
        "shell": term.shell,
        "cwd": term.cwd,
        "created_at": term.created_at,
    }


@router.get("/api/terminals")
async def list_terminals(sess: SessionDep, state: StateDep) -> list[dict[str, Any]]:
    return [t.public() for t in state.terminals.list()]


@router.delete("/api/terminals/{tid}")
async def delete_terminal(tid: str, sess: SessionDep, state: StateDep) -> dict[str, bool]:
    try:
        await state.terminals.kill(tid, "killed")
        await state.terminals.settle()
    except TerminalError as exc:
        raise HTTPException(404, detail={"code": exc.code, "message": exc.message}) from exc
    return {"ok": True}


@router.websocket("/ws/terminal/{tid}")
async def terminal_ws(ws: WebSocket, tid: str) -> None:
    sess = await websocket_session(ws)
    if sess is None:
        return
    state: AppState = ws.app.state.kiln
    mgr = state.terminals
    term = mgr.terms.get(tid)
    if term is None:
        await ws.close(code=4404)
        return
    await ws.accept()
    consumer, replay = term.attach()
    stop = asyncio.Event()

    async def read_client() -> None:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            raw = msg.get("bytes")
            if raw is not None:
                if len(raw) <= MAX_INPUT_FRAME:
                    mgr.write(tid, raw)
                continue
            try:
                data = json.loads(msg.get("text") or "")
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            kind = data.get("type")
            if kind == "resize":
                cols, rows = data.get("cols"), data.get("rows")
                if isinstance(cols, int) and isinstance(rows, int) and not isinstance(cols, bool):
                    mgr.resize(tid, cols, rows)
            elif kind == "ping":
                await ws.send_json({"type": "pong"})

    async def watch() -> None:
        """Re-check the Kiln session and the title; closes the socket (not the shell) when locked or gone."""
        last_title = term.title()
        last_check = time.monotonic()
        while not stop.is_set():
            await asyncio.sleep(min(TITLE_S, RECHECK_S))
            title = term.title()
            if title != last_title:
                last_title = title
                await ws.send_json({"type": "title", "title": title})
            if time.monotonic() - last_check >= RECHECK_S - 1e-6:
                last_check = time.monotonic()
                current = await state.sessions.get(sess.id)
                if current is None:
                    await ws.close(code=4401)
                    return
                if current.locked:
                    await ws.close(code=4423)
                    return

    async def pump(c: Consumer) -> None:
        while True:
            item = await c.queue.get()
            if isinstance(item, bytes):
                await ws.send_bytes(item)
            elif item is EXIT:
                await ws.send_json({"type": "exit", "code": term.exit_code})
            elif item is KICKED:
                await ws.close(code=4409, reason="attached elsewhere")
                return
            elif item is RESYNC:
                await ws.close(code=4410, reason="too slow; reattach")
                return

    tasks: list[asyncio.Task[None]] = []
    try:
        await ws.send_bytes(replay)
        await ws.send_json({"type": "ready", "title": term.title(), "alive": term.alive, "exit_code": term.exit_code})
        if not term.alive:
            consumer.signal(EXIT)
        tasks = [asyncio.create_task(f()) for f in (read_client, watch)]
        tasks.append(asyncio.create_task(pump(consumer)))
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        stop.set()
        term.detach(consumer)
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t


# ---------------------------------------------------------------- snippets


class SnippetIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    command: str = Field(min_length=1, max_length=4096)
    description: str = Field(default="", max_length=300)


def _snippet(r: Any) -> dict[str, Any]:
    return {k: r[k] for k in ("id", "name", "command", "description", "created_at", "updated_at")}


@router.get("/api/snippets")
async def list_snippets(sess: SessionDep, state: StateDep) -> list[dict[str, Any]]:
    async with state.db.conn.execute("SELECT * FROM snippets ORDER BY name COLLATE NOCASE, created_at") as cur:
        return [_snippet(r) for r in await cur.fetchall()]


@router.post("/api/snippets", status_code=201)
async def create_snippet(body: SnippetIn, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    async with state.db.conn.execute("SELECT COUNT(*) FROM snippets") as cur:
        row = await cur.fetchone()
    if row and row[0] >= MAX_SNIPPETS:
        raise HTTPException(409, detail={"code": "too_many", "message": f"At most {MAX_SNIPPETS} snippets"})
    now = time.time()
    sid = secrets.token_urlsafe(9)
    await state.db.conn.execute(
        "INSERT INTO snippets(id, name, command, description, created_at, updated_at) VALUES(?,?,?,?,?,?)",
        (sid, body.name.strip(), body.command, body.description, now, now),
    )
    await state.audit.record("snippet.created", session_id=sess.id, name=body.name.strip())
    return {
        "id": sid,
        "name": body.name.strip(),
        "command": body.command,
        "description": body.description,
        "created_at": now,
        "updated_at": now,
    }


@router.put("/api/snippets/{sid}")
async def update_snippet(sid: str, body: SnippetIn, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    now = time.time()
    cur = await state.db.conn.execute(
        "UPDATE snippets SET name=?, command=?, description=?, updated_at=? WHERE id=?",
        (body.name.strip(), body.command, body.description, now, sid),
    )
    if cur.rowcount == 0:
        raise HTTPException(404, detail={"code": "not_found", "message": "No such snippet"})
    await state.audit.record("snippet.updated", session_id=sess.id, name=body.name.strip())
    async with state.db.conn.execute("SELECT * FROM snippets WHERE id=?", (sid,)) as c2:
        return _snippet(await c2.fetchone())


@router.delete("/api/snippets/{sid}")
async def delete_snippet(sid: str, sess: SessionDep, state: StateDep) -> dict[str, bool]:
    async with state.db.conn.execute("SELECT name FROM snippets WHERE id=?", (sid,)) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, detail={"code": "not_found", "message": "No such snippet"})
    await state.db.conn.execute("DELETE FROM snippets WHERE id=?", (sid,))
    await state.audit.record("snippet.deleted", session_id=sess.id, name=row["name"])
    return {"ok": True}
