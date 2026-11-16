"""Widget settings, metrics snapshot and the /ws/metrics WebSocket."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.auth.deps import AnySessionDep, SessionDep, StateDep, client_ip, websocket_session
from app.state import AppState
from app.system.metrics import ALL_TOPICS
from app.widgets import TYPES, WidgetError, load_widgets, restrict, save_widgets, validate_widgets

router = APIRouter()

RECHECK_S = 5.0


@router.get("/api/settings/widgets")
async def get_widgets(sess: AnySessionDep, state: StateDep) -> dict[str, Any]:
    # Readable while locked: the lock screen renders its own widgets.
    return {"widgets": await load_widgets(state.db), "types": TYPES}


class WidgetsIn(BaseModel):
    widgets: list[dict[str, Any]]


@router.put("/api/settings/widgets")
async def put_widgets(body: WidgetsIn, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    try:
        widgets = validate_widgets(body.widgets)
    except WidgetError as exc:
        raise HTTPException(400, detail={"code": "bad_widgets", "message": str(exc)}) from exc
    await save_widgets(state.db, widgets)
    await state.audit.record(
        "settings.widgets", session_id=sess.id, count=len(widgets), types=[w["type"] for w in widgets]
    )
    state.events.publish("widgets", {"widgets": widgets}, lock_safe=True)
    return {"widgets": widgets, "types": TYPES}


@router.get("/api/metrics/snapshot")
async def metrics_snapshot(sess: SessionDep, state: StateDep, topics: str | None = None) -> dict[str, Any]:
    wanted = set(topics.split(",")) if topics else set(ALL_TOPICS)
    return {"ts": time.time(), "data": await state.metrics.snapshot({t.strip() for t in wanted})}


def _topics_from(msg: Any) -> set[str] | None:
    raw = msg.get("topics")
    if not isinstance(raw, list):
        return None
    return {t for t in raw if isinstance(t, str) and t in ALL_TOPICS}


@router.websocket("/ws/metrics")
async def metrics_ws(ws: WebSocket) -> None:
    sess = await websocket_session(ws, allow_locked=True)
    if sess is None:
        return
    state: AppState = ws.app.state.kiln
    hub = state.metrics
    await ws.accept()
    await state.audit.record("ws.metrics_connected", ip=client_ip(ws), session_id=sess.id)
    sub = hub.subscribe(sess.id)

    async def read_client() -> None:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "subscribe":
                topics = _topics_from(msg)
                if topics is not None:
                    hub.set_topics(sub, topics)
            elif msg.get("type") == "visibility" and isinstance(msg.get("hidden"), bool):
                hub.set_hidden(sub, msg["hidden"])

    reader = asyncio.create_task(read_client())
    locked = sess.locked
    widgets = await load_widgets(state.db)
    last_check = time.monotonic()
    try:
        while not reader.done():
            data: dict[str, Any] = {}
            ts = time.time()
            try:
                ts, data = await asyncio.wait_for(sub.queue.get(), timeout=RECHECK_S)
            except TimeoutError:
                pass
            if time.monotonic() - last_check >= RECHECK_S or not data:
                last_check = time.monotonic()
                # Look up by id: unlocking rotates the cookie token but keeps the session id.
                current = await state.sessions.get(sess.id)
                if current is None:
                    await ws.send_json({"type": "session.ended"})
                    await ws.close(code=4401)
                    return
                new_widgets = await load_widgets(state.db)
                if current.locked != locked or new_widgets != widgets:
                    locked, widgets = current.locked, new_widgets
                    # Filter changed: resend everything now allowed so the client is never stale.
                    data = {**data, **{t: v for t, v in hub.latest.items() if t in sub.topics}}
            out = restrict(data, locked, widgets) if data else {}
            if out:
                await ws.send_json({"type": "metrics", "ts": ts, "data": out})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await reader
        hub.unsubscribe(sub)
