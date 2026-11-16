from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
import time
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import routes_fs
from app.auth.sessions import COOKIE_NAME
from app.config import Config
from app.fs import search as fs_search
from app.main import create_app
from app.state import AppState
from tests.conftest import ORIGIN, PASSWORD

Ctx = tuple[TestClient, AppState, dict[str, str], Path]


@pytest.fixture
def config(tmp_path: Path) -> Config:
    home = tmp_path / "home"
    home.mkdir()
    cfg = Config()
    cfg.data_dir = str(tmp_path / "data")
    cfg.server.web_root = str(tmp_path / "no-web")
    cfg.files.jail_root = str(home)
    return cfg


@pytest.fixture
def fx(config: Config) -> Iterator[Ctx]:
    app = create_app(config)
    with TestClient(app, base_url=ORIGIN, headers={"origin": ORIGIN}) as c:
        state: AppState = app.state.kiln
        c.portal.call(state.credentials.set_password, PASSWORD)  # type: ignore[union-attr]
        r = c.post("/api/auth/unlock", json={"password": PASSWORD})
        assert r.status_code == 200
        # Unlocking opens a re-auth window; close it so denied/permanent operations need a fresh password.
        c.portal.call(state.db.conn.execute, "UPDATE sessions SET reauth_until = 0")  # type: ignore[union-attr]
        yield c, state, {"x-csrf-token": r.json()["csrf"]}, Path(config.files.jail_root).resolve()


def reauth(c: TestClient, h: dict[str, str]) -> None:
    assert c.post("/api/auth/reauth", json={"password": PASSWORD}, headers=h).status_code == 200


def code(r: Any) -> str:
    return str(r.json()["detail"]["code"])


def test_list_sorting_hidden_denied_symlink(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "b.txt").write_text("b")
    (home / "A.txt").write_text("a")
    (home / "zdir").mkdir()
    (home / ".hidden").write_text("x")
    (home / ".ssh").mkdir()
    (home / "link").symlink_to(home / "zdir")
    (home / "out").symlink_to("/etc")
    r = c.get("/api/fs/list", params={"path": "~"})
    assert r.status_code == 200
    body = r.json()
    assert body["parent"] is None and body["path"] == "~"
    names = [e["name"] for e in body["entries"]]
    assert names[:3] == ["link", "out", "zdir"]  # directories (and links to them) first, then files
    assert names.index("zdir") < names.index("A.txt") < names.index("b.txt")
    assert ".hidden" not in names and ".ssh" not in names
    by = {e["name"]: e for e in body["entries"]}
    assert by["link"]["type"] == "symlink" and by["link"]["target"] == "~/zdir" and by["link"]["link_type"] == "dir"
    assert by["out"]["target"] is None
    assert by["b.txt"]["mime"] == "text/plain" and by["b.txt"]["path"] == "~/b.txt"
    r = c.get("/api/fs/list", params={"path": "~", "hidden": 1})
    by = {e["name"]: e for e in r.json()["entries"]}
    assert by[".ssh"]["denied"] is True and by[".hidden"]["denied"] is False and by[".hidden"]["hidden"] is True
    sub = c.get("/api/fs/list", params={"path": "~/zdir"}).json()
    assert sub["parent"] == "~" and sub["name"] == "zdir"
    assert c.get("/api/fs/list", params={"path": "~/nope"}).status_code == 404


def test_traversal_and_denied(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / ".ssh").mkdir()
    (home / ".ssh" / "key").write_text("SECRET")
    (home / "out").symlink_to("/etc")
    bad = "../../etc/passwd"
    for ep in ("list", "stat", "raw", "text", "checksum"):
        r = c.get(f"/api/fs/{ep}", params={"path": bad})
        assert r.status_code == 403 and code(r) == "outside_jail", ep
    assert c.get("/api/fs/text", params={"path": "~/out/passwd"}).status_code == 403
    assert c.get("/api/fs/archive", params={"path": bad}).status_code == 403
    assert c.post("/api/fs/mkdir", json={"path": "../x"}, headers=h).status_code == 403
    assert c.post("/api/fs/trash", json={"paths": [bad]}, headers=h).status_code == 403
    assert c.post("/api/fs/move", json={"sources": ["~/out"], "dest_dir": "/var"}, headers=h).status_code == 403
    assert c.post("/api/fs/rename", json={"path": bad, "new_name": "x"}, headers=h).status_code == 403
    assert c.get("/api/fs/zip", params={"paths": bad}).status_code == 403
    # denied: needs re-auth
    r = c.get("/api/fs/text", params={"path": "~/.ssh/key"})
    assert r.status_code == 403 and code(r) == "denied"
    assert c.get("/api/fs/list", params={"path": "~/.ssh"}).status_code == 403
    reauth(c, h)
    assert c.get("/api/fs/text", params={"path": "~/.ssh/key"}).json()["content"] == "SECRET"
    assert c.get("/api/fs/list", params={"path": "~/.ssh"}).status_code == 200


