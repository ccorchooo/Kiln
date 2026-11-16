"""Widget configuration (settings key "widgets") and lock-screen filtering of metric payloads."""

from __future__ import annotations

import json
import uuid
from typing import Any

from app.db import Database

SETTINGS_KEY = "widgets"
TYPES = [
    "ai",
    "cpu",
    "gpu",
    "memory",
    "temps",
    "disk",
    "network",
    "clock",
    "weather",
    "media",
    "updates",
    "notifications",
    "battery",
    "uptime",
]
NO_TOPIC = {"clock", "notifications"}
SIZES = {"compact", "expanded"}
MAX_WIDGETS = 8
MAX_OPTIONS_BYTES = 2048
MAX_ID_LEN = 40


class WidgetError(ValueError):
    pass


def topic_for(widget_type: str) -> str | None:
    return None if widget_type in NO_TOPIC else widget_type


def default_widgets() -> list[dict[str, Any]]:
    return [
        {"id": uuid.uuid4().hex[:12], "type": t, "size": "compact", "lock": True, "options": {}}
        for t in ("ai", "weather", "clock")
    ]


def validate_widgets(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise WidgetError("widgets must be a list")
    if len(raw) > MAX_WIDGETS:
        raise WidgetError(f"At most {MAX_WIDGETS} widgets")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise WidgetError("Each widget must be an object")
        wtype = item.get("type")
        if wtype not in TYPES:
            raise WidgetError(f"Unknown widget type: {wtype!r}")
        wid = item.get("id") or uuid.uuid4().hex[:12]
        if not isinstance(wid, str) or not (0 < len(wid) <= MAX_ID_LEN):
            raise WidgetError("Widget id must be a string of at most 40 characters")
        if wid in seen:
            raise WidgetError(f"Duplicate widget id: {wid}")
        seen.add(wid)
        size = item.get("size", "compact")
        if size not in SIZES:
            raise WidgetError(f"Bad widget size: {size!r}")
        lock = item.get("lock", False)
        if not isinstance(lock, bool):
            raise WidgetError("lock must be a boolean")
        options = item.get("options", {})
        if not isinstance(options, dict):
            raise WidgetError("options must be an object")
        try:
            if len(json.dumps(options)) > MAX_OPTIONS_BYTES:
                raise WidgetError("Widget options too large (2 KB max)")
        except (TypeError, ValueError) as exc:
            raise WidgetError("Widget options must be JSON") from exc
        out.append({"id": wid, "type": wtype, "size": size, "lock": lock, "options": options})
    return out


async def load_widgets(db: Database) -> list[dict[str, Any]]:
    raw = await db.get_setting(SETTINGS_KEY)
    if raw is not None:
        try:
            return validate_widgets(json.loads(raw))
        except (ValueError, TypeError):
            pass
    return default_widgets()


async def save_widgets(db: Database, widgets: list[dict[str, Any]]) -> None:
    await db.set_setting(SETTINGS_KEY, json.dumps(widgets))


def lock_topics(widgets: list[dict[str, Any]]) -> set[str]:
    """Topics a locked session may receive: those of widgets with lock=true."""
    return {t for w in widgets if w["lock"] and (t := topic_for(w["type"])) is not None}


def sanitize_for_lock(topic: str, payload: dict[str, Any], widgets: list[dict[str, Any]]) -> dict[str, Any]:
    if topic == "network":
        ts = {k: v for k, v in (payload.get("tailscale") or {}).items() if k not in {"ip", "exit_node"}}
        return {**payload, "tailscale": ts}
    if topic == "media":
        show = any(
            w["type"] == "media" and w["lock"] and w["options"].get("show_titles_on_lock") is True for w in widgets
        )
        playing = payload.get("playing")
        if show or not isinstance(playing, dict):
            return payload
        return {**payload, "playing": {k: v for k, v in playing.items() if k not in {"title", "artist", "album"}}}
    if topic == "ai":
        return {"model": payload.get("model"), "reachable": payload.get("reachable")}
    return payload


def restrict(data: dict[str, Any], locked: bool, widgets: list[dict[str, Any]]) -> dict[str, Any]:
    """Filter a {topic: payload} message for a session's lock state."""
    if not locked:
        return data
    allowed = lock_topics(widgets)
    return {t: sanitize_for_lock(t, p, widgets) for t, p in data.items() if t in allowed}
