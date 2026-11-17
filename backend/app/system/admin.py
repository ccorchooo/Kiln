"""The System app's backend: processes, services, packages, network, storage and power.

Root-level actions (system services, power) first run with polkit and `--no-ask-password`; when
that is refused, the caller retries with the user's sudo password, which is fed once to
`sudo -k -S` and never stored or logged.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
from typing import Any

import psutil

from app.system.tools import aur_helper, which

UNIT_RE = re.compile(r"[\w@.:\-]{1,200}\.service")
PKG_RE = re.compile(r"[a-z0-9@._+\-]{1,120}")
AUTH_REFUSED = re.compile(
    r"Interactive authentication required|Access denied|authentication is required|not authorized", re.I
)
SUDO_REJECTED = re.compile(r"incorrect password|Sorry, try again|no password was provided", re.I)
SKIP_FS = {"squashfs", "overlay", "tmpfs", "devtmpfs", "efivarfs", "ramfs", "autofs", "fuse.portal"}


class AdminError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("KILN_")}
    env.update(LC_ALL="C", SYSTEMD_COLORS="0", SYSTEMD_PAGER="cat", PAGER="cat")
    return env


async def run(argv: list[str], stdin: bytes | None = None, timeout: float = 30.0) -> tuple[int, str]:  # noqa: ASYNC109
    """Run argv (no shell); returns (exit code, stdout+stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=_env(),
        )
    except FileNotFoundError as exc:
        raise AdminError(501, "missing_tool", f"{argv[0]} isn't installed") from exc
    try:
        out, _ = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise AdminError(504, "timeout", f"{argv[0]} took too long") from exc
    return proc.returncode or 0, out.decode("utf-8", "replace")


async def systemctl_root(args: list[str], sudo_password: str | None) -> None:
    """systemctl as root: polkit first; if that is refused, sudo with the one-shot password."""
    if sudo_password is None:
        code, out = await run(["systemctl", "--no-ask-password", *args])
        if code == 0:
            return
        if AUTH_REFUSED.search(out):
            raise AdminError(403, "sudo_required", "This needs your sudo password.")
        raise AdminError(500, "failed", out.strip()[-400:] or "systemctl failed")
    code, out = await run(["sudo", "-k", "-S", "-p", "", "--", "systemctl", *args], (sudo_password + "\n").encode())
    if code == 0:
        return
    if SUDO_REJECTED.search(out):
        raise AdminError(403, "sudo_rejected", "sudo rejected that password.")
    raise AdminError(500, "failed", out.strip()[-400:] or "systemctl failed")


# --------------------------------------------------------------------------- processes


