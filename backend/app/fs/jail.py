"""The single path-validation gate used by every file endpoint and every AI file tool.

resolve() returns a real, absolute path inside the jail root, or raises JailError.
It rejects: NUL/control/bidi characters, paths whose real location (after following
every symlink, including a dangling final one) is outside the root, and denylisted
locations unless explicitly allowed (e.g. after re-authentication).

Callers that then open the path for writing should still use O_NOFOLLOW on the final
component to close the check/use race window.
"""

from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

MAX_PATH_BYTES = 4096
_GLOB_CHARS = set("*?[")
# Bidi controls and invisible formatting chars used to disguise file names.
_SPOOF_CHARS = set("‎‏‪‫‬‭‮⁦⁧⁨⁩؜﻿")


class JailError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Resolved:
    path: Path
    denied: bool  # True only when allow_denied=True let a denylisted path through


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    out, i = [], 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
            continue
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
            continue
        out.append({"*": "[^/]*", "?": "[^/]"}.get(c, re.escape(c)))
        i += 1
    return re.compile("^" + "".join(out) + "$")


class Jail:
    def __init__(
        self,
        root: str | Path,
        denylist: list[str] | None = None,
        home: str | Path | None = None,
        max_read_bytes: int = 10 * 1024 * 1024,
    ) -> None:
        self.home = Path(home) if home is not None else Path.home()
        self.root = Path(os.path.realpath(self._expand(str(root))))
        if not self.root.is_dir():
            raise ValueError(f"Jail root is not a directory: {self.root}")
        self.max_read_bytes = max_read_bytes
        self._prefixes: list[Path] = []
        self._globs: list[re.Pattern[str]] = []
        for entry in denylist or []:
            expanded = self._expand(entry)
            if _GLOB_CHARS & set(expanded):
                if not expanded.startswith("/") and not expanded.startswith("**"):
                    expanded = f"{self.root}/{expanded}"
                self._globs.append(_glob_to_regex(expanded))
            else:
                self._prefixes.append(Path(os.path.realpath(expanded)))

    def _expand(self, p: str) -> str:
        if p == "~" or p.startswith("~/"):
            return str(self.home) + p[1:]
        return p

    @staticmethod
    def _validate_text(raw: str) -> None:
        if not isinstance(raw, str):
            raise JailError("invalid_path", "Path must be a string")
        if len(raw.encode("utf-8", "surrogatepass")) > MAX_PATH_BYTES:
            raise JailError("invalid_path", "Path is too long")
        for ch in raw:
            if ch == "\x00":
                raise JailError("invalid_path", "Path contains a NUL byte")
            if ch in _SPOOF_CHARS or unicodedata.category(ch) == "Cc":
                raise JailError("invalid_path", "Path contains control or direction-override characters")
            if unicodedata.category(ch) == "Cs":
                raise JailError("invalid_path", "Path contains invalid unicode")

    def is_denied(self, real: Path) -> bool:
        s = str(real)
        for prefix in self._prefixes:
            if real == prefix or real.is_relative_to(prefix):
                return True
        return any(g.match(s) for g in self._globs)

    def resolve(self, raw: str, *, allow_denied: bool = False, must_exist: bool = False) -> Resolved:
        self._validate_text(raw)
        expanded = self._expand(raw.strip() or ".")
        candidate = expanded if os.path.isabs(expanded) else os.path.join(self.root, expanded)
        lexical = Path(os.path.normpath(candidate))
        real = Path(os.path.realpath(candidate))  # follows every symlink, including a dangling last one
        if real != self.root and not real.is_relative_to(self.root):
            raise JailError("outside_jail", "That location is outside your home folder")
        if must_exist and not os.path.lexists(real):
            raise JailError("not_found", "No such file or folder")
        # Check both the real target and the path as written (a symlink *named* .env is still denied).
        denied = self.is_denied(real) or (lexical.is_relative_to(self.root) and self.is_denied(lexical))
        if denied and not allow_denied:
            raise JailError("denied", "That location is protected. Confirm your password to open it.")
        return Resolved(real, denied)

    def relative(self, real: Path) -> str:
        rel = real.relative_to(self.root)
        return "~" if str(rel) == "." else f"~/{rel}"

    def check_read_size(self, real: Path, limit: int | None = None) -> int:
        size = real.stat().st_size
        if size > (limit or self.max_read_bytes):
            raise JailError("too_large", f"File is larger than {(limit or self.max_read_bytes) // 1024} KiB")
        return size
