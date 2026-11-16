from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.fs.jail import Jail, JailError

DENY = ["~/.ssh", "~/.gnupg", "**/.env", "**/.env.*"]


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    (h / "docs").mkdir(parents=True)
    (h / "docs" / "a.txt").write_text("hi")
    (h / ".ssh").mkdir()
    (h / ".ssh" / "id_ed25519").write_text("KEY")
    (h / "proj").mkdir()
    (h / "proj" / ".env").write_text("SECRET=1")
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "x").write_text("x")
    return h


@pytest.fixture
def jail(home: Path) -> Jail:
    return Jail(home, DENY, home=home)


def code(jail: Jail, p: str, **kw: bool) -> str:
    with pytest.raises(JailError) as e:
        jail.resolve(p, **kw)
    return e.value.code


def test_inside_paths(jail: Jail, home: Path) -> None:
    assert jail.resolve("docs/a.txt").path == home / "docs" / "a.txt"
    assert jail.resolve("~/docs").path == home / "docs"
    assert jail.resolve(str(home / "docs")).path == home / "docs"
    assert jail.resolve("").path == home
    assert jail.resolve("~").path == home
    assert jail.resolve("docs/../docs/./a.txt").path == home / "docs" / "a.txt"
    assert jail.resolve("docs/new-file.txt").path == home / "docs" / "new-file.txt"  # not yet existing


@pytest.mark.parametrize(
    "p",
    [
        "../outside/x",
        "docs/../../outside",
        "/etc/passwd",
        "~/../outside",
        "/",
        "..",
        "docs/../../../../../../etc/shadow",
    ],
)
def test_traversal_rejected(jail: Jail, p: str) -> None:
    assert code(jail, p) == "outside_jail"


def test_prefix_sibling_is_outside(tmp_path: Path, jail: Jail) -> None:
    (tmp_path / "home2").mkdir()
    assert code(jail, str(tmp_path / "home2")) == "outside_jail"


def test_symlink_escapes(jail: Jail, home: Path, tmp_path: Path) -> None:
    os.symlink(tmp_path / "outside", home / "docs" / "link-dir")
    os.symlink(tmp_path / "outside" / "x", home / "docs" / "link-file")
    os.symlink(tmp_path / "outside" / "does-not-exist", home / "docs" / "dangling")
    os.symlink("/etc", home / "etc-link")
    assert code(jail, "docs/link-dir") == "outside_jail"
    assert code(jail, "docs/link-dir/x") == "outside_jail"
    assert code(jail, "docs/link-file") == "outside_jail"
    assert code(jail, "docs/dangling") == "outside_jail"  # writing through it would escape
    assert code(jail, "etc-link/passwd") == "outside_jail"


def test_symlink_loop(jail: Jail, home: Path) -> None:
    os.symlink(home / "loop-b", home / "loop-a")
    os.symlink(home / "loop-a", home / "loop-b")
    with pytest.raises((JailError, OSError)):
        r = jail.resolve("loop-a/x", must_exist=True)
        raise AssertionError(r)


def test_internal_symlink_ok(jail: Jail, home: Path) -> None:
    os.symlink(home / "docs", home / "docs-link")
    assert jail.resolve("docs-link/a.txt").path == home / "docs" / "a.txt"


@pytest.mark.parametrize("p", ["docs/a.txt\x00.png", "docs/\x07bell", "docs/evil‮txt.exe", "docs/⁦x", "docs/﻿bom"])
def test_bad_characters(jail: Jail, p: str) -> None:
    assert code(jail, p) == "invalid_path"


def test_unicode_lookalikes_stay_inside(jail: Jail, home: Path) -> None:
    # Fullwidth dots/slashes are ordinary filename characters on Linux, not traversal.
    r = jail.resolve("．．／etc")
    assert r.path.parent == home


def test_too_long(jail: Jail) -> None:
    assert code(jail, "a/" * 3000) == "invalid_path"


def test_non_string(jail: Jail) -> None:
    with pytest.raises(JailError):
        jail.resolve(b"docs")  # type: ignore[arg-type]


def test_denylist(jail: Jail, home: Path) -> None:
    assert code(jail, "~/.ssh") == "denied"
    assert code(jail, "~/.ssh/id_ed25519") == "denied"
    assert code(jail, "proj/.env") == "denied"
    assert code(jail, ".env.local") == "denied"
    r = jail.resolve("~/.ssh/id_ed25519", allow_denied=True)
    assert r.denied and r.path == home / ".ssh" / "id_ed25519"
    assert not jail.resolve("docs/a.txt").denied


def test_symlink_into_denylist(jail: Jail, home: Path) -> None:
    os.symlink(home / ".ssh" / "id_ed25519", home / "docs" / "innocent.txt")
    assert code(jail, "docs/innocent.txt") == "denied"


def test_symlink_named_env_is_denied(jail: Jail, home: Path) -> None:
    os.symlink(home / "docs" / "a.txt", home / "docs" / ".env")
    assert code(jail, "docs/.env") == "denied"


def test_must_exist(jail: Jail) -> None:
    assert code(jail, "docs/missing", must_exist=True) == "not_found"


def test_size_limit(home: Path) -> None:
    j = Jail(home, [], home=home, max_read_bytes=1)
    with pytest.raises(JailError):
        j.check_read_size(home / "docs" / "a.txt")
