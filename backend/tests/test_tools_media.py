from __future__ import annotations

import os
import stat
from pathlib import Path

import httpx
import pytest

from app.state import AppState
from app.system import media, tools
from tests.conftest import login


def test_aur_helper_preference(monkeypatch: pytest.MonkeyPatch) -> None:
    present = {"yay", "paru"}
    monkeypatch.setattr(tools.shutil, "which", lambda n: f"/usr/bin/{n}" if n in present else None)
    assert tools.aur_helper("auto") == "yay"
    assert tools.aur_helper("paru") == "paru"
    present.discard("paru")
    assert tools.aur_helper("paru") == "yay"  # falls back when the preferred one is missing
    present.clear()
    assert tools.aur_helper() is None


async def test_media_unavailable(client: httpx.AsyncClient, state: AppState, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(media, "which", lambda n: None)
    csrf = await login(client, state)
    r = await client.get("/api/media")
    assert r.json() == {"available": False, "install": "sudo pacman -S playerctl"}
    r = await client.post("/api/media/play-pause", headers={"x-csrf-token": csrf})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "unavailable"
    assert (await client.post("/api/media/rm-rf", headers={"x-csrf-token": csrf})).status_code == 404


async def test_media_with_fake_playerctl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = tmp_path / "playerctl"
    fake.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = metadata ]; then printf "spotify\\037Playing\\037Song\\037Artist\\037Album\\037180000000\\037'
        '42000000\\0370.5"; fi\n'
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(media, "which", lambda n: str(fake))
    now = await media.now_playing()
    assert now["playing"]["title"] == "Song" and now["playing"]["length"] == 180.0
    assert now["playing"]["position"] == 42.0 and now["playing"]["volume"] == 0.5
    assert await media.control("next")
    with pytest.raises(ValueError):
        await media.control("reboot")
    assert os.access(fake, os.X_OK)
