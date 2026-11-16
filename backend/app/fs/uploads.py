"""Resumable chunked uploads. Partials live in <data_dir>/uploads/<id>.part with a <id>.json sidecar."""

from __future__ import annotations

import contextlib
import errno
import json
import os
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from app.fs import ops
from app.fs.errors import FsError
from app.fs.jail import Jail

CHUNK_SIZE = 4 * 1024 * 1024
EXPIRY_S = 24 * 3600
MAX_UPLOAD = 1024**4
_ID_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")


def _dir(data_dir: Path) -> Path:
    d = data_dir / "uploads"
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    return d


def _paths(data_dir: Path, uid: str) -> tuple[Path, Path]:
    if not _ID_RE.fullmatch(uid):
        raise FsError(404, "not_found", "No such upload")
    d = _dir(data_dir)
    return d / f"{uid}.part", d / f"{uid}.json"


def purge_expired(data_dir: Path) -> None:
    now = time.time()
    for p in _dir(data_dir).iterdir():
        with contextlib.suppress(OSError):
            if now - p.stat().st_mtime > EXPIRY_S:
                p.unlink()


def _meta(data_dir: Path, uid: str) -> tuple[Path, dict[str, Any]]:
    part, meta = _paths(data_dir, uid)
    try:
        info: dict[str, Any] = json.loads(meta.read_text("utf-8"))
        os.stat(part)
    except (OSError, ValueError) as exc:
        raise FsError(404, "not_found", "No such upload") from exc
    return part, info


def init(jail: Jail, data_dir: Path, dest_dir: str, name: str, size: int, allow: bool) -> dict[str, Any]:
    ops.check_name(name)
    if size < 0 or size > MAX_UPLOAD:
        raise FsError(400, "invalid_path", "Invalid size")
    ddir = ops.resolve(jail, dest_dir, allow, must_exist=True)
    if not ddir.is_dir():
        raise FsError(400, "invalid_path", "Destination is not a folder")
    ops.check_dest(jail, ddir / name, allow)
    purge_expired(data_dir)
    uid = secrets.token_urlsafe(16)
    part, meta = _paths(data_dir, uid)
    fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    meta.write_text(json.dumps({"dest_dir": str(ddir), "name": name, "size": size, "created": time.time()}), "utf-8")
    return {"upload_id": uid, "chunk_size": CHUNK_SIZE, "received": 0}


def status(data_dir: Path, uid: str) -> dict[str, Any]:
    part, info = _meta(data_dir, uid)
    return {"received": part.stat().st_size, "size": info["size"]}


def append(data_dir: Path, uid: str, offset: int, data: bytes) -> dict[str, Any]:
    part, info = _meta(data_dir, uid)
    received = part.stat().st_size
    if offset != received:
        raise FsError(409, "offset_mismatch", "Offset does not match what was received", received=received)
    if received + len(data) > info["size"]:
        raise FsError(413, "too_large", "More data than the declared size")
    with open(part, "ab") as f:
        f.write(data)
    return {"received": received + len(data)}


def abort(data_dir: Path, uid: str) -> None:
    part, meta = _paths(data_dir, uid)
    for p in (part, meta):
        with contextlib.suppress(FileNotFoundError):
            p.unlink()


def complete(jail: Jail, data_dir: Path, uid: str, conflict: str, allow: bool) -> Path:
    if conflict not in ops.CONFLICTS:
        raise FsError(400, "unsupported", "conflict must be rename, overwrite or error")
    part, info = _meta(data_dir, uid)
    if part.stat().st_size != info["size"]:
        raise FsError(409, "incomplete", "Upload is not finished", received=part.stat().st_size)
    ddir = ops.resolve(jail, info["dest_dir"], allow, must_exist=True)
    if not ddir.is_dir():
        raise FsError(400, "invalid_path", "Destination is not a folder")
    dest: Path = ddir / str(info["name"])
    ops.check_dest(jail, dest, allow)
    if os.path.lexists(dest):
        if conflict == "error":
            raise FsError(409, "exists", f"'{dest.name}' already exists")
        if conflict == "rename":
            dest = ops.unique_name(ddir, info["name"])
        elif os.path.isdir(dest) and not os.path.islink(dest):
            raise FsError(409, "exists", f"'{dest.name}' is a folder")
    mode = 0o666 & ~_umask()
    os.chmod(part, mode)
    try:
        if conflict == "overwrite":
            os.replace(part, dest)
        else:
            os.link(part, dest)  # atomic exclusive create on the same filesystem
            os.unlink(part)
    except OSError as exc:
        if exc.errno not in (errno.EXDEV, errno.EPERM, errno.EMLINK):
            raise
        fd, tmp = tempfile.mkstemp(prefix=f".{dest.name}.", suffix=".kiln-tmp", dir=ddir)
        os.close(fd)
        try:
            shutil.copyfile(part, tmp)
            os.chmod(tmp, mode)
            os.replace(tmp, dest)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
        os.unlink(part)
    with contextlib.suppress(FileNotFoundError):
        _paths(data_dir, uid)[1].unlink()
    return dest


def _umask() -> int:
    try:
        with open("/proc/self/status", encoding="ascii") as f:
            for line in f:
                if line.startswith("Umask:"):
                    return int(line.split()[1], 8)
    except (OSError, ValueError):
        pass
    return 0o022