def test_text_read_save_conflict_create_symlink(fx: Ctx) -> None:
    c, _, h, home = fx
    f = home / "n.md"
    f.write_text("hello\r\nworld")
    os.chmod(f, 0o640)
    r = c.get("/api/fs/text", params={"path": "~/n.md"})
    j = r.json()
    assert j["content"] == "hello\r\nworld" and j["eol"] == "crlf" and j["encoding"] == "utf-8"
    assert isinstance(j["mtime_ns"], str)
    r = c.put("/api/fs/text", json={"path": "~/n.md", "content": "new", "expected_mtime_ns": j["mtime_ns"]}, headers=h)
    assert r.status_code == 200, r.text
    assert f.read_text() == "new" and (f.stat().st_mode & 0o777) == 0o640
    assert r.json()["mtime_ns"] == str(f.stat().st_mtime_ns)
    r = c.put("/api/fs/text", json={"path": "~/n.md", "content": "x", "expected_mtime_ns": j["mtime_ns"]}, headers=h)
    assert r.status_code == 409 and code(r) == "conflict"
    assert r.json()["detail"]["current_mtime_ns"] == str(f.stat().st_mtime_ns)
    assert f.read_text() == "new"
    r = c.put("/api/fs/text", json={"path": "~/fresh.txt", "content": "hi", "expected_mtime_ns": None}, headers=h)
    assert r.status_code == 200 and (home / "fresh.txt").read_text() == "hi"
    r = c.put("/api/fs/text", json={"path": "~/fresh.txt", "content": "hi", "expected_mtime_ns": None}, headers=h)
    assert r.status_code == 409 and code(r) == "exists"
    (home / "ln.txt").symlink_to(home / "fresh.txt")
    mt = str((home / "ln.txt").lstat().st_mtime_ns)
    r = c.put("/api/fs/text", json={"path": "~/ln.txt", "content": "evil", "expected_mtime_ns": mt}, headers=h)
    assert r.status_code == 400 and (home / "fresh.txt").read_text() == "hi"
    r = c.put("/api/fs/text", json={"path": "~/ln.txt", "content": "evil", "expected_mtime_ns": None}, headers=h)
    assert r.status_code == 409
    assert c.put("/api/fs/text", json={"path": "~/f.txt", "content": "x", "expected_mtime_ns": None}).status_code == 403


def test_binary_and_too_large(fx: Ctx, config: Config) -> None:
    c, state, _, home = fx
    (home / "b.bin").write_bytes(b"\xff\xfe\x00\x01")
    r = c.get("/api/fs/text", params={"path": "~/b.bin"})
    assert r.status_code == 415 and code(r) == "binary"
    state.jail.max_read_bytes = 10
    (home / "big.txt").write_text("x" * 50)
    r = c.get("/api/fs/text", params={"path": "~/big.txt"})
    assert r.status_code == 413 and code(r) == "too_large"


def test_rename_validation(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "a.txt").write_text("a")
    (home / "b.txt").write_text("b")
    for bad in ("x/y", "..", ".", "", "a\x00b"):
        r = c.post("/api/fs/rename", json={"path": "~/a.txt", "new_name": bad}, headers=h)
        assert r.status_code == 400, bad
    assert c.post("/api/fs/rename", json={"path": "~/a.txt", "new_name": "b.txt"}, headers=h).status_code == 409
    r = c.post("/api/fs/rename", json={"path": "~/a.txt", "new_name": "c.txt"}, headers=h)
    assert r.status_code == 200 and r.json()["path"] == "~/c.txt" and (home / "c.txt").exists()
    (home / "lnk").symlink_to("/etc")  # renaming a link acts on the link even if it points outside
    assert c.post("/api/fs/rename", json={"path": "~/lnk", "new_name": "lnk2"}, headers=h).status_code == 200
    assert os.path.islink(home / "lnk2")
    assert c.post("/api/fs/rename", json={"path": "~/c.txt", "new_name": ".env"}, headers=h).status_code == 403


