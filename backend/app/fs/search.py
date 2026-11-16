"""Name and content search. Uses fd / rg when installed, otherwise a threaded os.walk fallback."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import fnmatch
import json
import os
import shutil
import time
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from pathlib import Path
from typing import Any

from app.fs import ops
from app.fs.jail import Jail
from app.fs.threadgen import aiter_thread

MAX_MATCHES = 500
TIMEOUT_S = 20.0
MAX_LINE = 1000
MAX_FILE = 5 * 1024 * 1024
_SKIP_DIRS = {".git", "node_modules", "__pycache__"}


def _excludes(jail: Jail, root: Path) -> list[str]:
    """Denylisted directories under the search root as root-anchored patterns."""
    out: list[str] = []
    for prefix in jail.denied_prefixes:
        if prefix != root and prefix.is_relative_to(root):
            out.append("/" + str(prefix.relative_to(root)))
    return out


async def _run(argv: list[str], cwd: Path, deadline: float) -> AsyncIterator[bytes]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    assert proc.stdout is not None
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            line = await asyncio.wait_for(proc.stdout.readline(), remaining)
            if not line:
                return
            yield line
    finally:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
        with contextlib.suppress(Exception):
            await asyncio.shield(proc.wait())


def _char_ranges(line: bytes, subs: list[dict[str, Any]]) -> list[list[int]]:
    out = []
    for s in subs:
        a = len(line[: s["start"]].decode("utf-8", "ignore"))
        b = len(line[: s["end"]].decode("utf-8", "ignore"))
        out.append([a, b])
    return out


def _smart_ci(q: str) -> bool:
    return q == q.lower()


async def search(
    jail: Jail, root: Path, q: str, mode: str, hidden: bool, glob: str | None, allow: bool
) -> AsyncGenerator[dict[str, Any]]:
    """Yield result dicts, ending with {"type": "done", ...}."""
    count = 0
    truncated = False
    deadline = time.monotonic() + TIMEOUT_S
    fd = shutil.which("fd")
    rg = shutil.which("rg")
    try:
        if mode == "name":
            source = _fd_name(jail, root, q, hidden, fd, deadline) if fd else _walk_name(jail, root, q, hidden)
        else:
            source = (
                _rg_content(jail, root, q, hidden, glob, rg, deadline)
                if rg
                else _walk_content(jail, root, q, hidden, glob)
            )
        async for item in source:
            path: Path = item.pop("_path")
            if not allow and jail.is_denied(path):
                continue
            if mode == "name":
                if glob and not fnmatch.fnmatch(path.name, glob):
                    continue
                try:
                    out = await asyncio.to_thread(ops.entry_for, jail, path)
                except OSError:
                    continue
                yield {**out, "kind": out["type"], "type": "match"}
            else:
                yield {"type": "match", "path": jail.relative(path), "name": path.name, **item}
            count += 1
            if count >= MAX_MATCHES:
                truncated = True
                break
    except TimeoutError:
        truncated = True
    yield {"type": "done", "count": count, "truncated": truncated}


# -------------------------------------------------------------- fd / rg


async def _fd_name(
    jail: Jail, root: Path, q: str, hidden: bool, fd: str | None, deadline: float
) -> AsyncIterator[dict[str, Any]]:
    argv = [str(fd), "--color", "never", "--fixed-strings", "--no-ignore"]
    if hidden:
        argv.append("--hidden")
    for e in _excludes(jail, root):
        argv += ["--exclude", e]
    argv += ["--", q, "."]
    async for line in _run(argv, root, deadline):
        rel = line.rstrip(b"\n").decode("utf-8", "surrogateescape")
        path = root / rel
        if path != root and path.is_relative_to(root):
            yield {"_path": path}


async def _rg_content(
    jail: Jail, root: Path, q: str, hidden: bool, glob: str | None, rg: str | None, deadline: float
) -> AsyncIterator[dict[str, Any]]:
    argv = [str(rg), "--json", "--fixed-strings", "--smart-case", "--max-filesize", "5M", "--no-messages"]
    if hidden:
        argv.append("--hidden")
    if glob:
        argv += ["-g", glob]
    for e in _excludes(jail, root):
        argv += ["-g", "!" + e]
    argv += ["-e", q, "--", "."]
    async for line in _run(argv, root, deadline):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") != "match":
            continue
        d = ev["data"]
        ptxt = d["path"].get("text")
        ltxt = d["lines"].get("text")
        raw = d["lines"].get("bytes")
        if ptxt is None:
            continue
        raw_line = ltxt.encode("utf-8") if ltxt is not None else base64.b64decode(raw or "")
        raw_line = raw_line.rstrip(b"\r\n")
        text = raw_line.decode("utf-8", "replace")
        ranges = [r for r in _char_ranges(raw_line, d["submatches"]) if r[1] <= MAX_LINE]
        path = root / ptxt
        if path.is_relative_to(root):
            yield {"_path": path, "line": d["line_number"], "text": text[:MAX_LINE], "ranges": ranges}


# -------------------------------------------------------------- fallback


async def _walk_name(jail: Jail, root: Path, q: str, hidden: bool) -> AsyncIterator[dict[str, Any]]:
    needle = q.lower() if _smart_ci(q) else q

    def run(emit: Callable[[dict[str, Any]], None]) -> None:
        deadline = time.monotonic() + TIMEOUT_S
        for dirpath, dirs, files in os.walk(root, followlinks=False):
            if time.monotonic() > deadline:
                return
            dp = Path(dirpath)
            dirs[:] = sorted(
                d
                for d in dirs
                if (hidden or not d.startswith(".")) and d not in _SKIP_DIRS and not jail.is_denied(dp / d)
            )
            for n in sorted(dirs + files):
                if not hidden and n.startswith("."):
                    continue
                hay = n.lower() if _smart_ci(q) else n
                if needle in hay:
                    emit({"_path": dp / n})

    async for item in aiter_thread(run):
        yield item


async def _walk_content(
    jail: Jail, root: Path, q: str, hidden: bool, glob: str | None
) -> AsyncIterator[dict[str, Any]]:
    ci = _smart_ci(q)
    needle = q.lower() if ci else q

    def run(emit: Callable[[dict[str, Any]], None]) -> None:
        deadline = time.monotonic() + TIMEOUT_S
        for dirpath, dirs, files in os.walk(root, followlinks=False):
            if time.monotonic() > deadline:
                return
            dp = Path(dirpath)
            dirs[:] = sorted(
                d
                for d in dirs
                if (hidden or not d.startswith(".")) and d not in _SKIP_DIRS and not jail.is_denied(dp / d)
            )
            for n in sorted(files):
                if (not hidden and n.startswith(".")) or (glob and not fnmatch.fnmatch(n, glob)):
                    continue
                p = dp / n
                try:
                    if p.is_symlink() or not p.is_file() or p.stat().st_size > MAX_FILE:
                        continue
                    with open(p, "rb") as f:
                        if b"\0" in f.read(8192):
                            continue
                        f.seek(0)
                        for lineno, raw in enumerate(f, 1):
                            line = raw.rstrip(b"\r\n").decode("utf-8", "replace")
                            hay = line.lower() if ci else line
                            ranges, start = [], hay.find(needle)
                            while start != -1:
                                ranges.append([start, start + len(needle)])
                                start = hay.find(needle, start + len(needle))
                            if ranges:
                                emit(
                                    {
                                        "_path": p,
                                        "line": lineno,
                                        "text": line[:MAX_LINE],
                                        "ranges": [r for r in ranges if r[1] <= MAX_LINE],
                                    }
                                )
                except OSError:
                    continue

    async for item in aiter_thread(run):
        yield item
