"""Ember's tools: OpenAI tool schemas, per-call risk classification, and execution.

Every file tool goes through the same Jail as the Files app, without the re-auth bypass: protected
locations stay closed to Ember. Commands run as the Kiln user (never root); ROOT-tier commands only
get sudo through a one-shot password the user types into the approval card, fed to `sudo -S` on
stdin and dropped right after.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import signal
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.ember.comfy import SIZES, ImageError
from app.ember.risk import Risk, classify_line
from app.fs import ops
from app.fs.errors import FsError

if TYPE_CHECKING:
    from app.ember.service import EmberService

Emit = Callable[[str], Awaitable[None]]

MAX_OUTPUT = 24_000  # characters handed back to the model per tool call
MAX_STREAM = 256_000  # bytes collected from a command before it's cut off
DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 900


@dataclass
class Plan:
    """A classified tool call, before approval."""

    risk: Risk
    summary: str  # one line for the approval card
    reason: str = ""
    detail: str = ""  # e.g. the exact command or file preview
    sudo: bool = False


@dataclass
class Result:
    output: str
    ok: bool = True
    images: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)


def _fn(name: str, description: str, props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


SCHEMAS: list[dict[str, Any]] = [
    _fn(
        "list_directory",
        "List a folder in the user's home. Paths may start with ~.",
        {
            "path": {"type": "string", "description": "Folder, e.g. ~/Documents"},
            "show_hidden": {"type": "boolean"},
        },
        ["path"],
    ),
    _fn(
        "read_file",
        "Read a UTF-8 text file in the user's home.",
        {
            "path": {"type": "string"},
            "start_line": {"type": "integer", "description": "1-based first line (optional)"},
            "max_lines": {"type": "integer", "description": "Default 400"},
        },
        ["path"],
    ),
    _fn(
        "search_files",
        "Find files by name, or search inside files for text, under a folder in the user's home.",
        {
            "query": {"type": "string"},
            "path": {"type": "string", "description": "Folder to search, default ~"},
            "in_content": {"type": "boolean", "description": "true = search file contents"},
        },
        ["query"],
    ),
    _fn(
        "write_file",
        "Create or overwrite a text file in the user's home. Needs the user's approval.",
        {
            "path": {"type": "string"},
            "content": {"type": "string"},
            "overwrite": {"type": "boolean", "description": "Required to replace an existing file"},
        },
        ["path", "content"],
    ),
    _fn(
        "run_command",
        "Run a bash command on the user's PC as the user. Non-interactive: pass --noconfirm/-y flags. "
        "Prefix with sudo only when root is truly required. Risky commands need the user's approval.",
        {
            "command": {"type": "string"},
            "cwd": {"type": "string", "description": "Working folder, default ~"},
            "timeout_seconds": {"type": "integer", "description": f"Default {DEFAULT_TIMEOUT}, max {MAX_TIMEOUT}"},
        },
        ["command"],
    ),
    _fn(
        "system_status",
        "Current CPU, memory, GPU, temperatures, disk, network and uptime of the PC.",
        {},
        [],
    ),
    _fn(
        "read_journal",
        "Recent systemd journal lines, optionally for one unit.",
        {
            "unit": {"type": "string"},
            "user_unit": {"type": "boolean", "description": "true for a --user unit"},
            "lines": {"type": "integer", "description": "Default 60, max 400"},
            "priority": {"type": "string", "description": "e.g. err, warning"},
            "since": {"type": "string", "description": "e.g. '1 hour ago', 'today'"},
        },
        [],
    ),
    _fn(
        "search_packages",
        "Search Arch repositories (pacman) and the AUR for packages. Also says which are installed.",
        {"query": {"type": "string"}},
        ["query"],
    ),
    _fn(
        "generate_image",
        "Generate an image from a text prompt with the local image model (ComfyUI, Z-Image Turbo). "
        "Write the prompt in English, detailed and visual. The image is shown to the user automatically.",
        {
            "prompt": {"type": "string"},
            "size": {"type": "string", "enum": list(SIZES)},
            "negative": {"type": "string", "description": "Things to avoid (optional)"},
        },
        ["prompt"],
    ),
]

TOOL_NAMES = {s["function"]["name"] for s in SCHEMAS}


def _clip(text: str, limit: int = MAX_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    head = text[: limit * 2 // 3]
    tail = text[-limit // 3 :]
    return f"{head}\n… [{len(text) - limit} characters cut] …\n{tail}"


def _int(v: Any, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _str(args: dict[str, Any], key: str, default: str = "") -> str:
    v = args.get(key, default)
    return v if isinstance(v, str) else default


def plan(name: str, args: dict[str, Any], svc: EmberService) -> Plan:
    """Classify a call. Raises ValueError for unknown tools or bad arguments."""
    if name not in TOOL_NAMES:
        raise ValueError(f"Unknown tool {name}")
    if name == "list_directory":
        return Plan(Risk.SAFE, f"List {_str(args, 'path', '~')}")
    if name == "read_file":
        return Plan(Risk.SAFE, f"Read {_str(args, 'path')}")
    if name == "search_files":
        where = _str(args, "path", "~") or "~"
        return Plan(Risk.SAFE, f"Search {where} for “{_str(args, 'query')}”")
    if name == "system_status":
        return Plan(Risk.SAFE, "Check system status")
    if name == "read_journal":
        unit = _str(args, "unit")
        return Plan(Risk.SAFE, f"Read the journal{' for ' + unit if unit else ''}")
    if name == "search_packages":
        return Plan(Risk.SAFE, f"Search packages for “{_str(args, 'query')}”")
    if name == "generate_image":
        return Plan(Risk.SAFE, "Generate an image", detail=_str(args, "prompt"))
    if name == "write_file":
        path = _str(args, "path")
        if not path:
            raise ValueError("path is required")
        content = _str(args, "content")
        exists = False
        with contextlib.suppress(FsError, OSError):
            exists = ops.resolve_link(svc.state.jail, path, False, must_exist=False).exists()
        verb = "Overwrite" if exists else "Create"
        preview = content if len(content) < 4000 else content[:4000] + "\n…"
        return Plan(
            Risk.CHANGE,
            f"{verb} {path}",
            reason=f"{verb.lower()}s a file ({len(content.encode())} bytes)",
            detail=preview,
        )
    if name == "run_command":
        cmd = _str(args, "command").strip()
        if not cmd:
            raise ValueError("command is required")
        cwd = _str(args, "cwd", "~") or "~"
        try:
            ops.resolve(svc.state.jail, cwd, False, must_exist=True)
        except FsError as exc:
            msg = f"cwd {cwd!r} isn't usable ({exc.message}); use a folder inside ~ or leave it out"
            raise ValueError(msg) from exc
        risk, reason = classify_line(cmd)
        sudo = risk == Risk.ROOT and bool(re.match(r"^\s*sudo\s", cmd))
        return Plan(risk, "Run a command", reason=reason, detail=cmd, sudo=sudo)
    raise ValueError(f"Unknown tool {name}")


# ---------------------------------------------------------------- execution


async def execute(
    name: str, args: dict[str, Any], svc: EmberService, emit: Emit, sudo_password: str | None = None
) -> Result:
    try:
        if name == "list_directory":
            return await _list(args, svc)
        if name == "read_file":
            return await _read(args, svc)
        if name == "search_files":
            return await _search(args, svc)
        if name == "write_file":
            return await _write(args, svc)
        if name == "run_command":
            return await _run(args, svc, emit, sudo_password)
        if name == "system_status":
            return await _status(svc)
        if name == "read_journal":
            return await _journal(args, svc, emit)
        if name == "search_packages":
            return await _packages(args, svc, emit)
        if name == "generate_image":
            return await _image(args, svc, emit)
    except FsError as exc:
        msg = exc.message
        if exc.code == "denied":
            msg = "That location is protected; Ember can't open it. The user can open it in Files."
        return Result(f"Error: {msg}", ok=False)
    except ImageError as exc:
        return Result(f"Error: {exc}", ok=False)
    return Result(f"Error: unknown tool {name}", ok=False)


async def _list(args: dict[str, Any], svc: EmberService) -> Result:
    data = await asyncio.to_thread(
        ops.list_dir, svc.state.jail, _str(args, "path", "~") or "~", False, bool(args.get("show_hidden"))
    )
    lines = [f"{data['path']} ({len(data['entries'])} items)"]
    for e in data["entries"][:300]:
        kind = "/" if e["type"] == "dir" else ""
        size = "" if e["type"] == "dir" else f"  {e.get('size', 0)} B"
        lines.append(f"{e['name']}{kind}{size}")
    if len(data["entries"]) > 300:
        lines.append(f"… {len(data['entries']) - 300} more")
    return Result("\n".join(lines))


async def _read(args: dict[str, Any], svc: EmberService) -> Result:
    data = await asyncio.to_thread(ops.read_text, svc.state.jail, _str(args, "path"), False)
    lines = data["content"].splitlines()
    start = _int(args.get("start_line"), 1, 1, max(1, len(lines)))
    count = _int(args.get("max_lines"), 400, 1, 2000)
    chunk = lines[start - 1 : start - 1 + count]
    header = f"{data['path']} — lines {start}-{start + len(chunk) - 1} of {len(lines)}"
    return Result(_clip(header + "\n" + "\n".join(chunk)), meta={"path": data["path"]})


async def _search(args: dict[str, Any], svc: EmberService) -> Result:
    from app.fs.search import search

    query = _str(args, "query").strip()
    if not query:
        return Result("Error: query is required", ok=False)
    jail = svc.state.jail
    root = await asyncio.to_thread(ops.resolve, jail, _str(args, "path", "~") or "~", False, must_exist=True)
    mode = "content" if args.get("in_content") else "name"
    out: list[str] = []
    async for item in search(jail, root, query, mode, False, None, False):
        if item.get("type") == "done":
            if item.get("truncated"):
                out.append("… more results not shown")
            break
        if len(out) >= 80:
            continue
        if mode == "name":
            out.append(item["path"])
        else:
            out.append(f"{item['path']}:{item.get('line', '')}: {str(item.get('text', '')).strip()[:200]}")
    return Result("\n".join(out) or "No matches.")


async def _write(args: dict[str, Any], svc: EmberService) -> Result:
    jail = svc.state.jail
    path = _str(args, "path")
    content = _str(args, "content")
    target = await asyncio.to_thread(ops.resolve_link, jail, path, False, must_exist=False)
    expected: str | None = None
    if target.exists():
        if not args.get("overwrite"):
            return Result("Error: the file exists; call again with overwrite=true to replace it.", ok=False)
        expected = str(os.lstat(target).st_mtime_ns)
    else:
        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
    out = await asyncio.to_thread(ops.write_text, jail, path, False, content, expected)
    return Result(f"Wrote {out['size']} bytes to {out['path']}", meta={"path": out["path"]})


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        TERM="dumb",
        NO_COLOR="1",
        PAGER="cat",
        SYSTEMD_PAGER="cat",
        GIT_PAGER="cat",
        SYSTEMD_COLORS="0",
        DEBIAN_FRONTEND="noninteractive",
    )
    for k in list(env):
        if k.startswith("KILN_"):
            env.pop(k)
    return env


async def run_process(
    argv: list[str],
    svc: EmberService,
    emit: Emit | None,
    *,
    cwd: str,
    timeout: float,  # noqa: ASYNC109 - a deadline for the child process, not for this coroutine
    stdin: bytes | None = None,
) -> tuple[int | None, str, bool]:
    """Run argv in its own process group, streaming output. Returns (exit code, output, timed_out)."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        env=_env(),
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    svc.procs.add(proc)
    buf = bytearray()
    timed_out = False
    pending = bytearray()
    last_emit = time.monotonic()
    try:
        if stdin is not None and proc.stdin is not None:
            proc.stdin.write(stdin)
            with contextlib.suppress(Exception):
                await proc.stdin.drain()
            proc.stdin.close()
        assert proc.stdout is not None
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                chunk = await asyncio.wait_for(proc.stdout.read(8192), timeout=min(remaining, 0.4))
            except TimeoutError:
                chunk = None
            if chunk == b"":
                break
            if chunk:
                if len(buf) < MAX_STREAM:
                    buf.extend(chunk[: MAX_STREAM - len(buf)])
                pending.extend(chunk)
            if emit is not None and pending and (time.monotonic() - last_emit > 0.3 or chunk is None):
                await emit(pending.decode("utf-8", "replace"))
                pending.clear()
                last_emit = time.monotonic()
        if emit is not None and pending:
            await emit(pending.decode("utf-8", "replace"))
        if timed_out:
            kill_group(proc)
        code = await asyncio.wait_for(proc.wait(), timeout=5)
    except BaseException:
        kill_group(proc)
        raise
    finally:
        svc.procs.discard(proc)
    return code, buf.decode("utf-8", "replace"), timed_out