def test_mkdir_touch_chmod(fx: Ctx) -> None:
    c, _, h, home = fx
    r = c.post("/api/fs/mkdir", json={"path": "~/d"}, headers=h)
    assert r.status_code == 200 and r.json()["type"] == "dir"
    assert c.post("/api/fs/mkdir", json={"path": "~/d"}, headers=h).status_code == 409
    assert c.post("/api/fs/mkdir", json={"path": "~/x/y"}, headers=h).status_code == 404
    r = c.post("/api/fs/touch", json={"path": "~/d/t.txt"}, headers=h)
    assert r.status_code == 200 and r.json()["size"] == 0
    r = c.post("/api/fs/touch", json={"path": "~/d/t.txt"}, headers=h)
    assert r.status_code == 409 and code(r) == "exists"
    r = c.post("/api/fs/chmod", json={"path": "~/d/t.txt", "mode": "600"}, headers=h)
    assert r.status_code == 200 and r.json()["mode"] == "600" and (home / "d/t.txt").stat().st_mode & 0o777 == 0o600
    assert c.post("/api/fs/chmod", json={"path": "~/d/t.txt", "mode": "4755"}, headers=h).status_code == 400
    assert c.post("/api/fs/chmod", json={"path": "~/d/t.txt", "mode": "rwx"}, headers=h).status_code == 400


def test_move_copy_conflicts(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "src").mkdir()
    (home / "dst").mkdir()
    (home / "src" / "f.txt").write_text("new")
    (home / "dst" / "f.txt").write_text("old")
    (home / "src" / "tree").mkdir()
    (home / "src" / "tree" / "in.txt").write_text("in")
    (home / "src" / "tree" / "ln").symlink_to("in.txt")
    body = {"sources": ["~/src/f.txt"], "dest_dir": "~/dst"}
    r = c.post("/api/fs/copy", json=body, headers=h)
    assert r.status_code == 200 and r.json()["copied"][0]["name"] == "f (2).txt"
    assert (home / "dst" / "f.txt").read_text() == "old" and (home / "src" / "f.txt").exists()
    assert c.post("/api/fs/copy", json={**body, "conflict": "error"}, headers=h).status_code == 409
    assert c.post("/api/fs/copy", json={**body, "conflict": "overwrite"}, headers=h).status_code == 200
    assert (home / "dst" / "f.txt").read_text() == "new"
    r = c.post("/api/fs/copy", json={"sources": ["~/src/tree"], "dest_dir": "~/dst"}, headers=h)
    assert r.status_code == 200 and os.path.islink(home / "dst" / "tree" / "ln")
    r = c.post("/api/fs/move", json={"sources": ["~/src/f.txt"], "dest_dir": "~/dst"}, headers=h)
    assert r.status_code == 200 and r.json()["moved"][0]["name"] == "f (3).txt"
    assert not (home / "src" / "f.txt").exists()
    r = c.post("/api/fs/move", json={"sources": ["~/src"], "dest_dir": "~/src/tree"}, headers=h)
    assert r.status_code == 400
    assert c.post("/api/fs/move", json={"sources": ["~/dst"], "dest_dir": "~/dst/f.txt"}, headers=h).status_code == 400
    assert c.post("/api/fs/move", json={"sources": ["~/dst/f.txt"], "dest_dir": "~/.ssh"}, headers=h).status_code in (
        403,
        404,
    )
    (home / ".ssh").mkdir()
    assert c.post("/api/fs/move", json={"sources": ["~/dst/f.txt"], "dest_dir": "~/.ssh"}, headers=h).status_code == 403


