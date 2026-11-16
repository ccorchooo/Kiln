"""Blocking filesystem operations. Every function here is meant to run via asyncio.to_thread.

Every path goes through the Jail. `allow` is True only when the session was recently re-authenticated.
Operations that act on a link itself (rename/move/trash/delete/chmod) resolve the *parent* through the jail
and join the final name lexically, so they never follow the last component.
"""

from __future__ import annotations

import contextlib
import errno
import grp
import hashlib
import mimetypes
import os
import pwd
import re
import shutil
import stat as st
import tempfile
from pathlib import Path
from typing import Any

from app.fs.errors import FsError, from_jail
from app.fs.jail import Jail, JailError

MAX_NAME_BYTES = 255
CONFLICTS = ("rename", "overwrite", "error")

_EXTRA_MIME = {
    ".md": "text/markdown",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".obj": "model/obj",
    ".fbx": "model/fbx",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".toml": "text/toml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".sh": "text/x-shellscript",
    ".fish": "text/x-shellscript",
    ".zsh": "text/x-shellscript",
    ".conf": "text/plain",
    ".ini": "text/plain",
    ".log": "text/plain",
}


# ------------------------------------------------------------------ resolving


def resolve(jail: Jail, raw: str, allow: bool, *, must_exist: bool = False) -> Path:
    """Follow-symlinks resolution (reading, listing, destinations)."""
    try:
        return jail.resolve(raw, allow_denied=allow, must_exist=must_exist).path
    except JailError as exc:
        raise from_jail(exc) from exc


def resolve_link(jail: Jail, raw: str, allow: bool, *, must_exist: bool = True) -> Path:
    """Resolve the parent through the jail and join the last component lexically (acts on links themselves)."""
    try:
        Jail._validate_text(raw)
    except JailError as exc:
        raise from_jail(exc) from exc
    expanded = jail._expand(raw.strip() or ".")
    candidate = expanded if os.path.isabs(expanded) else os.path.join(jail.root, expanded)
    lexical = Path(os.path.normpath(candidate))
    if lexical == jail.root or lexical.parent == lexical:
        raise FsError(400, "invalid_path", "That location cannot be modified")
    parent = resolve(jail, str(lexical.parent), allow)
    target = parent / lexical.name
    if jail.is_denied(target) and not allow:
        raise FsError(403, "denied", "That location is protected. Confirm your password to open it.")
    if must_exist and not os.path.lexists(target):
        raise FsError(404, "not_found", "No such file or folder")
    return target


def check_name(name: str) -> str:
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise FsError(400, "invalid_path", "Invalid name")
    if len(name.encode("utf-8", "surrogatepass")) > MAX_NAME_BYTES:
        raise FsError(400, "invalid_path", "Name is too long")
    try:
        Jail._validate_text(name)
    except JailError as exc:
        raise from_jail(exc) from exc
    return name


def check_dest(jail: Jail, dest: Path, allow: bool) -> None:
    """A destination must be inside the root (guaranteed by parent resolution) and not denied."""
    if not (dest == jail.root or dest.is_relative_to(jail.root)):
        raise FsError(403, "outside_jail", "That location is outside your home folder")
    if jail.is_denied(dest) and not allow:
        raise FsError(403, "denied", "That location is protected. Confirm your password to open it.")


def unique_name(directory: Path, name: str) -> Path:
    candidate = directory / name
    if not os.path.lexists(candidate):
        return candidate
    stem, ext = os.path.splitext(name)
    for n in range(2, 10_000):
        candidate = directory / f"{stem} ({n}){ext}"
        if not os.path.lexists(candidate):
            return candidate
    raise FsError(409, "exists", "Too many name conflicts")


# ------------------------------------------------------------------ entries


def _names(uid: int, gid: int) -> tuple[str, str]:
    try:
        owner = pwd.getpwuid(uid).pw_name
    except KeyError:
        owner = str(uid)
    try:
        group = grp.getgrgid(gid).gr_name
    except KeyError:
        group = str(gid)
    return owner, group