def list_processes() -> list[dict[str, Any]]:
    me = psutil.Process().username()
    rows = []
    # process_iter caches Process objects between calls, so cpu_percent compares against the last poll.
    for p in psutil.process_iter(["pid", "name", "username", "memory_info", "memory_percent", "cmdline", "status"]):
        info = p.info
        try:
            cpu = p.cpu_percent(interval=None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            cpu = 0.0
        mem = info.get("memory_info")
        rows.append(
            {
                "pid": info["pid"],
                "name": info.get("name") or "?",
                "user": info.get("username") or "?",
                "mine": info.get("username") == me,
                "cpu": round(cpu, 1),
                "rss": mem.rss if mem else 0,
                "mem": round(info.get("memory_percent") or 0.0, 1),
                "cmd": " ".join(info.get("cmdline") or [])[:400],
                "status": info.get("status") or "",
            }
        )
    return rows


def signal_process(pid: int, force: bool) -> str:
    if pid in {0, 1, os.getpid(), os.getppid()}:
        raise AdminError(400, "protected", "Kiln won't stop that process.")
    try:
        p = psutil.Process(pid)
        name = str(p.name())
        if force:
            p.kill()
        else:
            p.terminate()
    except psutil.NoSuchProcess as exc:
        raise AdminError(404, "not_found", "That process has already exited.") from exc
    except psutil.AccessDenied as exc:
        raise AdminError(403, "not_yours", "That process belongs to another user; Kiln can only stop yours.") from exc
    return name


# --------------------------------------------------------------------------- services


def merge_services(units: list[dict[str, Any]], files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join `list-units --all` (state) with `list-unit-files` (enablement); templates are left out."""
    enabled = {f.get("unit_file", ""): f.get("state", "") for f in files}
    rows: dict[str, dict[str, Any]] = {}
    for u in units:
        name = u.get("unit", "")
        if not name.endswith(".service"):
            continue
        rows[name] = {
            "unit": name,
            "description": u.get("description", ""),
            "load": u.get("load", ""),
            "active": u.get("active", ""),
            "sub": u.get("sub", ""),
            "enabled": enabled.get(name, ""),
        }
    for name, state in enabled.items():
        if name.endswith("@.service") or name in rows or not name.endswith(".service"):
            continue
        rows[name] = {
            "unit": name,
            "description": "",
            "load": "",
            "active": "inactive",
            "sub": "dead",
            "enabled": state,
        }
    return sorted(rows.values(), key=lambda r: r["unit"])


async def list_services(user: bool) -> list[dict[str, Any]]:
    scope = ["--user"] if user else []
    base = ["systemctl", *scope, "--no-pager", "--output=json", "--type=service"]
    (c1, units), (c2, files) = await asyncio.gather(
        run([*base, "list-units", "--all"]), run([*base, "list-unit-files"])
    )
    if c1 != 0:
        raise AdminError(500, "failed", units.strip()[-300:] or "systemctl failed")
    try:
        return merge_services(json.loads(units), json.loads(files) if c2 == 0 else [])
    except ValueError as exc:
        raise AdminError(500, "failed", "systemctl returned something unexpected") from exc


async def service_action(unit: str, action: str, user: bool, sudo_password: str | None) -> None:
    if not UNIT_RE.fullmatch(unit):
        raise AdminError(400, "invalid_unit", "Invalid service name")
    if user and unit == "kiln.service" and action in {"stop", "disable"}:
        raise AdminError(400, "protected", "That would shut Kiln down. Use a terminal if you really mean it.")
    if user:
        code, out = await run(["systemctl", "--user", action, unit])
        if code != 0:
            raise AdminError(500, "failed", out.strip()[-400:] or "systemctl failed")
    else:
        await systemctl_root([action, unit], sudo_password)


# --------------------------------------------------------------------------- packages


def parse_search(out: str) -> list[dict[str, Any]]:
    """`pacman -Ss` / `yay -Ssa` output → [{repo, name, version, installed, description}]."""
    rows: list[dict[str, Any]] = []
    for line in out.splitlines():
        if line.startswith((" ", "\t")):
            if rows and not rows[-1]["description"]:
                rows[-1]["description"] = line.strip()
            continue
        m = re.match(r"^(\S+)/(\S+) (\S+)(.*)$", line)
        if m:
            repo, name, version, rest = m.groups()
            rows.append(
                {
                    "repo": repo,
                    "name": name,
                    "version": version,
                    "installed": "[installed" in rest.lower(),
                    "description": "",
                }
            )
    return rows


def parse_updates(out: str) -> list[dict[str, str]]:
    """`checkupdates` / `pacman -Qu` / `yay -Qua` lines: `name old -> new`."""
    rows = []
    for line in out.splitlines():
        m = re.match(r"^(\S+) (\S+) -> (\S+)", line.strip())
        if m:
            rows.append({"name": m.group(1), "from": m.group(2), "to": m.group(3)})
    return rows


async def packages(preference: str) -> dict[str, Any]:
    helper = aur_helper(preference)
    jobs = [run(["pacman", "-Qe"]), run(["checkupdates"] if which("checkupdates") else ["pacman", "-Qu"], timeout=90)]
    if helper:
        jobs.append(run([helper, "-Qua"], timeout=90))
    results = await asyncio.gather(*jobs, return_exceptions=True)
    installed: list[dict[str, str]] = []
    first = results[0]
    if isinstance(first, tuple):
        for line in first[1].splitlines():
            parts = line.split()
            if len(parts) == 2:
                installed.append({"name": parts[0], "version": parts[1]})
    updates = [
        {**u, "aur": i == 2} for i, r in enumerate(results[1:], 1) if isinstance(r, tuple) for u in parse_updates(r[1])
    ]
    return {"installed": installed, "updates": updates, "aur_helper": helper}


async def search_packages(query: str, preference: str) -> list[dict[str, Any]]:
    words = query.split()
    if not words or not all(re.fullmatch(r"[\w+.\-]{1,60}", w) for w in words):
        raise AdminError(400, "invalid_query", "Search for package names or words")
    helper = aur_helper(preference)
    jobs = [run(["pacman", "-Ss", *words])]
    if helper:
        jobs.append(run([helper, "-Ssa", *words], timeout=45))
    results = await asyncio.gather(*jobs, return_exceptions=True)
    return [row for r in results if isinstance(r, tuple) for row in parse_search(r[1])][:300]


# --------------------------------------------------------------------------- network, storage


def network() -> list[dict[str, Any]]:
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()
    io = psutil.net_io_counters(pernic=True)
    rows = []
    for name, entries in sorted(addrs.items()):
        st = stats.get(name)
        counters = io.get(name)
        out = []
        for a in entries:
            family = {socket.AF_INET: "ipv4", socket.AF_INET6: "ipv6", psutil.AF_LINK: "mac"}.get(a.family)
            if family:
                out.append({"family": family, "address": a.address.split("%")[0]})
        rows.append(
            {
                "name": name,
                "up": bool(st and st.isup),
                "speed_mbps": st.speed if st and st.speed > 0 else None,
                "mtu": st.mtu if st else None,
                "addresses": out,
                "rx": counters.bytes_recv if counters else 0,
                "tx": counters.bytes_sent if counters else 0,
            }
        )
    return rows


def parse_tailscale_peers(data: dict[str, Any]) -> list[dict[str, Any]]:
    peers = []
    for p in (data.get("Peer") or {}).values():
        ips = p.get("TailscaleIPs") or []
        peers.append(
            {
                "name": p.get("HostName") or p.get("DNSName", "").split(".")[0],
                "ip": next((ip for ip in ips if ":" not in ip), ips[0] if ips else None),
                "os": p.get("OS") or "",
                "online": bool(p.get("Online")),
                "exit_node": bool(p.get("ExitNode")),
            }
        )
    return sorted(peers, key=lambda p: (not p["online"], p["name"].lower()))


async def tailscale_peers() -> list[dict[str, Any]] | None:
    if which("tailscale") is None:
        return None
    try:
        code, out = await run(["tailscale", "status", "--json"], timeout=5)
        return parse_tailscale_peers(json.loads(out)) if code == 0 else []
    except (AdminError, ValueError):
        return []


async def storage() -> dict[str, Any]:
    # One row per device: btrfs subvolumes mount the same filesystem many times.
    by_device: dict[str, dict[str, Any]] = {}
    for p in psutil.disk_partitions(all=False):
        if p.fstype in SKIP_FS or p.mountpoint.startswith(("/snap", "/var/lib/docker")):
            continue
        row = by_device.get(p.device)
        if row is not None:
            row["mounts"].append(p.mountpoint)
            continue
        try:
            u = psutil.disk_usage(p.mountpoint)
        except OSError:
            continue
        by_device[p.device] = {
            "device": p.device,
            "mounts": [p.mountpoint],
            "fstype": p.fstype,
            "used": u.used,
            "total": u.total,
            "percent": u.percent,
        }
    parts = list(by_device.values())
    for row in parts:
        row["mounts"].sort(key=len)
    disks = []
    try:
        code, out = await run(["lsblk", "-J", "-b", "-d", "-o", "NAME,SIZE,TYPE,MODEL,ROTA,TRAN"], timeout=5)
        if code == 0:
            for d in json.loads(out).get("blockdevices", []):
                if d.get("type") == "disk" and not str(d.get("name", "")).startswith("zram"):
                    disks.append(
                        {
                            "name": d.get("name"),
                            "size": d.get("size"),
                            "model": (d.get("model") or "").strip(),
                            "kind": "HDD" if d.get("rota") in (True, "1", 1) else "SSD",
                            "transport": d.get("tran") or "",
                        }
                    )
    except (AdminError, ValueError):
        pass
    return {"partitions": parts, "disks": disks}


# --------------------------------------------------------------------------- journal

PRIORITIES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"]


def journal_argv(f: dict[str, Any]) -> list[str]:
    """Validated `journalctl -f -o json` argv for the Logs app's filters (no shell involved)."""
    lines = f.get("lines", 300)
    if not isinstance(lines, int) or isinstance(lines, bool) or not 0 <= lines <= 5000:
        raise AdminError(400, "invalid", "lines must be 0–5000")
    argv = ["journalctl", "--no-pager", "-o", "json", "-f", "-n", str(lines)]
    if f.get("user"):
        argv.append("--user")
    unit = str(f.get("unit") or "").strip()
    if unit:
        if not re.fullmatch(r"[\w@.:\-]{1,200}", unit):
            raise AdminError(400, "invalid", "Invalid unit name")
        argv += ["--user-unit" if f.get("user") else "-u", unit]
    prio = str(f.get("priority") or "").strip()
    if prio:
        if prio not in PRIORITIES:
            raise AdminError(400, "invalid", "Invalid priority")
        argv += ["-p", prio]
    grep = str(f.get("grep") or "")
    if grep:
        if len(grep) > 200 or "\x00" in grep:
            raise AdminError(400, "invalid", "Search text is too long")
        argv += ["--grep", grep, "--case-sensitive=false"]
    since = str(f.get("since") or "").strip()
    if since:
        if not re.fullmatch(r"[\w :\-.+]{1,40}", since):
            raise AdminError(400, "invalid", "Invalid time")
        argv += ["--since", since]
    return argv


def journal_entry(line: str) -> dict[str, Any] | None:
    try:
        d = json.loads(line)
    except ValueError:
        return None
    if not isinstance(d, dict):
        return None
    msg = d.get("MESSAGE")
    if isinstance(msg, list):  # binary messages arrive as byte arrays
        msg = bytes(b for b in msg if isinstance(b, int) and 0 <= b < 256).decode("utf-8", "replace")
    try:
        prio = int(d.get("PRIORITY", 6))
        ts = int(d.get("__REALTIME_TIMESTAMP", 0)) / 1e6
    except (TypeError, ValueError):
        prio, ts = 6, 0.0
    return {
        "t": ts,
        "prio": prio,
        "unit": d.get("_SYSTEMD_UNIT") or d.get("_SYSTEMD_USER_UNIT") or "",
        "ident": d.get("SYSLOG_IDENTIFIER") or d.get("_COMM") or "",
        "pid": d.get("_PID"),
        "msg": msg if isinstance(msg, str) else "",
    }