def kill_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)


async def _run(args: dict[str, Any], svc: EmberService, emit: Emit, sudo_password: str | None) -> Result:
    cmd = _str(args, "command").strip()
    timeout = _int(args.get("timeout_seconds"), DEFAULT_TIMEOUT, 1, MAX_TIMEOUT)
    cwd_raw = _str(args, "cwd", "~") or "~"
    cwd = await asyncio.to_thread(ops.resolve, svc.state.jail, cwd_raw, False, must_exist=True)
    stdin: bytes | None = None
    if sudo_password is not None:
        # Only the leading sudo gets the password (-S reads it from stdin; -p '' hides the prompt).
        cmd = re.sub(r"^\s*sudo\s+", "sudo -S -p '' ", cmd, count=1)
        stdin = sudo_password.encode() + b"\n"
    code, out, timed_out = await run_process(["bash", "-c", cmd], svc, emit, cwd=str(cwd), timeout=timeout, stdin=stdin)
    stdin = None
    status = f"timed out after {timeout}s" if timed_out else f"exit code {code}"
    text = out.strip() or "(no output)"
    if sudo_password is not None and re.search(r"incorrect password|Sorry, try again", out):
        text += "\n(sudo rejected the password)"
    return Result(_clip(f"{text}\n[{status}]"), ok=(code == 0 and not timed_out), meta={"exit_code": code})


