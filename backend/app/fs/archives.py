"""Zip streaming, compress, archive listing and safe extraction (all blocking; call via to_thread)."""

from __future__ import annotations

import contextlib
import os
import shutil
import stat as st
import tarfile
import time
import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from app.fs import ops
from app.fs.errors import FsError
from app.fs.jail import Jail

MAX_LIST = 5000
MAX_EXTRACT_BYTES = 10 * 1024**3
MAX_EXTRACT_MEMBERS = 100_000
_COPY = 1024 * 1024

TAR_SUFFIXES = {
    ".tar.gz": ("tar.gz", "r:gz"),
    ".tgz": ("tar.gz", "r:gz"),
    ".tar.bz2": ("tar.bz2", "r:bz2"),
    ".tbz2": ("tar.bz2", "r:bz2"),
    ".tar.xz": ("tar.xz", "r:xz"),
    ".txz": ("tar.xz", "r:xz"),
    ".tar.zst": ("tar.zst", "r:zst"),
    ".tar": ("tar", "r:"),
}


def detect(name: str) -> tuple[str, str, str]:
    """(format, tarfile mode or '', suffix)."""
    low = name.lower()
    if low.endswith(".zip"):
        return "zip", "", ".zip"
    for suffix, (fmt, mode) in sorted(TAR_SUFFIXES.items(), key=lambda kv: -len(kv[0])):
        if low.endswith(suffix):
            return fmt, mode, suffix
    raise FsError(400, "unsupported", "Unsupported archive format")


# ------------------------------------------------------------------ file walking


def _link_ok(jail: Jail, p: Path, allow: bool) -> bool:
    real = Path(os.path.realpath(p))
    if not (real == jail.root or real.is_relative_to(jail.root)):
        return False
    return allow or not jail.is_denied(real)


def iter_files(
    jail: Jail, sources: list[Path], allow: bool, skip: Path | None = None
) -> Iterator[tuple[Path, str, bool]]:
    """Yield (path, arcname, is_dir). Skips denied paths and symlinks that leave home; never descends links."""
    for src in sources:
        base = src.name
        lst = os.lstat(src)
        if st.S_ISLNK(lst.st_mode):
            if _link_ok(jail, src, allow) and os.path.isfile(src):
                yield src, base, False
            continue
        if not st.S_ISDIR(lst.st_mode):
            if st.S_ISREG(lst.st_mode):
                yield src, base, False
            continue
        yield src, base, True
        for root, dirs, names in os.walk(src, followlinks=False):
            rp = Path(root)
            dirs[:] = sorted(
                d for d in dirs if not (jail.is_denied(rp / d) and not allow) and not (rp / d).is_symlink()
            )
            for d in dirs:
                yield rp / d, f"{base}/{(rp / d).relative_to(src)}", True
            for n in sorted(names):
                f = rp / n
                if (jail.is_denied(f) and not allow) or f == skip:
                    continue
                if f.is_symlink():
                    if not (_link_ok(jail, f, allow) and os.path.isfile(f)):
                        continue
                elif not st.S_ISREG(os.lstat(f).st_mode):
                    continue
                yield f, f"{base}/{f.relative_to(src)}", False


class _Sink:
    """Non-seekable writer that forwards zip output to the consumer."""

    def __init__(self, emit: Callable[[bytes], None]) -> None:
        self.emit = emit

    def write(self, data: bytes | bytearray | memoryview) -> int:
        b = bytes(data)
        if b:
            self.emit(b)
        return len(b)

    def flush(self) -> None:
        return None