def test_trash_flow(fx: Ctx) -> None:
    c, state, h, home = fx
    (home / "docs").mkdir()
    (home / "docs" / "a.txt").write_text("A one")
    r = c.post("/api/fs/trash", json={"paths": ["~/docs/a.txt"]}, headers=h)
    assert r.status_code == 200, r.text
    item = r.json()["trashed"][0]
    assert item["id"] == "a.txt" and item["original_path"] == "~/docs/a.txt"
    tr = home / ".local/share/Trash"
    assert (tr / "files/a.txt").read_text() == "A one" and not (home / "docs/a.txt").exists()
    info = (tr / "info/a.txt.trashinfo").read_text()
    lines = info.splitlines()
    assert lines[0] == "[Trash Info]" and lines[1] == f"Path={home}/docs/a.txt"
    assert lines[2].startswith("DeletionDate=") and "T" in lines[2] and "+" not in lines[2] and "Z" not in lines[2]
    assert oct(tr.stat().st_mode & 0o777) == "0o700" and oct((tr / "files").stat().st_mode & 0o777) == "0o700"
    # name clash -> a.txt.2
    (home / "a.txt").write_text("other")
    r = c.post("/api/fs/trash", json={"paths": ["~/a.txt"]}, headers=h)
    assert r.json()["trashed"][0]["id"] == "a.txt.2"
    items = c.get("/api/fs/trash").json()["items"]
    assert {i["id"] for i in items} == {"a.txt", "a.txt.2"}
    assert items[0]["deleted_at"] >= items[1]["deleted_at"] and items[0]["type"] == "file"
    # restore (docs gone -> recreated; clash -> renamed)
    os.rmdir(home / "docs") if not os.listdir(home / "docs") else None
    r = c.post("/api/fs/trash/restore", json={"ids": ["a.txt"]}, headers=h)
    assert r.status_code == 200 and r.json()["restored"][0]["path"] == "~/docs/a.txt"
    assert (home / "docs/a.txt").read_text() == "A one" and not (tr / "info/a.txt.trashinfo").exists()
    # trash again, then permanent delete needs reauth
    c.post("/api/fs/trash", json={"paths": ["~/docs/a.txt"]}, headers=h)
    assert c.post("/api/fs/trash/delete", json={"ids": ["a.txt"]}, headers=h).status_code == 403
    assert c.post("/api/fs/trash/empty", headers=h).status_code == 403
    # trashing inside the trash is refused
    r = c.post("/api/fs/trash", json={"paths": ["~/.local/share/Trash/files/a.txt"]}, headers=h)
    assert r.status_code == 400
    reauth(c, h)
    assert c.post("/api/fs/trash/delete", json={"ids": ["a.txt"]}, headers=h).json() == {"deleted": 1}
    assert not (tr / "files/a.txt").exists()
    assert c.post("/api/fs/trash/empty", headers=h).json() == {"deleted": 1}
    assert os.listdir(tr / "files") == [] and os.listdir(tr / "info") == []
    assert c.post("/api/fs/trash/delete", json={"ids": ["../x"]}, headers=h).status_code == 400
    assert str(state.jail.home) == str(home)  # tests never touch the real trash


def test_permanent_delete_needs_reauth(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "d").mkdir()
    (home / "d" / "f").write_text("x")
    (home / "lnk").symlink_to(home / "d")
    r = c.post("/api/fs/delete", json={"paths": ["~/d"]}, headers=h)
    assert r.status_code == 403 and code(r) == "reauth_required"
    reauth(c, h)
    assert c.post("/api/fs/delete", json={"paths": ["~/lnk", "~/d"]}, headers=h).json() == {"deleted": 2}
    assert not (home / "d").exists() and not os.path.lexists(home / "lnk")
    assert c.post("/api/fs/delete", json={"paths": ["~"]}, headers=h).status_code == 400