async def _status(svc: EmberService) -> Result:
    topics = {"cpu", "memory", "gpu", "temps", "disk", "network", "uptime", "battery"}
    snap = await svc.state.metrics.snapshot(topics)
    data = snap.get("data", snap) if isinstance(snap, dict) else snap
    return Result(_clip(json.dumps(data, default=str, indent=1), 8000))


async def _journal(args: dict[str, Any], svc: EmberService, emit: Emit) -> Result:
    argv = ["journalctl", "--no-pager", "-o", "short-iso", "-n", str(_int(args.get("lines"), 60, 1, 400))]
    unit = _str(args, "unit").strip()
    if args.get("user_unit"):
        argv.append("--user")
    if unit:
        if not re.fullmatch(r"[\w@.:\-]+", unit):
            return Result("Error: invalid unit name", ok=False)
        argv += ["-u", unit]
    prio = _str(args, "priority").strip()
    if prio:
        if not re.fullmatch(r"[a-z0-9.]+", prio):
            return Result("Error: invalid priority", ok=False)
        argv += ["-p", prio]
    since = _str(args, "since").strip()
    if since:
        if not re.fullmatch(r"[\w :\-.]+", since):
            return Result("Error: invalid --since value", ok=False)
        argv += ["--since", since]
    code, out, _ = await run_process(argv, svc, None, cwd=str(svc.state.jail.root), timeout=30)
    return Result(_clip(out.strip() or "No journal entries."), ok=code == 0)


