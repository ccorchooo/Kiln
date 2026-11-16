"""Metric collectors. Each returns a JSON-able dict (None for unknown values) and never raises."""

from __future__ import annotations

import asyncio
import glob
import json
import logging
import os
import time
import urllib.request
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import psutil

from app.config import Config
from app.system import media
from app.system.tools import INSTALL_HINTS, aur_helper, which

log = logging.getLogger("kiln.metrics")

FAST_TOPICS = ("cpu", "memory", "gpu", "temps", "disk", "network", "uptime", "battery")
SLOW_TOPICS = ("updates", "weather", "ai")
ALL_TOPICS = (*FAST_TOPICS, "media", *SLOW_TOPICS)

NVIDIA_QUERY = "name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw"
GPU_INSTALL = "Install the NVIDIA driver and utilities: sudo pacman -S nvidia-utils"
CHECKUPDATES_INSTALL = "sudo pacman -S pacman-contrib"

UPDATES_INTERVAL_S = 30 * 60
WEATHER_INTERVAL_S = 15 * 60
WEATHER_RETRY_S = 5 * 60
AI_INTERVAL_S = 30.0
TAILSCALE_INTERVAL_S = 30.0
GPU_MIN_INTERVAL_S = 1.0


# ---------------------------------------------------------------- helpers


def _num(v: str) -> float | None:
    v = v.strip()
    if not v or v.startswith("[") or v.upper() in {"N/A", "NAN"}:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def rate(prev: float | None, cur: float, dt: float) -> float | None:
    """Bytes-per-second from two counter readings; None if unknown, 0 on counter reset."""
    if prev is None or dt <= 0:
        return None
    return max(0.0, (cur - prev) / dt)


