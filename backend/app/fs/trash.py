"""freedesktop.org Trash (home trash): <home>/.local/share/Trash/{files,info}, shared with Dolphin/Nautilus."""

from __future__ import annotations

import contextlib
import errno
import os
import stat as st
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from app.fs import ops
from app.fs.errors import FsError
from app.fs.jail import Jail


def trash_dir(jail: Jail) -> Path:
    return jail.home / ".local" / "share" / "Trash"


def _dirs(jail: Jail, create: bool) -> tuple[Path, Path]:
    base = trash_dir(jail)
    files, info = base / "files", base / "info"
    if create:
        for d in (base.parent, base):
            if not d.exists():
                d.mkdir(mode=0o700, parents=True, exist_ok=True)
        for d in (files, info):
            d.mkdir(mode=0o700, exist_ok=True)
    return files, info


def _check_id(tid: str) -> str:
    if not tid or tid in (".", "..") or "/" in tid or "\0" in tid or tid.endswith(".trashinfo"):
        raise FsError(400, "invalid_path", "Invalid trash id")
    return tid


def _free_id(files: Path, info: Path, name: str) -> str:
    cand, n = name, 1
    while os.path.lexists(files / cand) or os.path.lexists(info / f"{cand}.trashinfo"):
        n += 1
        cand = f"{name}.{n}"
    return cand


def trash_paths(jail: Jail, paths: list[str], allow: bool) -> list[dict[str, str]]:
    if not paths:
        raise FsError(400, "invalid_path", "No paths given")
    tdir = trash_dir(jail)
    targets = [ops.resolve_link(jail, p, allow) for p in paths]
    for t in targets:
        if t == tdir or t.is_relative_to(tdir) or tdir.is_relative_to(t):
            raise FsError(400, "invalid_path", "Cannot trash the trash (or a folder that contains it)")
    files, info = _dirs(jail, True)
    out: list[dict[str, str]] = []
    for t in targets:
        stamp = datetime.now().replace(microsecond=0).isoformat()
        body = f"[Trash Info]\nPath={quote(str(t))}\nDeletionDate={stamp}\n"
        for _ in range(50):
            tid = _free_id(files, info, t.name)
            try:
                fd = os.open(info / f"{tid}.trashinfo", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue
            break
        else:
            raise FsError(409, "exists", "Could not allocate a trash name")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
        try:
            os.rename(t, files / tid)
        except OSError as exc:
            with contextlib.suppress(OSError):
                os.unlink(info / f"{tid}.trashinfo")
            if exc.errno == errno.EXDEV:
                raise FsError(400, "unsupported", "That file is on another filesystem than the trash") from exc
            raise
        out.append({"id": tid, "original_path": jail.relative(t)})
    return out


def _parse_info(jail: Jail, info_file: Path) -> tuple[Path, float] | None:
    path_val = date_val = None
    try:
        for line in info_file.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("Path="):
                path_val = unquote(line[5:])
            elif line.startswith("DeletionDate="):
                date_val = line[13:].strip()
    except OSError:
        return None
    if not path_val:
        return None
    p = Path(path_val)
    if not p.is_absolute():
        p = jail.home / p
    try:
        ts = datetime.fromisoformat(date_val).timestamp() if date_val else info_file.stat().st_mtime
    except ValueError:
        ts = info_file.stat().st_mtime
    return p, ts


def _size(p: Path, limit: int = 50_000) -> int:
    lst = os.lstat(p)
    if not st.S_ISDIR(lst.st_mode):
        return lst.st_size
    total, seen = 0, 0
    for root, _d, names in os.walk(p):
        for n in names:
            seen += 1
            if seen > limit:
                return total
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(root, n)).st_size
    return total


def list_items(jail: Jail) -> list[dict[str, Any]]:
    files, info = _dirs(jail, False)
    items: list[dict[str, Any]] = []
    if not info.is_dir():
        return items
    with os.scandir(info) as it:
        for de in it:
            if not de.name.endswith(".trashinfo"):
                continue
            tid = de.name[: -len(".trashinfo")]
            f = files / tid
            parsed = _parse_info(jail, Path(de.path))
            if parsed is None or not os.path.lexists(f):
                continue
            orig, ts = parsed
            inside = orig == jail.root or orig.is_relative_to(jail.root)
            lst = os.lstat(f)
            etype = "dir" if st.S_ISDIR(lst.st_mode) else "symlink" if st.S_ISLNK(lst.st_mode) else "file"
            items.append(
                {
                    "id": tid,
                    "name": orig.name or tid,
                    "original_path": jail.relative(orig) if inside else str(orig),
                    "deleted_at": ts,
                    "size": _size(f),
                    "type": etype,
                }
            )
    items.sort(key=lambda i: i["deleted_at"], reverse=True)
    return items


def restore(jail: Jail, ids: list[str], allow: bool) -> list[Path]:
    files, info = _dirs(jail, False)
    out: list[Path] = []
    for tid in ids:
        _check_id(tid)
        parsed = _parse_info(jail, info / f"{tid}.trashinfo")
        if parsed is None or not os.path.lexists(files / tid):
            raise FsError(404, "not_found", "No such item in the trash")
        orig, _ts = parsed
        # Re-validate the destination: parent must be inside home and not denied.
        parent = ops.resolve(jail, str(orig.parent), allow)
        dest = parent / orig.name
        ops.check_dest(jail, dest, allow)
        if os.path.lexists(parent) and not parent.is_dir():
            raise FsError(409, "exists", "The original location is not a folder")
        os.makedirs(parent, exist_ok=True)
        dest = ops.unique_name(parent, orig.name)
        os.rename(files / tid, dest)
        with contextlib.suppress(OSError):
            os.unlink(info / f"{tid}.trashinfo")
        out.append(dest)
    return out


def delete_items(jail: Jail, ids: list[str]) -> int:
    files, info = _dirs(jail, False)
    n = 0
    for tid in ids:
        _check_id(tid)
        found = False
        if os.path.lexists(files / tid):
            ops.remove_tree(files / tid)
            found = True
        if os.path.lexists(info / f"{tid}.trashinfo"):
            os.unlink(info / f"{tid}.trashinfo")
            found = True
        n += found
    return n


def empty(jail: Jail) -> int:
    files, info = _dirs(jail, False)
    names: set[str] = set()
    for d, suffix in ((files, ""), (info, ".trashinfo")):
        if d.is_dir():
            for e in os.listdir(d):
                names.add(e[: -len(suffix)] if suffix and e.endswith(suffix) else e)
    return delete_items(jail, sorted(names)) if names else 0
