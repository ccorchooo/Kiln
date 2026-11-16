"""Audit, appearance and the events WebSocket."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel

from app.audit.log import to_csv
from app.auth.deps import SessionDep, StateDep, client_ip, websocket_session
from app.state import AppState
from app.system import media
from app.system.sun import appearance_now
from app.system.tools import aur_helper, tool_status

router = APIRouter()

MODE_KEY = "appearance.mode"
THEME_KEY = "appearance.theme"
QUALITY_KEY = "appearance.quality"
THEMES = {"clay", "oat", "cinder", "sage", "dusk", "graphite"}


async def _appearance(state: AppState) -> dict[str, Any]:
    override = await state.db.get_setting(MODE_KEY)
    resolved = appearance_now(
        state.config.appearance, state.config.location, override if override in {"light", "dark"} else None
    )
    return {
        **resolved,
        "preference": override or state.config.appearance.mode,
        "theme": await state.db.get_setting(THEME_KEY) or state.config.appearance.theme,
        "quality": await state.db.get_setting(QUALITY_KEY) or state.config.appearance.quality,
    }


@router.get("/api/public/appearance")
async def public_appearance(state: StateDep) -> dict[str, Any]:
    """Needed by the lock screen before sign-in. Contains no location data."""
    return await _appearance(state)


class AppearanceIn(BaseModel):
    mode: Literal["auto", "light", "dark"] | None = None
    theme: str | None = None
    quality: Literal["auto", "high", "balanced", "low", "off"] | None = None


@router.put("/api/settings/appearance")
async def set_appearance(body: AppearanceIn, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    # Cosmetic preferences: a valid unlocked session is enough (no re-auth).
    if body.mode is not None:
        await state.db.set_setting(MODE_KEY, body.mode)
    if body.theme is not None:
        if body.theme not in THEMES and not body.theme.startswith("custom:"):
            raise HTTPException(400, detail={"code": "bad_theme", "message": "Unknown theme"})
        await state.db.set_setting(THEME_KEY, body.theme)
    if body.quality is not None:
        await state.db.set_setting(QUALITY_KEY, body.quality)
    result = await _appearance(state)
    state.events.publish("appearance", result, lock_safe=True)
    return result


@router.get("/api/audit")
async def audit_list(
    sess: SessionDep,
    state: StateDep,
    event: str | None = None,
    outcome: str | None = None,
    since: float | None = None,
    until: float | None = None,
    q: str | None = None,
    limit: int = Query(200, le=5000),
    before_id: int | None = None,
) -> list[dict[str, Any]]:
    rows = await state.audit.query(
        event=event, outcome=outcome, since=since, until=until, search=q, limit=limit, before_id=before_id
    )
    return [r.as_dict() for r in rows]


@router.get("/api/audit/export")
async def audit_export(
    sess: SessionDep, state: StateDep, fmt: Literal["json", "csv"] = "json", since: float | None = None
) -> Response:
    rows = await state.audit.query(since=since, limit=5000)
    await state.audit.record("audit.exported", session_id=sess.id, format=fmt, rows=len(rows))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if fmt == "csv":
        return Response(
            to_csv(rows),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="kiln-audit-{stamp}.csv"'},
        )
    return Response(
        json.dumps([r.as_dict() for r in rows], indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="kiln-audit-{stamp}.json"'},
    )


@router.get("/api/audit/verify")
async def audit_verify(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    ok, bad = await state.audit.verify()
    return {"ok": ok, "first_bad_id": bad}


@router.get("/api/system/tools")
async def system_tools(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return {
        "aur_helper": aur_helper(state.config.packages.aur_helper),
        "tools": tool_status(["playerctl", "grim", "smartctl", "sensors", "rg", "fd", "tailscale"]),
    }


@router.get("/api/media")
async def media_now(sess: SessionDep) -> dict[str, Any]:
    return await media.now_playing()


class VolumeIn(BaseModel):
    level: float


@router.post("/api/media/volume")
async def media_volume(body: VolumeIn, sess: SessionDep) -> dict[str, Any]:
    try:
        return {"ok": await media.set_volume(body.level)}
    except media.MediaUnavailable as exc:
        raise HTTPException(
            503, detail={"code": "unavailable", "message": "playerctl is not installed", "install": str(exc)}
        ) from exc


@router.post("/api/media/{action}")
async def media_control(action: str, sess: SessionDep) -> dict[str, Any]:
    if action not in media.ACTIONS:
        raise HTTPException(404, detail={"code": "not_found", "message": "Unknown media action"})
    try:
        return {"ok": await media.control(action)}
    except media.MediaUnavailable as exc:
        raise HTTPException(
            503, detail={"code": "unavailable", "message": "playerctl is not installed", "install": str(exc)}
        ) from exc


@router.websocket("/ws/events")
async def events_ws(ws: WebSocket) -> None:
    sess = await websocket_session(ws, allow_locked=True)
    if sess is None:
        return
    state: AppState = ws.app.state.kiln
    await ws.accept()
    await state.audit.record("ws.events_connected", ip=client_ip(ws), session_id=sess.id)
    sub = state.events.subscribe(sess.id)

    async def drain_client() -> None:
        # We don't accept client messages yet; this just notices disconnects.
        while True:
            await ws.receive_text()

    reader = asyncio.create_task(drain_client())
    try:
        while not reader.done():
            try:
                msg = await asyncio.wait_for(sub.queue.get(), timeout=30)
            except TimeoutError:
                msg = {"kind": "ping", "data": {}, "lock_safe": True}
            # Re-validate on every message: the session may have been locked, revoked or panicked.
            # Look up by id: unlocking rotates the cookie token but keeps the session id.
            current = await state.sessions.get(sess.id)
            if current is None:
                await ws.send_json({"kind": "session.ended", "data": {}})
                await ws.close(code=4401)
                return
            if current.locked and not msg.get("lock_safe"):
                continue
            msg.pop("lock_safe", None)
            await ws.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
        state.events.unsubscribe(sub)