async def run_cmd(*args: str, limit: float = 5.0) -> tuple[int, str] | None:
    """Run a command; None if it is missing, cannot start or times out."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
    except OSError:
        return None
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), limit)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return None
    return proc.returncode or 0, out.decode(errors="replace")


def fetch_json(url: str, headers: dict[str, str], timeout: float) -> Any:
    """Blocking JSON GET (run via asyncio.to_thread)."""
    req = urllib.request.Request(url, headers=headers)  # noqa: S310 - fixed https/http endpoints from config
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read().decode())


# ---------------------------------------------------------------- pure parsers


def pick_cpu_temp(temps: dict[str, list[Any]]) -> float | None:
    def find(group: str, labels: tuple[str, ...]) -> float | None:
        for e in temps.get(group, []):
            if e.label in labels and e.current is not None:
                return float(e.current)
        return None

    t = find("coretemp", ("Package id 0",))
    if t is None:
        t = find("k10temp", ("Tctl", "Tdie"))
    if t is not None:
        return t
    for entries in temps.values():
        vals = [float(e.current) for e in entries if e.current is not None]
        if vals:
            return max(vals)
    return None


def parse_nvidia_smi(out: str) -> dict[str, Any] | None:
    line = next((ln for ln in out.splitlines() if ln.strip()), "")
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 6:
        return None
    return {
        "available": True,
        "vendor": "nvidia",
        "name": parts[0],
        "usage": _num(parts[1]),
        "temp_c": _num(parts[2]),
        "vram_used_mb": _num(parts[3]),
        "vram_total_mb": _num(parts[4]),
        "power_w": _num(parts[5]),
    }


def parse_update_count(code: int, out: str) -> int | None:
    """AUR helper `-Qua`: 0 = updates listed, 1 with no output = none, anything else = error."""
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if code == 0:
        return len(lines)
    return 0 if code == 1 and not lines else None


def parse_checkupdates(code: int, out: str) -> int | None:
    """checkupdates: 0 = updates listed, 2 = none, 1 = error."""
    if code == 2:
        return 0
    return len([ln for ln in out.splitlines() if ln.strip()]) if code == 0 else None


def parse_tailscale(data: dict[str, Any]) -> dict[str, Any]:
    ips = (data.get("Self") or {}).get("TailscaleIPs") or []
    peers = data.get("Peer") or {}
    exit_node = None
    ex = data.get("ExitNodeStatus")
    if ex:
        ex_id = ex.get("ID")
        for p in peers.values():
            if p.get("ExitNode") or (ex_id and p.get("ID") == ex_id):
                exit_node = p.get("HostName") or p.get("DNSName")
                break
        if exit_node is None:
            eips = ex.get("TailscaleIPs") or []
            exit_node = str(eips[0]) if eips else (ex_id or "unknown")
    return {
        "installed": True,
        "running": data.get("BackendState") == "Running",
        "ip": ips[0] if ips else None,
        "online_peers": sum(1 for p in peers.values() if p.get("Online")),
        "exit_node": exit_node,
    }


WMO: dict[int, str] = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Freezing fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    56: "Freezing drizzle",
    57: "Freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Light showers",
    81: "Showers",
    82: "Heavy showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with hail",
}


def wmo_description(code: int | None) -> str:
    if code is None:
        return "Unknown"
    return WMO.get(int(code), "Unknown")


def _at(seq: Any, i: int) -> Any:
    try:
        return seq[i]
    except (IndexError, TypeError, KeyError):
        return None


def parse_open_meteo(data: dict[str, Any], city: str) -> dict[str, Any]:
    cur = data.get("current") or {}
    daily = data.get("daily") or {}
    codes = daily.get("weather_code") or []
    forecast = [
        {
            "date": d,
            "code": _at(codes, i),
            "description": wmo_description(_at(codes, i)),
            "max": _at(daily.get("temperature_2m_max"), i),
            "min": _at(daily.get("temperature_2m_min"), i),
        }
        for i, d in enumerate(daily.get("time") or [])
    ]
    code = cur.get("weather_code")
    return {
        "available": True,
        "city": city,
        "temp_c": cur.get("temperature_2m"),
        "code": code,
        "description": wmo_description(code),
        "is_day": bool(cur.get("is_day")) if cur.get("is_day") is not None else None,
        "wind_kmh": cur.get("wind_speed_10m"),
        "high": _at(daily.get("temperature_2m_max"), 0),
        "low": _at(daily.get("temperature_2m_min"), 0),
        "sunrise": _at(daily.get("sunrise"), 0),
        "sunset": _at(daily.get("sunset"), 0),
        "forecast": forecast,
        "fetched_at": time.time(),
    }


# ---------------------------------------------------------------- collectors


class Collectors:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._net_prev: tuple[float, int, int] | None = None
        self._disk_prev: tuple[float, int, int] | None = None
        self._gpu_cache: tuple[float, dict[str, Any]] | None = None
        self._ts_cache: tuple[float, dict[str, Any]] | None = None
        self._updates: dict[str, Any] = {
            "available": False,
            "repo": None,
            "aur": None,
            "checked_at": None,
            "checking": False,
        }
        self._updates_next = 0.0
        self.updates_started: float | None = None
        self._weather: dict[str, Any] = {
            "available": False,
            "city": config.location.city,
            "forecast": [],
            "fetched_at": None,
        }
        self._weather_next = 0.0
        self._ai: dict[str, Any] = {
            "model": config.llm.model,
            "reachable": False,
            "base_url_host": urlsplit(config.llm.base_url).netloc,
        }
        self._ai_next = 0.0
        with_suppress(psutil.cpu_percent, None)
        with_suppress(psutil.cpu_percent, None, True)

    async def collect(self, topic: str) -> dict[str, Any]:
        fn: Callable[[], Awaitable[dict[str, Any]]] | None = getattr(self, f"collect_{topic}", None)
        if fn is None:
            raise KeyError(topic)
        try:
            return await fn()
        except Exception:
            log.exception("collector %s failed", topic)
            return {"error": True}

    # --- fast

    async def collect_cpu(self) -> dict[str, Any]:
        freq = with_suppress(psutil.cpu_freq)
        temps = with_suppress(_sensors) or {}
        return {
            "usage": psutil.cpu_percent(interval=None),
            "per_core": psutil.cpu_percent(interval=None, percpu=True),
            "freq_mhz": float(freq.current) if freq else None,
            "temp_c": pick_cpu_temp(temps),
        }

    async def collect_memory(self) -> dict[str, Any]:
        vm = psutil.virtual_memory()
        sw = psutil.swap_memory()
        return {
            "used": vm.used,
            "total": vm.total,
            "percent": vm.percent,
            "swap_used": sw.used,
            "swap_total": sw.total,
            "swap_percent": sw.percent,
        }

    async def collect_temps(self) -> dict[str, Any]:
        sensors: list[dict[str, Any]] = []
        for group, entries in (with_suppress(_sensors) or {}).items():
            for e in entries:
                if e.current is None:
                    continue
                label = f"{group} {e.label}".strip()
                sensors.append({"label": label, "current": float(e.current)})
        sensors.sort(key=lambda s: s["current"], reverse=True)
        top = sensors[:6]
        return {"sensors": top, "hottest": top[0] if top else None}

    async def collect_disk(self) -> dict[str, Any]:
        parts = {p.mountpoint: p.device for p in with_suppress(psutil.disk_partitions) or []}
        mounts: list[dict[str, Any]] = []
        seen: set[str] = set()
        for mp in ("/", "/home"):
            if mp not in parts and mp != "/":
                continue
            dev = parts.get(mp, mp)
            if dev in seen:
                continue
            try:
                u = psutil.disk_usage(mp)
            except OSError:
                continue
            seen.add(dev)
            mounts.append({"mount": mp, "used": u.used, "total": u.total, "percent": u.percent})
        io = with_suppress(psutil.disk_io_counters)
        read_bps = write_bps = None
        if io is not None:
            now = time.monotonic()
            if self._disk_prev is not None:
                dt = now - self._disk_prev[0]
                read_bps = rate(self._disk_prev[1], io.read_bytes, dt)
                write_bps = rate(self._disk_prev[2], io.write_bytes, dt)
            self._disk_prev = (now, io.read_bytes, io.write_bytes)
        return {"mounts": mounts, "read_bps": read_bps, "write_bps": write_bps}

    async def collect_network(self) -> dict[str, Any]:
        per = with_suppress(psutil.net_io_counters, True) or {}
        sent = sum(c.bytes_sent for n, c in per.items() if n != "lo")
        recv = sum(c.bytes_recv for n, c in per.items() if n != "lo")
        now = time.monotonic()
        up = down = None
        if self._net_prev is not None:
            dt = now - self._net_prev[0]
            up = rate(self._net_prev[1], sent, dt)
            down = rate(self._net_prev[2], recv, dt)
        self._net_prev = (now, sent, recv)
        return {"up_bps": up, "down_bps": down, "tailscale": await self._tailscale()}

    async def _tailscale(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._ts_cache and now - self._ts_cache[0] < TAILSCALE_INTERVAL_S:
            return self._ts_cache[1]
        result: dict[str, Any]
        if which("tailscale") is None:
            result = {
                "installed": False,
                "running": False,
                "ip": None,
                "online_peers": None,
                "exit_node": None,
                "install": INSTALL_HINTS["tailscale"],
            }
        else:
            res = await run_cmd("tailscale", "status", "--json", limit=3.0)
            result = {"installed": True, "running": False, "ip": None, "online_peers": None, "exit_node": None}
            if res is not None:
                try:
                    result = parse_tailscale(json.loads(res[1]))
                except (ValueError, AttributeError):
                    pass
        self._ts_cache = (now, result)
        return result

    async def collect_battery(self) -> dict[str, Any]:
        b = with_suppress(_battery)
        if b is None:
            return {"present": False, "percent": None, "plugged": None, "secs_left": None}
        secs = b.secsleft
        known = isinstance(secs, int | float) and secs >= 0
        return {
            "present": True,
            "percent": b.percent,
            "plugged": b.power_plugged,
            "secs_left": int(secs) if known else None,
        }

    async def collect_uptime(self) -> dict[str, Any]:
        try:
            load: list[float | None] = list(os.getloadavg())
        except OSError:
            load = [None, None, None]
        return {"uptime_s": max(0.0, time.time() - psutil.boot_time()), "load": load}

    async def collect_gpu(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._gpu_cache and now - self._gpu_cache[0] < GPU_MIN_INTERVAL_S:
            return self._gpu_cache[1]
        result: dict[str, Any] | None = None
        if which("nvidia-smi"):
            res = await run_cmd("nvidia-smi", f"--query-gpu={NVIDIA_QUERY}", "--format=csv,noheader,nounits", limit=2.0)
            if res is not None and res[0] == 0:
                result = parse_nvidia_smi(res[1])
        if result is None:
            result = await asyncio.to_thread(read_amd_gpu)
        if result is None:
            result = {
                "available": False,
                "vendor": None,
                "name": None,
                "usage": None,
                "temp_c": None,
                "vram_used_mb": None,
                "vram_total_mb": None,
                "power_w": None,
                "install": GPU_INSTALL,
            }
        self._gpu_cache = (now, result)
        return result

    # --- media / slow

    async def collect_media(self) -> dict[str, Any]:
        return await media.now_playing()

    async def collect_updates(self) -> dict[str, Any]:
        return dict(self._updates)

    async def collect_weather(self) -> dict[str, Any]:
        return dict(self._weather)

    async def collect_ai(self) -> dict[str, Any]:
        return dict(self._ai)

    # --- background refreshers (cached values are served by the collect_* above)

    async def refresh_updates(self, force: bool = False) -> None:
        if self._updates["checking"] or (not force and time.monotonic() < self._updates_next):
            return
        self._updates_next = time.monotonic() + UPDATES_INTERVAL_S
        self._updates = {**self._updates, "checking": True}
        try:
            install: str | None = None
            repo: int | None = None
            if which("checkupdates") is None:
                install = CHECKUPDATES_INSTALL
            else:
                res = await run_cmd("checkupdates", limit=180.0)
                repo = parse_checkupdates(*res) if res else None
            aur: int | None = None
            helper = aur_helper(self.config.packages.aur_helper)
            if helper:
                res = await run_cmd(helper, "-Qua", limit=180.0)
                aur = parse_update_count(*res) if res else None
            new: dict[str, Any] = {
                "available": repo is not None or aur is not None,
                "repo": repo,
                "aur": aur,
                "checked_at": time.time(),
                "checking": False,
            }
            if install:
                new["install"] = install
            self._updates = new
        except BaseException:
            self._updates = {**self._updates, "checking": False}
            raise

    async def refresh_weather(self, force: bool = False) -> None:
        if not force and time.monotonic() < self._weather_next:
            return
        loc = self.config.location
        self._weather_next = time.monotonic() + WEATHER_RETRY_S
        url = (
            "https://api.open-meteo.com/v1/forecast?"
            f"latitude={loc.latitude}&longitude={loc.longitude}"
            "&current=temperature_2m,weather_code,wind_speed_10m,is_day"
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset"
            f"&timezone={loc.timezone.replace('/', '%2F')}&forecast_days=4"
        )
        try:
            data = await asyncio.to_thread(fetch_json, url, {"User-Agent": "Kiln"}, 6.0)
            self._weather = parse_open_meteo(data, loc.city)
            self._weather_next = time.monotonic() + WEATHER_INTERVAL_S
        except Exception as exc:
            self._weather = {**self._weather, "error": f"{type(exc).__name__}: {exc}"[:200]}

    async def refresh_ai(self, force: bool = False) -> None:
        if not force and time.monotonic() < self._ai_next:
            return
        self._ai_next = time.monotonic() + AI_INTERVAL_S
        llm = self.config.llm
        headers = {"Authorization": f"Bearer {llm.api_key}", "User-Agent": "Kiln"}
        try:
            await asyncio.to_thread(fetch_json, f"{llm.base_url.rstrip('/')}/models", headers, 2.0)
            reachable = True
        except Exception:
            reachable = False
        self._ai = {**self._ai, "reachable": reachable}

    async def refresh(self, topic: str, force: bool = False) -> None:
        if topic == "updates":
            await self.refresh_updates(force)
        elif topic == "weather":
            await self.refresh_weather(force)
        elif topic == "ai":
            await self.refresh_ai(force)

    def never_refreshed(self, topic: str) -> bool:
        return {
            "updates": self._updates["checked_at"] is None,
            "weather": self._weather["fetched_at"] is None and "error" not in self._weather,
            "ai": self._ai_next == 0.0,
        }.get(topic, False)


def with_suppress(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except Exception:
        return None


def _sensors() -> dict[str, list[Any]]:
    fn = getattr(psutil, "sensors_temperatures", None)
    return dict(fn()) if fn else {}


def _battery() -> Any:
    fn = getattr(psutil, "sensors_battery", None)
    return fn() if fn else None


def read_amd_gpu() -> dict[str, Any] | None:
    for dev in sorted(glob.glob("/sys/class/drm/card*/device")):
        d = Path(dev)

        def read(name: str, base: Path = d) -> str | None:
            try:
                return (base / name).read_text().strip()
            except OSError:
                return None

        if read("vendor") != "0x1002":
            continue
        busy = read("gpu_busy_percent")
        used, total = read("mem_info_vram_used"), read("mem_info_vram_total")
        temp = power = None
        for hw in sorted(d.glob("hwmon/hwmon*")):
            t = read("temp1_input", hw)
            p = read("power1_average", hw)
            temp = float(t) / 1000 if t and t.isdigit() else temp
            power = float(p) / 1e6 if p and p.isdigit() else power
        return {
            "available": True,
            "vendor": "amd",
            "name": read("product_name") or "AMD GPU",
            "usage": _num(busy) if busy else None,
            "temp_c": temp,
            "vram_used_mb": int(used) / 1048576 if used and used.isdigit() else None,
            "vram_total_mb": int(total) / 1048576 if total and total.isdigit() else None,
            "power_w": power,
        }
    return None