async def _packages(args: dict[str, Any], svc: EmberService, emit: Emit) -> Result:
    query = _str(args, "query").strip()
    if not re.fullmatch(r"[\w+.\- ]{1,80}", query):
        return Result("Error: invalid package query", ok=False)
    words = query.split()
    home = str(svc.state.jail.root)
    _, repo, _ = await run_process(["pacman", "-Ss", *words], svc, None, cwd=home, timeout=30)
    parts = [f"Repositories:\n{_clip(repo.strip() or 'No matches.', 8000)}"]
    helper = svc.state.config.packages.aur_helper
    for h in ([helper] if helper in {"yay", "paru"} else []) + ["yay", "paru"]:
        if shutil.which(h):
            _, aur, _ = await run_process([h, "-Ssa", *words], svc, None, cwd=home, timeout=45)
            parts.append(f"AUR ({h}):\n{_clip(aur.strip() or 'No matches.', 8000)}")
            break
    return Result("\n\n".join(parts))


async def _image(args: dict[str, Any], svc: EmberService, emit: Emit) -> Result:
    prompt = _str(args, "prompt").strip()
    size = _str(args, "size", "square")
    out = await svc.generate_image(prompt, size=size, negative=_str(args, "negative"), progress=emit)
    rel = [svc.state.jail.relative(Path(p)) for p in out["paths"]]
    return Result(
        f"Generated {len(rel)} image(s) ({out['width']}×{out['height']}, seed {out['seed']}): "
        + ", ".join(rel)
        + ". The user can already see it; don't repeat the path unless asked.",
        images=rel,
        meta={"seed": out["seed"], "prompt": prompt, "width": out["width"], "height": out["height"]},
    )