def guess_mime(path: Path, name: str, is_file: bool) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in _EXTRA_MIME:
        return _EXTRA_MIME[ext]
    mime = mimetypes.guess_type(name)[0]
    if mime:
        return mime
    if not is_file:
        return "application/octet-stream"
    try:
        with open(path, "rb") as f:
            head = f.read(2048)
    except OSError:
        return "application/octet-stream"
    return "application/octet-stream" if b"\0" in head else "text/plain"


def entry_for(jail: Jail, path: Path, lst: os.stat_result | None = None) -> dict[str, Any]:
    """Entry dict for `path` (not followed). `path` must already be validated and inside the root."""
    lst = lst or os.lstat(path)
    mode = lst.st_mode
    target: str | None = None
    link_type: str | None = None
    if st.S_ISLNK(mode):
        etype = "symlink"
        with contextlib.suppress(OSError):
            real = Path(os.path.realpath(path))
            if real == jail.root or real.is_relative_to(jail.root):
                target = jail.relative(real)
        try:
            tst = os.stat(path)
            link_type = "dir" if st.S_ISDIR(tst.st_mode) else "file"
        except OSError:
            link_type = None
    elif st.S_ISDIR(mode):
        etype = "dir"
    elif st.S_ISREG(mode):
        etype = "file"
    else:
        etype = "other"
    owner, group = _names(lst.st_uid, lst.st_gid)
    name = path.name
    is_file = etype == "file"
    return {
        "name": name,
        "path": jail.relative(path),
        "type": etype,
        "size": lst.st_size,
        "mtime": lst.st_mtime,
        "mode": f"{st.S_IMODE(mode):03o}",
        "owner": owner,
        "group": group,
        "hidden": name.startswith("."),
        "mime": guess_mime(path, name, is_file) if etype != "dir" else "inode/directory",
        "denied": jail.is_denied(path),
        "target": target,
        "link_type": link_type,
    }


def entry_of(jail: Jail, path: Path) -> dict[str, Any]:
    try:
        return entry_for(jail, path)
    except FileNotFoundError as exc:
        raise FsError(404, "not_found", "No such file or folder") from exc


def list_dir(jail: Jail, raw: str, allow: bool, hidden: bool) -> dict[str, Any]:
    real = resolve(jail, raw, allow, must_exist=True)
    if not real.is_dir():
        raise FsError(400, "invalid_path", "Not a folder")
    entries: list[dict[str, Any]] = []
    try:
        with os.scandir(real) as it:
            for de in it:
                if not hidden and de.name.startswith("."):
                    continue
                try:
                    entries.append(entry_for(jail, real / de.name, de.stat(follow_symlinks=False)))
                except OSError:
                    continue
    except PermissionError as exc:
        raise FsError(403, "denied", "Permission denied") from exc
    entries.sort(key=lambda e: (e["type"] != "dir" and e["link_type"] != "dir", e["name"].casefold(), e["name"]))
    return {
        "path": jail.relative(real),
        "name": real.name if real != jail.root else "~",
        "parent": None if real == jail.root else jail.relative(real.parent),
        "entries": entries,
    }


def stat_path(jail: Jail, raw: str, allow: bool) -> dict[str, Any]:
    # Resolve the parent through the jail so a link pointing outside can still be inspected as a link.
    p = resolve_link(jail, raw, allow) if raw.strip() not in ("", "~", ".") else jail.root
    lst = os.lstat(p)
    out = entry_for(jail, p, lst)
    out["atime"] = lst.st_atime
    out["ctime"] = lst.st_ctime
    items: int | None = None
    if st.S_ISDIR(lst.st_mode):
        with contextlib.suppress(OSError):
            items = sum(1 for _ in os.scandir(p))
    out["items"] = items
    real = Path(os.path.realpath(p))
    out["real"] = jail.relative(real) if real == jail.root or real.is_relative_to(jail.root) else None
    return out


# ------------------------------------------------------------------ text


