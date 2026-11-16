"""MPRIS media control via playerctl. Reports unavailable (with a hint) until it's installed."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from app.system.tools import INSTALL_HINTS, which

Action = Literal["play-pause", "play", "pause", "next", "previous", "stop"]
ACTIONS: set[str] = {"play-pause", "play", "pause", "next", "previous", "stop"}
_FIELDS = ["playerName", "status", "xesam:title", "xesam:artist", "xesam:album", "mpris:length", "position", "volume"]
_SEP = "\x1f"


class MediaUnavailable(Exception):
    pass


TIMEOUT_S = 3.0


async def _run(*args: str) -> tuple[int, str]:
    exe = which("playerctl")
    if exe is None:
        raise MediaUnavailable(INSTALL_HINTS["playerctl"])
    proc = await asyncio.create_subprocess_exec(
        exe, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT_S)
    except TimeoutError:
        proc.kill()
        return 124, ""
    return proc.returncode or 0, out.decode(errors="replace").strip()


def _num(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:
        return None


async def now_playing() -> dict[str, Any]:
    if which("playerctl") is None:
        return {"available": False, "install": INSTALL_HINTS["playerctl"]}
    fmt = _SEP.join("{{" + f + "}}" for f in _FIELDS)
    code, out = await _run("metadata", "--format", fmt)
    if code != 0 or not out:
        return {"available": True, "playing": None}
    vals = dict(zip(_FIELDS, out.split(_SEP), strict=False))
    length_us = _num(vals.get("mpris:length", ""))
    position_us = _num(vals.get("position", ""))
    return {
        "available": True,
        "playing": {
            "player": vals.get("playerName"),
            "status": vals.get("status"),
            "title": vals.get("xesam:title") or None,
            "artist": vals.get("xesam:artist") or None,
            "album": vals.get("xesam:album") or None,
            "length": length_us / 1e6 if length_us else None,
            "position": position_us / 1e6 if position_us else None,
            "volume": _num(vals.get("volume", "")),
        },
    }


async def control(action: str) -> bool:
    if action not in ACTIONS:
        raise ValueError(f"unknown media action: {action}")
    code, _ = await _run(action)
    return code == 0


async def set_volume(level: float) -> bool:
    code, _ = await _run("volume", f"{max(0.0, min(1.0, level)):.2f}")
    return code == 0