def zip_producer(jail: Jail, sources: list[Path], allow: bool) -> Callable[[Callable[[bytes], None]], None]:
    def run(emit: Callable[[bytes], None]) -> None:
        with zipfile.ZipFile(_Sink(emit), "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:  # type: ignore[call-overload]
            for path, arc, is_dir in iter_files(jail, sources, allow):
                try:
                    if is_dir:
                        zf.mkdir(arc)
                    else:
                        zf.write(path, arc)
                except OSError:
                    continue  # unreadable file: leave it out rather than abort the download

    return run


# ------------------------------------------------------------------ compress


def compress(jail: Jail, paths: list[str], dest: str, allow: bool) -> Path:
    if not paths:
        raise FsError(400, "invalid_path", "No paths given")
    d = ops.resolve_link(jail, dest, allow, must_exist=False)
    name = d.name.lower()
    if name.endswith(".zip"):
        kind = "zip"
    elif name.endswith(".tar.gz") or name.endswith(".tgz"):
        kind = "tgz"
    else:
        raise FsError(400, "unsupported", "Destination must end in .zip or .tar.gz")
    ops.check_dest(jail, d, allow)
    if not d.parent.is_dir():
        raise FsError(404, "not_found", "Destination folder does not exist")
    sources = [ops.resolve_link(jail, p, allow) for p in paths]
    final = ops.unique_name(d.parent, d.name)
    tmp = final.parent / f".{final.name}.kiln-part"
    try:
        if kind == "zip":
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                for path, arc, is_dir in iter_files(jail, sources, allow, skip=tmp):
                    if is_dir:
                        zf.mkdir(arc)
                    else:
                        zf.write(path, arc)
        else:
            with tarfile.open(tmp, "w:gz") as tf:
                for path, arc, _is_dir in iter_files(jail, sources, allow, skip=tmp):
                    tf.add(path, arc, recursive=False)
        os.replace(tmp, final)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    return final


# ------------------------------------------------------------------ list


def _tar_type(m: tarfile.TarInfo) -> str:
    return "dir" if m.isdir() else "symlink" if m.issym() or m.islnk() else "file" if m.isfile() else "other"


def list_archive(jail: Jail, raw: str, allow: bool) -> dict[str, Any]:
    real = ops.resolve(jail, raw, allow, must_exist=True)
    if not real.is_file():
        raise FsError(400, "invalid_path", "Not a file")
    fmt, mode, _ = detect(real.name)
    entries: list[dict[str, Any]] = []
    truncated = False
    try:
        if fmt == "zip":
            with zipfile.ZipFile(real) as zf:
                for i, info in enumerate(zf.infolist()):
                    if i >= MAX_LIST:
                        truncated = True
                        break
                    is_link = st.S_ISLNK(info.external_attr >> 16)
                    entries.append(
                        {
                            "name": info.filename,
                            "size": info.file_size,
                            "type": "dir" if info.is_dir() else "symlink" if is_link else "file",
                            "mtime": _zip_mtime(info),
                        }
                    )
        else:
            with tarfile.open(real, mode) as tf:  # type: ignore[call-overload]
                for i, m in enumerate(tf):
                    if i >= MAX_LIST:
                        truncated = True
                        break
                    entries.append({"name": m.name, "size": m.size, "type": _tar_type(m), "mtime": float(m.mtime)})
    except (zipfile.BadZipFile, tarfile.TarError, EOFError, OSError, ValueError) as exc:
        raise FsError(400, "unsupported", "Could not read this archive") from exc
    return {"format": fmt, "entries": entries, "truncated": truncated}


def _zip_mtime(info: zipfile.ZipInfo) -> float:
    try:
        return time.mktime((*info.date_time, 0, 0, -1))
    except (OverflowError, ValueError):
        return 0.0


# ------------------------------------------------------------------ extract


def _unsafe(msg: str) -> FsError:
    return FsError(400, "unsupported", f"Unsafe archive: {msg}")


def extract(jail: Jail, raw: str, dest_dir: str | None, allow: bool) -> Path:
    real = ops.resolve(jail, raw, allow, must_exist=True)
    if not real.is_file():
        raise FsError(400, "invalid_path", "Not a file")
    fmt, mode, suffix = detect(real.name)
    ddir = ops.resolve(jail, dest_dir, allow, must_exist=True) if dest_dir else real.parent
    if not ddir.is_dir():
        raise FsError(400, "invalid_path", "Destination is not a folder")
    stem = real.name[: -len(suffix)] or "archive"
    ops.check_name(stem)
    out = ops.unique_name(ddir, stem)
    ops.check_dest(jail, out, allow)
    os.mkdir(out)
    try:
        if fmt == "zip":
            _extract_zip(real, out)
        else:
            _extract_tar(real, mode, out)
    except BaseException as exc:
        shutil.rmtree(out, ignore_errors=True)
        if isinstance(exc, (zipfile.BadZipFile, tarfile.TarError, EOFError)):
            raise FsError(400, "unsupported", f"Could not extract: {exc}") from exc
        raise
    return out


def _extract_tar(src: Path, mode: str, out: Path) -> None:
    count = total = 0
    with tarfile.open(src, mode) as tf:  # type: ignore[call-overload]
        for m in tf:
            count += 1
            total += max(m.size, 0)
            if count > MAX_EXTRACT_MEMBERS or total > MAX_EXTRACT_BYTES:
                raise _unsafe("too many files or too large")
            try:
                tf.extract(m, out, filter="data")
            except tarfile.FilterError as exc:
                raise _unsafe(str(exc)) from exc


def _extract_zip(src: Path, out: Path) -> None:
    root = os.path.realpath(out)
    with zipfile.ZipFile(src) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_EXTRACT_MEMBERS or sum(i.file_size for i in infos) > MAX_EXTRACT_BYTES:
            raise _unsafe("too many files or too large")
        for info in infos:  # validate everything before writing anything
            name = info.filename
            parts = name.replace("\\", "/").split("/")
            if name.startswith(("/", "\\")) or ".." in parts or (len(name) > 1 and name[1] == ":") or "\0" in name:
                raise _unsafe(f"bad member name {name!r}")
            if st.S_ISLNK(info.external_attr >> 16):
                raise _unsafe(f"symlink member {name!r}")
            if info.flag_bits & 0x1:
                raise _unsafe("encrypted archive")
        for info in infos:
            target = os.path.normpath(os.path.join(root, info.filename))
            if target != root and not target.startswith(root + os.sep):
                raise _unsafe(f"bad member name {info.filename!r}")
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            perm = ((info.external_attr >> 16) & 0o777) or 0o644
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, (perm | 0o600) & 0o777)
            with os.fdopen(fd, "wb") as dst, zf.open(info) as srcf:
                while chunk := srcf.read(_COPY):
                    dst.write(chunk)