def read_text(jail: Jail, raw: str, allow: bool) -> dict[str, Any]:
    real = resolve(jail, raw, allow, must_exist=True)
    if not real.is_file():
        raise FsError(400, "invalid_path", "Not a file")
    try:
        jail.check_read_size(real)
    except JailError as exc:
        raise from_jail(exc) from exc
    with open(real, "rb") as f:
        fst = os.fstat(f.fileno())
        data = f.read(jail.max_read_bytes + 1)
    if len(data) > jail.max_read_bytes:
        raise FsError(413, "too_large", "File is too large")
    try:
        if b"\0" in data:
            raise UnicodeDecodeError("utf-8", b"", 0, 1, "NUL")
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FsError(415, "binary", "This file is not UTF-8 text") from exc
    return {
        "path": jail.relative(real),
        "content": content,
        "mtime_ns": str(fst.st_mtime_ns),
        "size": len(data),
        "encoding": "utf-8",
        "eol": "crlf" if b"\r\n" in data else "lf",
    }


def write_text(jail: Jail, raw: str, allow: bool, content: str, expected: str | None) -> dict[str, Any]:
    data = content.encode("utf-8")
    if len(data) > jail.max_read_bytes:
        raise FsError(413, "too_large", "Content is too large")
    target = resolve_link(jail, raw, allow, must_exist=False)
    if not target.parent.is_dir():
        raise FsError(404, "not_found", "Parent folder does not exist")
    if expected is None:
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o666)
        except FileExistsError as exc:
            raise FsError(409, "exists", "A file with that name already exists") from exc
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        s = os.lstat(target)
        return {"path": jail.relative(target), "mtime_ns": str(s.st_mtime_ns), "size": s.st_size}
    try:
        lst = os.lstat(target)
    except FileNotFoundError as exc:
        raise FsError(404, "not_found", "No such file") from exc
    if st.S_ISLNK(lst.st_mode):
        raise FsError(400, "unsupported", "Refusing to write through a symlink")
    if not st.S_ISREG(lst.st_mode):
        raise FsError(400, "unsupported", "Not a regular file")
    if str(lst.st_mtime_ns) != expected:
        raise FsError(409, "conflict", "The file changed on disk", current_mtime_ns=str(lst.st_mtime_ns))
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".kiln-tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
            os.fchmod(f.fileno(), st.S_IMODE(lst.st_mode))
        with contextlib.suppress(OSError):
            os.chown(tmp, lst.st_uid, lst.st_gid)
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    s = os.lstat(target)
    return {"path": jail.relative(target), "mtime_ns": str(s.st_mtime_ns), "size": s.st_size}


# ------------------------------------------------------------------ create / rename / chmod


def mkdir(jail: Jail, raw: str, allow: bool) -> Path:
    target = resolve_link(jail, raw, allow, must_exist=False)
    if os.path.lexists(target):
        raise FsError(409, "exists", "Something with that name already exists")
    try:
        os.mkdir(target)
    except FileNotFoundError as exc:
        raise FsError(404, "not_found", "Parent folder does not exist") from exc
    return target


def touch(jail: Jail, raw: str, allow: bool) -> Path:
    target = resolve_link(jail, raw, allow, must_exist=False)
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o666)
    except FileExistsError as exc:
        raise FsError(409, "exists", "Something with that name already exists") from exc
    except FileNotFoundError as exc:
        raise FsError(404, "not_found", "Parent folder does not exist") from exc
    os.close(fd)
    return target


def rename(jail: Jail, raw: str, allow: bool, new_name: str) -> tuple[Path, Path]:
    check_name(new_name)
    src = resolve_link(jail, raw, allow)
    dest = src.parent / new_name
    check_dest(jail, dest, allow)
    if dest == src:
        return src, dest
    if os.path.lexists(dest):
        raise FsError(409, "exists", "Something with that name already exists")
    os.rename(src, dest)
    return src, dest


def chmod(jail: Jail, raw: str, allow: bool, mode: str) -> Path:
    if not re.fullmatch(r"[0-7]{3,4}", mode) or int(mode, 8) & 0o7000:
        raise FsError(400, "invalid_path", "Mode must be 3 octal digits, e.g. 644")
    p = resolve_link(jail, raw, allow)
    if st.S_ISLNK(os.lstat(p).st_mode):
        raise FsError(400, "unsupported", "Refusing to change the mode through a symlink")
    os.chmod(p, int(mode, 8))
    return p


# ------------------------------------------------------------------ move / copy


