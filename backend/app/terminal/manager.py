"""PTY-backed terminal sessions that outlive their WebSocket (tmux-lite).

Each Term owns a login shell on its own pty/session. Output goes into a bounded ring
buffer (replayed on re-attach) and to at most one attached consumer. Terminal contents
are never logged or audited.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import logging
import os
import pwd
import secrets
import signal
import struct
import subprocess
import termios
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.audit.log import AuditLog
from app.config import Config
from app.fs.jail import Jail, JailError

log = logging.getLogger("kiln.terminal")

EXITED_KEEP_S = 60.0
TICK_S = 0.5
QUEUE_MAX = 256
READ_CHUNK = 65536
PENDING_WRITE_MAX = 1 << 20
KILL_GRACE_S = 2.0


class TerminalError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Signal:
    """Control items delivered through a consumer queue (output bytes are plain `bytes`)."""

    def __init__(self, kind: str) -> None:
        self.kind = kind


EXIT = Signal("exit")
KICKED = Signal("kicked")
RESYNC = Signal("resync")


class Consumer:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[bytes | Signal] = asyncio.Queue(maxsize=QUEUE_MAX)
        self.dead = False  # set once a control signal was delivered; no more output is queued

    def push(self, data: bytes) -> None:
        if self.dead:
            return
        try:
            self.queue.put_nowait(data)
        except asyncio.QueueFull:
            self.signal(RESYNC)  # too slow: drop the backlog; the client re-attaches and gets the replay

    def signal(self, sig: Signal) -> None:
        if self.dead:
            return
        self.dead = True
        while True:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self.queue.put_nowait(sig)


@dataclass
class Term:
    id: str
    pid: int
    shell: str
    cwd: str
    created_at: float
    master_fd: int
    proc: subprocess.Popen[bytes]
    scrollback_bytes: int
    ip: str | None = None
    session_id: str | None = None
    buffer: bytearray = field(default_factory=bytearray)
    alive: bool = True
    exit_code: int | None = None
    exited_at: float | None = None
    last_detached_at: float = field(default_factory=time.time)
    consumer: Consumer | None = None
    end_reason: str | None = None
    pending: bytearray = field(default_factory=bytearray)
    writer_on: bool = False
    killing: bool = False

    @property
    def attached(self) -> bool:
        return self.consumer is not None and not self.consumer.dead

    def append(self, data: bytes) -> None:
        self.buffer += data
        excess = len(self.buffer) - self.scrollback_bytes
        if excess > 0:
            del self.buffer[:excess]
        if self.consumer is not None:
            self.consumer.push(data)

    def attach(self) -> tuple[Consumer, bytes]:
        """Register a new consumer (kicking any existing one) and snapshot the replay buffer atomically."""
        if self.consumer is not None:
            self.consumer.signal(KICKED)
        consumer = Consumer()
        self.consumer = consumer
        return consumer, bytes(self.buffer)

    def detach(self, consumer: Consumer) -> None:
        if self.consumer is consumer:
            self.consumer = None
            self.last_detached_at = time.time()

    def title(self) -> str:
        """Short label: current directory, prefixed by the foreground program when it is not the shell."""
        try:
            return self._title()
        except Exception:
            return os.path.basename(self.shell) or "terminal"

    def _title(self) -> str:
        cwd = self.cwd
        with contextlib.suppress(OSError):
            cwd = os.readlink(f"/proc/{self.pid}/cwd")
        label = _short_path(cwd)
        if not self.alive:
            return label
        fg = ""
        with contextlib.suppress(OSError, ValueError):
            pgid = os.tcgetpgrp(self.master_fd)
            if pgid != self.pid:
                fg = Path(f"/proc/{pgid}/comm").read_text(errors="replace").strip()
        return f"{fg} · {label}" if fg else label

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title(),
            "shell": self.shell,
            "cwd": self.cwd,
            "created_at": self.created_at,
            "alive": self.alive,
            "exit_code": self.exit_code,
            "attached": self.attached,
        }


def _short_path(path: str) -> str:
    home = str(Path.home())
    if path == home:
        return "~"
    if path.startswith(home + "/"):
        parts = path[len(home) + 1 :].split("/")
        return "~/" + "/".join(parts) if len(parts) <= 2 else "~/…/" + "/".join(parts[-2:])
    if path == "/":
        return "/"
    return os.path.basename(path.rstrip("/")) or path


def pick_shell(configured: str) -> str:
    candidates = [os.path.expanduser(configured), os.environ.get("SHELL", "")]
    with contextlib.suppress(KeyError):
        candidates.append(pwd.getpwuid(os.getuid()).pw_shell)
    candidates.append("/bin/bash")
    for c in candidates:
        if c and os.path.isabs(c) and os.access(c, os.X_OK):
            return c
    return "/bin/sh"


def clamp_size(cols: int, rows: int) -> tuple[int, int]:
    return max(2, min(1000, int(cols))), max(1, min(500, int(rows)))


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _make_controlling_tty() -> None:  # pragma: no cover - runs in the forked child
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def _spawn(shell: str, slave: int, cwd: str, env: dict[str, str]) -> subprocess.Popen[bytes]:
    # argv[0] with a leading dash makes the shell a login shell.
    return subprocess.Popen(  # noqa: S603 - the user's own shell is the whole point
        ["-" + os.path.basename(shell)],
        executable=shell,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=cwd,
        env=env,
        start_new_session=True,
        preexec_fn=_make_controlling_tty,  # noqa: PLW1509
    )


class TerminalManager:
    def __init__(self, config: Config, audit: AuditLog) -> None:
        self.config = config
        self.audit = audit
        self.terms: dict[str, Term] = {}
        self._task: asyncio.Task[None] | None = None
        self._bg: set[asyncio.Task[Any]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.create_task(self._housekeeping())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self._kill_all("killed")

    async def panic(self) -> None:
        await self._kill_all("panic")

    async def _kill_all(self, reason: str) -> None:
        for term in list(self.terms.values()):
            self._hard_kill(term, reason)
        await self._drain_bg()
        self.terms.clear()

    async def settle(self) -> None:
        """Wait for pending audit writes."""
        await self._drain_bg()

    async def _drain_bg(self) -> None:
        while self._bg:
            await asyncio.gather(*list(self._bg), return_exceptions=True)

    def _spawn_bg(self, coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)

    # ------------------------------------------------------------ create

    def _resolve_cwd(self, cwd: str | None) -> str:
        try:
            jail = Jail(self.config.files.jail_root, [])
        except ValueError:
            return str(Path.home())
        if cwd:
            try:
                real = jail.resolve(os.path.expanduser(cwd)).path
                if real.is_dir():
                    return str(real)
            except (JailError, OSError):
                pass
        return str(jail.root)

    async def create(self, cwd: str | None, cols: int, rows: int, ip: str | None, session_id: str | None) -> Term:
        if sum(1 for t in self.terms.values() if t.alive) >= self.config.terminal.max_sessions:
            raise TerminalError("too_many", f"Terminal limit reached ({self.config.terminal.max_sessions})")
        loop = asyncio.get_running_loop()
        self._loop = loop
        cols, rows = clamp_size(cols, rows)
        start_dir = self._resolve_cwd(cwd)
        shell = pick_shell(self.config.terminal.shell)
        env = {k: v for k, v in os.environ.items() if not k.startswith("KILN_")}
        env.update(TERM="xterm-256color", COLORTERM="truecolor", KILN_TERMINAL="1", SHELL=shell)
        env.setdefault("LANG", "C.UTF-8")
        master, slave = os.openpty()
        try:
            _set_winsize(master, cols, rows)
            proc = _spawn(shell, slave, start_dir, env)
        except (OSError, TypeError, ValueError) as exc:
            os.close(master)
            raise TerminalError("spawn_failed", f"Could not start {shell}: {exc}") from exc
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        term = Term(
            id=secrets.token_urlsafe(9),
            pid=proc.pid,
            shell=shell,
            cwd=start_dir,
            created_at=time.time(),
            master_fd=master,
            proc=proc,
            scrollback_bytes=self.config.terminal.scrollback_bytes,
            ip=ip,
            session_id=session_id,
        )
        self.terms[term.id] = term
        loop.add_reader(master, self._on_readable, term)
        await self.audit.record("terminal.start", ip=ip, session_id=session_id, id=term.id, shell=shell, cwd=start_dir)
        return term

    # ------------------------------------------------------------ io

    def _on_readable(self, term: Term) -> None:
        try:
            data = os.read(term.master_fd, READ_CHUNK)
        except BlockingIOError:
            return
        except OSError:  # EIO: every slave fd is closed, i.e. the session ended
            data = b""
        if data:
            term.append(data)
        else:
            self._finalize(term, "exit")

    def get(self, tid: str) -> Term:
        term = self.terms.get(tid)
        if term is None:
            raise TerminalError("not_found", "No such terminal")
        return term

    def write(self, tid: str, data: bytes) -> None:
        term = self.get(tid)
        if not term.alive or not data:
            return
        if term.pending:
            self._queue_write(term, data)
            return
        try:
            n = os.write(term.master_fd, data)
        except BlockingIOError:
            n = 0
        except OSError:
            return
        if n < len(data):
            self._queue_write(term, data[n:])

    def _queue_write(self, term: Term, data: bytes) -> None:
        if len(term.pending) + len(data) > PENDING_WRITE_MAX or self._loop is None:
            return
        term.pending += data
        if not term.writer_on:
            term.writer_on = True
            self._loop.add_writer(term.master_fd, self._flush, term)

    def _flush(self, term: Term) -> None:
        try:
            n = os.write(term.master_fd, bytes(term.pending))
            del term.pending[:n]
        except BlockingIOError:
            return
        except OSError:
            term.pending.clear()
        if not term.pending:
            self._stop_writer(term)

    def _stop_writer(self, term: Term) -> None:
        if term.writer_on and self._loop is not None:
            term.writer_on = False
            with contextlib.suppress(Exception):
                self._loop.remove_writer(term.master_fd)

    def resize(self, tid: str, cols: int, rows: int) -> None:
        term = self.get(tid)
        if term.alive:
            cols, rows = clamp_size(cols, rows)
            with contextlib.suppress(OSError):
                _set_winsize(term.master_fd, cols, rows)

    def list(self) -> list[Term]:
        return sorted(self.terms.values(), key=lambda t: t.created_at)

    # ------------------------------------------------------------ ending

    def _signal_group(self, term: Term, sig: int) -> None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(term.pid, sig)

    def _hard_kill(self, term: Term, reason: str) -> None:
        if term.alive:
            term.end_reason = term.end_reason or reason
            self._signal_group(term, signal.SIGKILL)
            with contextlib.suppress(Exception):
                term.proc.kill()
            for _ in range(50):  # reap without blocking the loop for long
                if term.proc.poll() is not None:
                    break
                time.sleep(0.002)
            self._finalize(term, reason)

    async def kill(self, tid: str, reason: str = "killed", remove: bool = True) -> None:
        term = self.get(tid)
        if term.alive and not term.killing:
            term.killing = True
            term.end_reason = reason
            self._signal_group(term, signal.SIGHUP)
            deadline = time.monotonic() + KILL_GRACE_S
            while term.alive and time.monotonic() < deadline:
                if term.proc.poll() is not None:
                    self._finalize(term, reason)
                    break
                await asyncio.sleep(0.02)
            if term.alive:
                self._hard_kill(term, reason)
        if remove:
            self.terms.pop(tid, None)

    def _finalize(self, term: Term, reason: str) -> None:
        """Mark a terminal ended: drain output, close the pty, tell the consumer, audit once."""
        if not term.alive:
            return
        if self._loop is not None:
            with contextlib.suppress(Exception):
                self._loop.remove_reader(term.master_fd)
        self._stop_writer(term)
        for _ in range(64):  # collect output that arrived between the last read and exit
            try:
                data = os.read(term.master_fd, READ_CHUNK)
            except OSError:
                break
            if not data:
                break
            term.append(data)
        term.alive = False
        code = term.proc.poll()
        if code is None:
            for _ in range(50):
                code = term.proc.poll()
                if code is not None:
                    break
                time.sleep(0.002)
        term.exit_code = (128 - code) if code is not None and code < 0 else code
        term.exited_at = time.time()
        with contextlib.suppress(OSError):
            os.close(term.master_fd)
        term.end_reason = term.end_reason or reason
        if term.consumer is not None:
            term.consumer.signal(EXIT)
        self._spawn_bg(
            self.audit.record(
                "terminal.end",
                actor="system",
                session_id=term.session_id,
                id=term.id,
                exit_code=term.exit_code,
                duration_s=round(term.exited_at - term.created_at, 1),
                reason=term.end_reason,
            )
        )

    async def _housekeeping(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            keep_s = self.config.terminal.keep_alive_minutes * 60
            now = time.time()
            for term in list(self.terms.values()):
                with contextlib.suppress(Exception):
                    if term.alive:
                        if term.proc.poll() is not None:
                            self._finalize(term, "exit")
                        elif not term.attached and not term.killing and now - term.last_detached_at > keep_s:
                            self._spawn_bg(self.kill(term.id, "expired", remove=False))
                    elif term.exited_at is not None and now - term.exited_at > EXITED_KEEP_S:
                        self.terms.pop(term.id, None)
