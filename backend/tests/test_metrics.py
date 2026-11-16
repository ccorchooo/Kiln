from __future__ import annotations

import time
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import routes_metrics
from app.auth.sessions import COOKIE_NAME
from app.config import Config
from app.main import create_app
from app.state import AppState
from app.system import metrics, tools
from app.system.metrics import Collectors
from app.widgets import default_widgets, restrict
from tests.conftest import ORIGIN, PASSWORD, login

# ---------------------------------------------------------------- collectors


async def test_collectors_return_keys_and_never_raise(config: Config) -> None:
    c = Collectors(config)
    expected = {
        "cpu": {"usage", "per_core", "freq_mhz", "temp_c"},
        "memory": {"used", "total", "percent", "swap_used", "swap_total", "swap_percent"},
        "gpu": {"available", "vendor", "name", "usage", "temp_c", "vram_used_mb", "vram_total_mb", "power_w"},
        "temps": {"sensors", "hottest"},
        "disk": {"mounts", "read_bps", "write_bps"},
        "network": {"up_bps", "down_bps", "tailscale"},
        "battery": {"present", "percent", "plugged", "secs_left"},
        "uptime": {"uptime_s", "load"},
        "updates": {"available", "repo", "aur", "checked_at", "checking"},
        "weather": {"available", "city", "forecast", "fetched_at"},
        "media": {"available"},
        "ai": {"model", "reachable", "base_url_host"},
    }
    for topic, keys in expected.items():
        data = await c.collect(topic)
        assert keys <= set(data), (topic, data)
    assert len((await c.collect("temps"))["sensors"]) <= 6


def test_rate() -> None:
    assert metrics.rate(1000, 3000, 2.0) == 1000.0
    assert metrics.rate(None, 3000, 2.0) is None
    assert metrics.rate(5000, 100, 1.0) == 0.0  # counter reset