def _is_inside(child: Path, parent: Path) -> bool:
    return child == parent or child.is_relative_to(parent)


def transfer(
    jail: Jail, sources: list[str], dest_dir: str, allow: bool, conflict: str, *, copy: bool
) -> list[tuple[Path, Path]]:
    if conflict not in CONFLICTS:
        raise FsError(400, "unsupported", "conflict must be rename, overwrite or error")
    if not sources:
        raise FsError(400, "invalid_path", "No sources given")
    ddir = resolve(jail, dest_dir, allow, must_exist=True)
    if not ddir.is_dir():
        raise FsError(400, "invalid_path", "Destination is not a folder")
    srcs = [resolve_link(jail, s, allow) for s in sources]
    done: list[tuple[Path, Path]] = []
    for src in srcs:
        is_dir = os.path.isdir(src) and not os.path.islink(src)
        if is_dir and _is_inside(ddir, src):
            raise FsError(400, "invalid_path", "Cannot put a folder inside itself")
        dest = ddir / src.name
        check_dest(jail, dest, allow)
        if dest == src and not copy:
            done.append((src, dest))
            continue
        if os.path.lexists(dest):
            if conflict == "error":
                raise FsError(409, "exists", f"'{dest.name}' already exists")
            if conflict == "rename" or dest == src:
                dest = unique_name(ddir, src.name)
            else:  # overwrite
                if os.path.isdir(dest) and not os.path.islink(dest) or is_dir:
                    raise FsError(409, "exists", f"'{dest.name}' already exists and cannot be overwritten")
        if copy:
            _copy_one(src, dest, is_dir)
        else:
            _move_one(src, dest)
        done.append((src, dest))
    return done


def _copy_one(src: Path, dest: Path, is_dir: bool) -> None:
    if is_dir:
        shutil.copytree(src, dest, symlinks=True)
        return
    if os.path.lexists(dest):  # overwrite: copy next to it, then replace atomically
        fd, tmp = tempfile.mkstemp(prefix=f".{dest.name}.", suffix=".kiln-tmp", dir=dest.parent)
        os.close(fd)
        try:
            shutil.copy2(src, tmp, follow_symlinks=False)
            os.replace(tmp, dest)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    else:
        shutil.copy2(src, dest, follow_symlinks=False)


def _move_one(src: Path, dest: Path) -> None:
    try:
        os.rename(src, dest)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        shutil.move(src, dest)


# ------------------------------------------------------------------ delete / checksum / usage


def remove_tree(p: Path) -> None:
    if os.path.islink(p) or not os.path.isdir(p):
        os.unlink(p)
    else:
        shutil.rmtree(p)


def delete_paths(jail: Jail, paths: list[str], allow: bool) -> list[Path]:
    targets = [resolve_link(jail, p, allow) for p in paths]
    for t in targets:
        remove_tree(t)
    return targets


def checksum(jail: Jail, raw: str, allow: bool, algo: str) -> dict[str, str]:
    if algo not in ("sha256", "sha1", "md5"):
        raise FsError(400, "unsupported", "algo must be sha256, sha1 or md5")
    real = resolve(jail, raw, allow, must_exist=True)
    if not real.is_file():
        raise FsError(400, "invalid_path", "Not a file")
    h = hashlib.new(algo, usedforsecurity=False)
    with open(real, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return {"algo": algo, "hex": h.hexdigest()}


def _mount_of(path: Path) -> tuple[str, str]:
    best = ("/", "unknown")
    try:
        with open("/proc/mounts", encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mnt = parts[1].replace("\\040", " ").replace("\\011", "\t")
                if (path == Path(mnt) or path.is_relative_to(mnt)) and len(mnt) >= len(best[0]):
                    best = (mnt, parts[2])
    except OSError:
        pass
    return best


def usage(jail: Jail) -> dict[str, Any]:
    v = os.statvfs(jail.root)
    mount, fstype = _mount_of(jail.root)
    return {
        "total": v.f_blocks * v.f_frsize,
        "used": (v.f_blocks - v.f_bfree) * v.f_frsize,
        "free": v.f_bavail * v.f_frsize,
        "fs_type": fstype,
        "mount": mount,
    }
