"""System app API (/api/system/*) and the Logs app's live journal (/ws/logs).

Reads need an unlocked session; every action also needs a recent password confirmation and is
audited. Root actions accept a one-shot sudo password that is never stored or logged.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.auth.deps import RecentAuthDep, SessionDep, StateDep, client_ip, websocket_session
from app.state import AppState
from app.system import admin
from app.system.admin import AdminError

router = APIRouter()
RECHECK_S = 2.0
BATCH_S = 0.2


def _err(exc: AdminError) -> HTTPException:
    return HTTPException(exc.status, detail={"code": exc.code, "message": exc.message})


class SignalIn(BaseModel):
    force: bool = False


class ServiceActionIn(BaseModel):
    action: Literal["start", "stop", "restart", "enable", "disable"]
    user: bool = False
    sudo_password: str | None = Field(default=None, max_length=1024)


class PowerIn(BaseModel):
    sudo_password: str | None = Field(default=None, max_length=1024)


@router.get("/api/system/processes")
async def processes(sess: SessionDep) -> dict[str, Any]:
    return {"processes": await asyncio.to_thread(admin.list_processes)}


@router.post("/api/system/processes/{pid}/signal")
async def process_signal(
    pid: int, body: SignalIn, request: Request, sess: RecentAuthDep, state: StateDep
) -> dict[str, Any]:
    try:
        name = admin.signal_process(pid, body.force)
    except AdminError as exc:
        raise _err(exc) from exc
    await state.audit.record(
        "system.process_signal", ip=client_ip(request), session_id=sess.id, pid=pid, name=name, force=body.force
    )
    return {"ok": True}


@router.get("/api/system/services")
async def services(sess: SessionDep, user: bool = False) -> dict[str, Any]:
    try:
        return {"services": await admin.list_services(user)}
    except AdminError as exc:
        raise _err(exc) from exc


@router.post("/api/system/services/{unit}")
async def service_action(
    unit: str, body: ServiceActionIn, request: Request, sess: RecentAuthDep, state: StateDep
) -> dict[str, Any]:
    try:
        await admin.service_action(unit, body.action, body.user, body.sudo_password)
    except AdminError as exc:
        raise _err(exc) from exc
    finally:
        body.sudo_password = None
    await state.audit.record(
        "system.service", ip=client_ip(request), session_id=sess.id, unit=unit, action=body.action, user=body.user
    )
    return {"ok": True}


@router.get("/api/system/packages")
async def packages(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return await admin.packages(state.config.packages.aur_helper)


@router.get("/api/system/packages/search")
async def package_search(q: str, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    try:
        return {"results": await admin.search_packages(q[:200], state.config.packages.aur_helper)}
    except AdminError as exc:
        raise _err(exc) from exc


@router.get("/api/system/network")
async def network(sess: SessionDep) -> dict[str, Any]:
    interfaces, peers = await asyncio.gather(asyncio.to_thread(admin.network), admin.tailscale_peers())
    return {"interfaces": interfaces, "tailscale": peers, "at": time.time()}


@router.get("/api/system/storage")
async def storage(sess: SessionDep) -> dict[str, Any]:
    return await admin.storage()


@router.post("/api/system/power/{action}")
async def power(
    action: Literal["suspend", "reboot", "poweroff"],
    body: PowerIn,
    request: Request,
    sess: RecentAuthDep,
    state: StateDep,
) -> dict[str, Any]:
    await state.audit.record("system.power", ip=client_ip(request), session_id=sess.id, action=action)
    try:
        await admin.systemctl_root([action], body.sudo_password)
    except AdminError as exc:
        raise _err(exc) from exc
    finally:
        body.sudo_password = None
    return {"ok": True}


@router.websocket("/ws/logs")
async def logs_ws(ws: WebSocket) -> None:
    """Live journal. The client sends {type: "filter", ...} to (re)start the stream."""
    sess = await websocket_session(ws)
    if sess is None:
        return
    state: AppState = ws.app.state.kiln
    await ws.accept()
    stream: asyncio.Task[None] | None = None

    async def follow(argv: list[str]) -> None:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=admin._env()
        )
        assert proc.stdout is not None
        batch: list[dict[str, Any]] = []
        last = time.monotonic()
        try:
            while True:
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=BATCH_S)
                except TimeoutError:
                    line = None
                if line == b"":
                    break
                if line:
                    entry = admin.journal_entry(line.decode("utf-8", "replace"))
                    if entry is not None:
                        batch.append(entry)
                    elif line.strip():  # journalctl complaining (bad regex, no access…)
                        await ws.send_json({"type": "error", "message": line.decode("utf-8", "replace").strip()})
                if batch and (line is None or len(batch) >= 500 or time.monotonic() - last > BATCH_S):
                    await ws.send_json({"type": "entries", "entries": batch})
                    batch = []
                    last = time.monotonic()
            if batch:
                await ws.send_json({"type": "entries", "entries": batch})
            await ws.send_json({"type": "ended", "code": await proc.wait()})
        finally:
            if proc.returncode is None:
                proc.kill()
                with contextlib.suppress(Exception):
                    await proc.wait()

    async def read_client() -> None:
        nonlocal stream
        while True:
            try:
                data = json.loads(await ws.receive_text())
            except ValueError:
                continue
            if not isinstance(data, dict) or data.get("type") != "filter":
                continue
            try:
                argv = admin.journal_argv(data)
            except AdminError as exc:
                await ws.send_json({"type": "error", "message": exc.message})
                continue
            if stream is not None:
                stream.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await stream
            await ws.send_json({"type": "reset"})
            stream = asyncio.create_task(follow(argv))

    async def watch() -> None:
        while True:
            await asyncio.sleep(RECHECK_S)
            current = await state.sessions.get(sess.id)
            if current is None or current.locked:
                await ws.close(code=4401 if current is None else 4423)
                return

    tasks = [asyncio.create_task(read_client()), asyncio.create_task(watch())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if stream is not None:
            tasks.append(stream)
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