async def test_network_and_disk_rates_from_fake_counters(config: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    class NIC:
        def __init__(self, s: int, r: int) -> None:
            self.bytes_sent, self.bytes_recv = s, r

    class IO:
        def __init__(self, r: int, w: int) -> None:
            self.read_bytes, self.write_bytes = r, w

    # [sent, recv, read, write, now]
    cur = [0, 0, 0, 0, 100.0]
    monkeypatch.setattr(
        metrics.psutil, "net_io_counters", lambda pernic=False: {"lo": NIC(10**9, 10**9), "eth0": NIC(cur[0], cur[1])}
    )
    monkeypatch.setattr(metrics.psutil, "disk_io_counters", lambda: IO(cur[2], cur[3]))
    monkeypatch.setattr(metrics, "time", SimpleNamespace(monotonic=lambda: cur[4], time=time.time))
    monkeypatch.setattr(Collectors, "_tailscale", lambda self: _async({}))
    c = Collectors(config)
    assert (await c.collect_network())["up_bps"] is None
    assert (await c.collect_disk())["read_bps"] is None
    cur[:] = [1000, 4000, 2000, 500, 102.0]
    net = await c.collect_network()
    assert net["up_bps"] == 500.0 and net["down_bps"] == 2000.0  # lo excluded, dt=2s
    disk = await c.collect_disk()
    assert disk["read_bps"] == 1000.0 and disk["write_bps"] == 250.0


async def _async(v: Any) -> Any:
    return v


def test_gpu_parser_handles_na() -> None:
    out = "NVIDIA GeForce RTX 3080, 7, 45, 1024, 10240, 38.50\n"
    g = metrics.parse_nvidia_smi(out)
    assert g and g["name"] == "NVIDIA GeForce RTX 3080" and g["usage"] == 7 and g["vram_total_mb"] == 10240
    assert g["power_w"] == 38.5 and g["vendor"] == "nvidia"
    g = metrics.parse_nvidia_smi("NVIDIA GeForce RTX 3080, [N/A], 45, [N/A], 10240, [N/A]")
    assert g and g["usage"] is None and g["vram_used_mb"] is None and g["power_w"] is None
    assert metrics.parse_nvidia_smi("garbage") is None


async def test_tailscale_missing(config: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(metrics, "which", lambda n: None)
    ts = await Collectors(config)._tailscale()
    assert ts["installed"] is False and ts["running"] is False and "install" in ts


def test_parse_tailscale() -> None:
    data = {
        "BackendState": "Running",
        "Self": {"TailscaleIPs": ["100.1.2.3", "fd7a::1"]},
        "Peer": {
            "a": {"Online": True, "ID": "n1", "HostName": "vps", "ExitNode": True},
            "b": {"Online": False, "ID": "n2"},
            "c": {"Online": True, "ID": "n3"},
        },
        "ExitNodeStatus": {"ID": "n1", "Online": True},
    }
    assert metrics.parse_tailscale(data) == {
        "installed": True,
        "running": True,
        "ip": "100.1.2.3",
        "online_peers": 2,
        "exit_node": "vps",
    }


def test_checkupdates_parsing() -> None:
    assert metrics.parse_checkupdates(0, "a 1-1 -> 1-2\nb 2 -> 3\n") == 2
    assert metrics.parse_checkupdates(2, "") == 0
    assert metrics.parse_checkupdates(1, "") is None
    assert metrics.parse_update_count(1, "") == 0
    assert metrics.parse_update_count(0, "x\n") == 1


async def test_updates_missing_binary(config: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(metrics, "which", lambda n: None)
    monkeypatch.setattr(metrics, "aur_helper", lambda pref: None)
    c = Collectors(config)
    await c.refresh_updates(force=True)
    u = await c.collect_updates()
    assert u["repo"] is None and u["aur"] is None and u["available"] is False
    assert u["install"] == "sudo pacman -S pacman-contrib" and u["checking"] is False


async def test_updates_run(config: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake(*args: str, limit: float = 5.0) -> tuple[int, str]:
        return (0, "a\nb\nc\n") if args[0] == "checkupdates" else (1, "")

    monkeypatch.setattr(metrics, "which", lambda n: f"/usr/bin/{n}")
    monkeypatch.setattr(metrics, "aur_helper", lambda pref: "yay")
    monkeypatch.setattr(metrics, "run_cmd", fake)
    c = Collectors(config)
    await c.refresh_updates(force=True)
    u = await c.collect_updates()
    assert (u["repo"], u["aur"], u["available"]) == (3, 0, True) and u["checked_at"]


CANNED = {
    "current": {"temperature_2m": 21.4, "weather_code": 2, "wind_speed_10m": 12.0, "is_day": 1},
    "daily": {
        "time": ["2026-11-16", "2026-11-17"],
        "weather_code": [2, 65],
        "temperature_2m_max": [25.0, 20.0],
        "temperature_2m_min": [15.0, 14.0],
        "sunrise": ["2026-11-16T05:50", "2026-11-17T05:49"],
        "sunset": ["2026-11-16T19:10", "2026-11-17T19:11"],
    },
}


async def test_weather_parsing_and_failure_keeps_last_good(config: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def ok(url: str, headers: dict[str, str], timeout: float) -> Any:
        calls.append(url)
        return CANNED

    monkeypatch.setattr(metrics, "fetch_json", ok)
    c = Collectors(config)
    await c.refresh_weather(force=True)
    w = await c.collect_weather()
    assert w["available"] and w["temp_c"] == 21.4 and w["description"] == "Partly cloudy" and w["is_day"] is True
    assert (w["high"], w["low"], w["sunrise"]) == (25.0, 15.0, "2026-11-16T05:50")
    assert w["forecast"][1] == {"date": "2026-11-17", "code": 65, "description": "Heavy rain", "max": 20.0, "min": 14.0}
    assert "latitude=" in calls[0] and "forecast_days=4" in calls[0]

    def boom(url: str, headers: dict[str, str], timeout: float) -> Any:
        raise OSError("offline")

    monkeypatch.setattr(metrics, "fetch_json", boom)
    await c.refresh_weather(force=True)
    w = await c.collect_weather()
    assert w["temp_c"] == 21.4 and "offline" in w["error"]


def test_wmo_mapping() -> None:
    assert metrics.wmo_description(0) == "Clear"
    assert metrics.wmo_description(3) == "Overcast"
    assert metrics.wmo_description(45) == "Fog"
    assert metrics.wmo_description(95) == "Thunderstorm"
    assert metrics.wmo_description(81) == "Showers"
    assert metrics.wmo_description(1234) == "Unknown"


def test_aur_helper_tools_still_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools.shutil, "which", lambda n: None)
    assert tools.aur_helper("yay") is None


# ---------------------------------------------------------------- widgets


async def test_widgets_default_and_roundtrip(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    r = await client.get("/api/settings/widgets")
    body = r.json()
    assert [w["type"] for w in body["widgets"]] == ["ai", "weather", "clock"]
    assert all(w["lock"] and w["size"] == "compact" and w["id"] for w in body["widgets"])
    assert "cpu" in body["types"] and len(body["types"]) == 14
    new = [{"id": "w1", "type": "cpu", "size": "expanded", "lock": False, "options": {"a": 1}}]
    r = await client.put("/api/settings/widgets", json={"widgets": new}, headers={"x-csrf-token": csrf})
    assert r.status_code == 200 and r.json()["widgets"] == new
    assert (await client.get("/api/settings/widgets")).json()["widgets"] == new
    assert await state.audit.query(event="settings.widgets")


async def test_widgets_validation(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    h = {"x-csrf-token": csrf}

    async def put(widgets: list[dict[str, Any]]) -> httpx.Response:
        return await client.put("/api/settings/widgets", json={"widgets": widgets}, headers=h)

    for bad in (
        [{"id": "a", "type": "nope"}],
        [{"id": f"i{i}", "type": "cpu"} for i in range(9)],
        [{"id": "a", "type": "cpu"}, {"id": "a", "type": "gpu"}],
        [{"id": "a", "type": "cpu", "size": "huge"}],
        [{"id": "x" * 41, "type": "cpu"}],
        [{"id": "a", "type": "cpu", "options": {"k": "x" * 3000}}],
    ):
        r = await put(bad)
        assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_widgets", bad
    assert (await put([{"id": f"i{i}", "type": "cpu"} for i in range(8)])).status_code == 200


async def test_widgets_locked_get_ok_put_423(client: httpx.AsyncClient, state: AppState) -> None:
    csrf = await login(client, state)
    h = {"x-csrf-token": csrf}
    assert (await client.post("/api/auth/lock", headers=h)).status_code == 200
    assert (await client.get("/api/settings/widgets")).status_code == 200
    r = await client.put("/api/settings/widgets", json={"widgets": []}, headers=h)
    assert r.status_code == 423
    assert (await client.get("/api/metrics/snapshot")).status_code == 423


async def test_widgets_unauthenticated(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/settings/widgets")).status_code == 401


async def test_snapshot(client: httpx.AsyncClient, state: AppState) -> None:
    await login(client, state)
    r = await client.get("/api/metrics/snapshot?topics=cpu,memory,bogus")
    data = r.json()["data"]
    assert set(data) == {"cpu", "memory"} and data["memory"]["total"] > 0


# ---------------------------------------------------------------- lock filtering


def _w(**kw: Any) -> dict[str, Any]:
    return {"id": kw.pop("id", "x"), "size": "compact", "options": {}, **kw}


def test_restrict_unlocked_passthrough() -> None:
    d = {"cpu": {"usage": 1}}
    assert restrict(d, False, []) is d


def test_restrict_locked_filters_and_sanitizes() -> None:
    widgets = [_w(type="network", lock=True), _w(id="y", type="media", lock=True), _w(id="z", type="ai", lock=True)]
    data = {
        "cpu": {"usage": 1},
        "network": {
            "up_bps": 1,
            "tailscale": {"installed": True, "ip": "100.1.1.1", "exit_node": "vps", "running": True},
        },
        "media": {"available": True, "playing": {"title": "T", "artist": "A", "album": "B", "status": "Playing"}},
        "ai": {"model": "m", "reachable": True, "base_url_host": "127.0.0.1:11435"},
    }
    out = restrict(data, True, widgets)
    assert set(out) == {"network", "media", "ai"}
    assert out["network"]["tailscale"] == {"installed": True, "running": True}
    assert out["media"]["playing"] == {"status": "Playing"}
    assert out["ai"] == {"model": "m", "reachable": True}
    widgets[1]["options"] = {"show_titles_on_lock": True}
    assert restrict(data, True, widgets)["media"]["playing"]["title"] == "T"
    # lock=false widgets expose nothing
    assert restrict(data, True, [_w(type="cpu", lock=False)]) == {}


def test_default_widgets_all_lock() -> None:
    assert all(w["lock"] for w in default_widgets())


# ---------------------------------------------------------------- websocket


@pytest.fixture
def tc(config: Config) -> Iterator[tuple[TestClient, AppState]]:
    app = create_app(config)
    with TestClient(app, base_url=ORIGIN, headers={"origin": ORIGIN}) as c:
        state: AppState = app.state.kiln
        state.metrics.tick_s = 0.05
        c.portal.call(state.credentials.set_password, PASSWORD)  # type: ignore[union-attr]
        yield c, state


def _ws_headers(c: TestClient) -> dict[str, str]:
    # The session cookie is Secure, so the jar will not send it over ws://; pass it explicitly.
    return {"origin": ORIGIN, "host": "kiln.test", "cookie": f"{COOKIE_NAME}={c.cookies.get(COOKIE_NAME)}"}


def _login(c: TestClient) -> str:
    r = c.post("/api/auth/unlock", json={"password": PASSWORD})
    assert r.status_code == 200
    return str(r.json()["csrf"])


def test_ws_requires_auth(tc: tuple[TestClient, AppState]) -> None:
    from starlette.websockets import WebSocketDisconnect

    c, _ = tc
    with (
        pytest.raises(WebSocketDisconnect),
        c.websocket_connect("/ws/metrics", headers=_ws_headers(c)),
    ):
        pass


def test_ws_subscribe_receives_cpu(tc: tuple[TestClient, AppState]) -> None:
    c, _ = tc
    _login(c)
    with c.websocket_connect("/ws/metrics", headers=_ws_headers(c)) as ws:
        ws.send_json({"type": "subscribe", "topics": ["cpu", "bogus", "memory"]})
        msg = ws.receive_json()
        assert msg["type"] == "metrics" and isinstance(msg["ts"], float)
        got: dict[str, Any] = dict(msg["data"])
        while "cpu" not in got or "memory" not in got:
            got.update(ws.receive_json()["data"])
        assert "usage" in got["cpu"] and "bogus" not in got


def test_ws_locked_session_gets_only_lock_topics(
    tc: tuple[TestClient, AppState], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(routes_metrics, "RECHECK_S", 0.1)
    c, _ = tc
    csrf = _login(c)
    h = {"x-csrf-token": csrf}
    widgets = [
        {"id": "a", "type": "cpu", "lock": False},
        {"id": "b", "type": "uptime", "lock": True},
    ]
    assert c.put("/api/settings/widgets", json={"widgets": widgets}, headers=h).status_code == 200
    with c.websocket_connect("/ws/metrics", headers=_ws_headers(c)) as ws:
        ws.send_json({"type": "subscribe", "topics": ["cpu", "uptime"]})
        assert set(ws.receive_json()["data"]) >= {"uptime"}  # unlocked: sees both eventually
        assert c.post("/api/auth/lock", headers=h).status_code == 200
        seen: set[str] = set()
        # Within a few recheck cycles the lock is noticed; after that cpu must never arrive again.
        for _ in range(400):
            seen = set(ws.receive_json()["data"])
            if seen == {"uptime"}:
                break
        assert seen == {"uptime"}
        for _ in range(5):
            assert set(ws.receive_json()["data"]) == {"uptime"}