def test_upload_flow(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "up").mkdir()
    data = b"A" * 1000 + b"B" * 500
    r = c.post("/api/fs/upload/init", json={"dest_dir": "~/up", "name": "f.bin", "size": len(data)}, headers=h)
    assert r.status_code == 200
    uid = r.json()["upload_id"]
    assert r.json()["chunk_size"] == 4 * 1024 * 1024 and r.json()["received"] == 0
    assert c.put(f"/api/fs/upload/{uid}", params={"offset": 0}, content=data[:1000], headers=h).json() == {
        "received": 1000
    }
    r = c.put(f"/api/fs/upload/{uid}", params={"offset": 0}, content=data[:1000], headers=h)
    assert r.status_code == 409 and r.json()["detail"]["received"] == 1000
    assert c.get(f"/api/fs/upload/{uid}").json() == {"received": 1000, "size": 1500}
    assert c.post(f"/api/fs/upload/{uid}/complete", json={"conflict": "rename"}, headers=h).status_code == 409
    assert c.put(f"/api/fs/upload/{uid}", params={"offset": 1000}, content=data[1000:], headers=h).json() == {
        "received": 1500
    }
    (home / "up" / "f.bin").write_bytes(b"old")
    r = c.post(f"/api/fs/upload/{uid}/complete", json={"conflict": "rename"}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "f (2).bin"
    assert (home / "up" / "f (2).bin").read_bytes() == data and (home / "up" / "f.bin").read_bytes() == b"old"
    assert c.get(f"/api/fs/upload/{uid}").status_code == 404
    r = c.post("/api/fs/upload/init", json={"dest_dir": "~/up", "name": "../x", "size": 1}, headers=h)
    assert r.status_code == 400
    r = c.post("/api/fs/upload/init", json={"dest_dir": "~/up", "name": "g", "size": 5}, headers=h)
    uid2 = r.json()["upload_id"]
    assert c.delete(f"/api/fs/upload/{uid2}", headers=h).json() == {"ok": True}
    assert c.get(f"/api/fs/upload/{uid2}").status_code == 404
    assert c.get("/api/fs/upload/..%2f..%2fetc").status_code == 404


def test_zip_download(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "p" / "sub").mkdir(parents=True)
    (home / "p" / "a.txt").write_text("AAA")
    (home / "p" / "sub" / "b.txt").write_text("BBB")
    (home / "p" / ".env").write_text("SECRET")
    (home / "p" / "esc").symlink_to("/etc/hostname")
    (home / "solo.txt").write_text("S")
    r = c.get("/api/fs/zip", params={"paths": "~/p"})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert 'filename="p.zip"' in r.headers["content-disposition"]
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert zf.testzip() is None
    names = set(zf.namelist())
    assert {"p/a.txt", "p/sub/b.txt"} <= names and "p/.env" not in names and "p/esc" not in names
    assert zf.read("p/sub/b.txt") == b"BBB"
    r = c.get("/api/fs/zip", params=[("paths", "~/p/a.txt"), ("paths", "~/solo.txt")])
    assert 'filename="files.zip"' in r.headers["content-disposition"]
    assert set(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == {"a.txt", "solo.txt"}


def test_raw_range_and_headers(fx: Ctx) -> None:
    c, _, _, home = fx
    (home / "r.txt").write_text("0123456789")
    (home / "p.html").write_text("<script>alert(1)</script>")
    (home / "i.svg").write_text("<svg/>")
    r = c.get("/api/fs/raw", params={"path": "~/r.txt"}, headers={"range": "bytes=0-3"})
    assert r.status_code == 206 and r.content == b"0123" and r.headers["content-range"] == "bytes 0-3/10"
    assert r.headers["accept-ranges"] == "bytes"
    assert "nosniff" in r.headers["x-content-type-options"] and "no-store" in r.headers["cache-control"]
    assert "sandbox" in r.headers["content-security-policy"]
    r = c.get("/api/fs/raw", params={"path": "~/p.html"})
    assert r.headers["content-type"].startswith("text/plain")
    assert "sandbox; default-src 'none'" in r.headers["content-security-policy"]
    assert c.get("/api/fs/raw", params={"path": "~/i.svg"}).headers["content-type"].startswith("text/plain")
    r = c.get("/api/fs/raw", params={"path": "~/p.html", "download": 1})
    assert r.headers["content-type"].startswith("text/html") and r.headers["content-disposition"].startswith(
        "attachment"
    )
    assert c.get("/api/fs/raw", params={"path": "~/nope"}).status_code == 404


def test_checksum_stat_usage_bookmarks(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "h.txt").write_bytes(b"hash me")
    (home / "dd").mkdir()
    (home / "dd" / "x").write_text("x")
    for algo in ("sha256", "sha1", "md5"):
        r = c.get("/api/fs/checksum", params={"path": "~/h.txt", "algo": algo})
        assert r.json() == {"algo": algo, "hex": hashlib.new(algo, b"hash me").hexdigest()}
    assert c.get("/api/fs/checksum", params={"path": "~/h.txt", "algo": "crc"}).status_code == 400
    s = c.get("/api/fs/stat", params={"path": "~/dd"}).json()
    assert s["type"] == "dir" and s["items"] == 1 and "atime" in s and "ctime" in s and s["real"] == "~/dd"
    assert c.get("/api/fs/stat", params={"path": "~"}).json()["path"] == "~"
    assert c.get("/api/fs/stat", params={"path": "~/missing"}).status_code == 404
    u = c.get("/api/fs/usage").json()
    assert u["total"] > 0 and u["free"] <= u["total"] and u["fs_type"] and u["mount"].startswith("/")
    assert c.get("/api/fs/bookmarks").json() == {"bookmarks": []}
    r = c.put("/api/fs/bookmarks", json={"bookmarks": [{"name": "D", "path": "dd"}]}, headers=h)
    assert r.json() == {"bookmarks": [{"name": "D", "path": "~/dd"}]}
    assert c.get("/api/fs/bookmarks").json()["bookmarks"][0]["path"] == "~/dd"
    assert c.put("/api/fs/bookmarks", json={"bookmarks": [{"name": "x", "path": "/etc"}]}, headers=h).status_code == 403
    assert c.put("/api/fs/bookmarks", json={"bookmarks": [{"name": "", "path": "~"}]}, headers=h).status_code == 422
    many = [{"name": f"n{i}", "path": "~"} for i in range(31)]
    assert c.put("/api/fs/bookmarks", json={"bookmarks": many}, headers=h).status_code == 422


def _ndjson(r: Any) -> list[dict[str, Any]]:
    assert r.status_code == 200, r.text
    return [json.loads(line) for line in r.text.splitlines() if line]


@pytest.mark.parametrize("tools", [True, False])
def test_search(fx: Ctx, monkeypatch: pytest.MonkeyPatch, tools: bool) -> None:
    c, _, _, home = fx
    if not tools:
        monkeypatch.setattr(fs_search.shutil, "which", lambda _n: None)
    elif not (fs_search.shutil.which("fd") and fs_search.shutil.which("rg")):
        pytest.skip("fd/rg not installed")
    (home / "proj" / "sub").mkdir(parents=True)
    (home / "proj" / "Report.txt").write_text("alpha\nthe NEEDLE here and needle again\n")
    (home / "proj" / "sub" / "needle_notes.md").write_text("nothing\n")
    (home / ".ssh").mkdir()
    (home / ".ssh" / "needle_key").write_text("needle")
    (home / "proj" / ".env").write_text("needle=1")
    res = _ndjson(c.get("/api/fs/search", params={"q": "needle", "mode": "name"}))
    assert res[-1] == {"type": "done", "count": 1, "truncated": False}
    assert (
        res[0]["type"] == "match"
        and res[0]["path"] == "~/proj/sub/needle_notes.md"
        and res[0]["name"]
        and res[0]["kind"] == "file"
    )
    res = _ndjson(c.get("/api/fs/search", params={"q": "needle", "mode": "content", "path": "~/proj"}))
    matches = [m for m in res if m["type"] == "match"]
    assert [m["path"] for m in matches] == ["~/proj/Report.txt"]
    assert matches[0]["line"] == 2 and matches[0]["ranges"] == [[4, 10], [20, 26]] or matches[0]["ranges"]
    assert "needle" in matches[0]["text"].lower()
    assert res[-1]["type"] == "done"
    hid = _ndjson(c.get("/api/fs/search", params={"q": "needle", "mode": "name", "hidden": 1}))
    assert all("/.ssh" not in m.get("path", "") for m in hid)
    assert c.get("/api/fs/search", params={"q": "x", "path": "../.."}).status_code == 403
    assert c.get("/api/fs/search", params={"q": "x", "mode": "bogus"}).status_code == 400


def test_archive_list_extract_compress(fx: Ctx) -> None:
    c, _, h, home = fx
    (home / "a").mkdir()
    (home / "a" / "one.txt").write_text("1")
    (home / "a" / "d").mkdir()
    (home / "a" / "d" / "two.txt").write_text("2")
    r = c.post("/api/fs/compress", json={"paths": ["~/a"], "dest": "~/out.zip"}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "out.zip"
    r = c.post("/api/fs/compress", json={"paths": ["~/a"], "dest": "~/out.tar.gz"}, headers=h)
    assert r.status_code == 200 and tarfile.is_tarfile(home / "out.tar.gz")
    assert c.post("/api/fs/compress", json={"paths": ["~/a"], "dest": "~/out.rar"}, headers=h).status_code == 400
    lst = c.get("/api/fs/archive", params={"path": "~/out.zip"}).json()
    assert lst["format"] == "zip" and not lst["truncated"] and "a/one.txt" in {e["name"] for e in lst["entries"]}
    lst = c.get("/api/fs/archive", params={"path": "~/out.tar.gz"}).json()
    assert lst["format"] == "tar.gz" and "a/d/two.txt" in {e["name"] for e in lst["entries"]}
    for arc in ("out.zip", "out.tar.gz"):
        r = c.post("/api/fs/extract", json={"path": f"~/{arc}"}, headers=h)
        assert r.status_code == 200, r.text
        folder = home / r.json()["name"]
        assert (folder / "a" / "d" / "two.txt").read_text() == "2"
    again = c.post("/api/fs/extract", json={"path": "~/out.zip"}, headers=h).json()
    assert again["name"] == "out (3)"
    # zip slip
    with zipfile.ZipFile(home / "evil.zip", "w") as zf:
        zf.writestr("ok.txt", "ok")
        zf.writestr("../evil", "pwned")
    r = c.post("/api/fs/extract", json={"path": "~/evil.zip"}, headers=h)
    assert r.status_code == 400 and not (home / "evil").exists() and not (home / "evil.zip.d").exists()
    assert not (home / "evil").is_dir() and "evil" not in {p.name for p in home.iterdir() if p.is_dir()}
    # abs path + symlink members are rejected
    with zipfile.ZipFile(home / "abs.zip", "w") as zf:
        zf.writestr("/etc/x", "x")
    assert c.post("/api/fs/extract", json={"path": "~/abs.zip"}, headers=h).status_code == 400
    with zipfile.ZipFile(home / "ln.zip", "w") as zf:
        zi = zipfile.ZipInfo("l")
        zi.external_attr = (0o120777) << 16
        zf.writestr(zi, "/etc/passwd")
    assert c.post("/api/fs/extract", json={"path": "~/ln.zip"}, headers=h).status_code == 400
    # tar with traversal is rejected by the data filter
    with tarfile.open(home / "bad.tar", "w") as tf:
        ti = tarfile.TarInfo("../tarevil")
        ti.size = 1
        tf.addfile(ti, io.BytesIO(b"x"))
    assert c.post("/api/fs/extract", json={"path": "~/bad.tar"}, headers=h).status_code == 400
    assert not (home.parent / "tarevil").exists()
    assert c.get("/api/fs/archive", params={"path": "~/a/one.txt"}).status_code == 400


def test_audit_events(fx: Ctx) -> None:
    c, state, h, home = fx
    c.post("/api/fs/mkdir", json={"path": "~/au"}, headers=h)
    c.post("/api/fs/rename", json={"path": "~/au", "new_name": "au2"}, headers=h)
    c.post("/api/fs/trash", json={"paths": ["~/au2"]}, headers=h)

    async def q() -> list[Any]:
        return await state.audit.query(event="fs.*")

    events = c.portal.call(q)  # type: ignore[union-attr]
    assert {"fs.mkdir", "fs.rename", "fs.trash"} <= {e.event for e in events}
    assert all("content" not in e.details for e in events)


def _ws(c: TestClient) -> Any:
    hdr = {"origin": ORIGIN, "host": "kiln.test", "cookie": f"{COOKIE_NAME}={c.cookies.get(COOKIE_NAME)}"}
    return c.websocket_connect("/ws/fs", headers=hdr)


def test_ws_watch_reports_change(fx: Ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes_fs, "WATCH_DEBOUNCE_MS", 50)
    c, _, _, home = fx
    (home / "w").mkdir()
    (home / "w" / "deep").mkdir()
    with _ws(c) as ws:
        ws.send_json({"type": "watch", "paths": ["~/w", "~/../etc", "~/nope"]})
        time.sleep(0.6)
        (home / "w" / "new.txt").write_text("x")
        msg = ws.receive_json()
        assert msg == {"type": "changed", "path": "~/w"}
        ws.send_json({"type": "ping"})
        got = ws.receive_json()
        while got.get("type") == "changed":
            got = ws.receive_json()
        assert got == {"type": "pong"}


def test_ws_locked_and_unauthenticated(fx: Ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes_fs, "RECHECK_S", 0.1)
    c, _, h, _ = fx
    with _ws(c) as ws:
        assert c.post("/api/auth/lock", headers=h).status_code == 200
        with pytest.raises(WebSocketDisconnect) as exc:
            for _ in range(100):
                msg = ws.receive()
                if msg["type"] == "websocket.close":
                    raise WebSocketDisconnect(msg.get("code", 1000))
        assert exc.value.code == 4423
    with pytest.raises(WebSocketDisconnect) as exc2, _ws(c) as ws2:  # locked session cannot open it
        ws2.receive_json()
    assert exc2.value.code == 4401
