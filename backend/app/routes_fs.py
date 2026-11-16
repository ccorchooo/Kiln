"""Filesystem REST API (/api/fs/*) and the directory watcher WebSocket (/ws/fs). Contract: docs/phase5-fs-api.md."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from watchfiles import awatch

from app.auth.deps import RecentAuthDep, SessionDep, StateDep, client_ip, websocket_session
from app.auth.sessions import Session
from app.fs import archives, ops, search, trash, uploads
from app.fs.errors import FsError, from_jail
from app.fs.jail import JailError
from app.fs.threadgen import aiter_thread
from app.state import AppState

router = APIRouter()

RECHECK_S = 2.0
WATCH_DEBOUNCE_MS = 300
MAX_WATCH = 8
MAX_BOOKMARKS = 30
BOOKMARKS_KEY = "fs.bookmarks"
_TEXTY_AS_PLAIN = {
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/xml",
    "application/xml",
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
}


def install_error_handlers(app: FastAPI) -> None:
    async def fs_error(_: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, FsError)
        return JSONResponse({"detail": exc.detail()}, status_code=exc.status)

    async def jail_error(_: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, JailError)
        e = from_jail(exc)
        return JSONResponse({"detail": e.detail()}, status_code=e.status)

    app.add_exception_handler(FsError, fs_error)
    app.add_exception_handler(JailError, jail_error)


def _allow(sess: Session) -> bool:
    return sess.recently_authenticated()


async def _audit(state: AppState, request: Request, sess: Session, event: str, **details: Any) -> None:
    await state.audit.record(event, ip=client_ip(request), session_id=sess.id, **details)


def _rel(state: AppState, p: Path) -> str:
    return state.jail.relative(p)


async def _entry(state: AppState, p: Path) -> dict[str, Any]:
    return await asyncio.to_thread(ops.entry_of, state.jail, p)


# ---------------------------------------------------------------- read


@router.get("/api/fs/list")
async def fs_list(sess: SessionDep, state: StateDep, path: str = "~", hidden: int = 0) -> dict[str, Any]:
    return await asyncio.to_thread(ops.list_dir, state.jail, path, _allow(sess), bool(hidden))


@router.get("/api/fs/stat")
async def fs_stat(sess: SessionDep, state: StateDep, path: str) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(ops.stat_path, state.jail, path, _allow(sess))
    except FileNotFoundError as exc:
        raise FsError(404, "not_found", "No such file or folder") from exc


@router.get("/api/fs/raw")
async def fs_raw(sess: SessionDep, state: StateDep, path: str, download: int = 0) -> FileResponse:
    real = await asyncio.to_thread(ops.resolve, state.jail, path, _allow(sess), must_exist=True)
    if not real.is_file():
        raise FsError(400, "invalid_path", "Not a file")
    mime = await asyncio.to_thread(ops.guess_mime, real, real.name, True)
    headers = {
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
    }
    if download:
        return FileResponse(
            real, media_type=mime, filename=real.name, content_disposition_type="attachment", headers=headers
        )
    if mime in _TEXTY_AS_PLAIN:
        mime = "text/plain"
    return FileResponse(real, media_type=mime, headers=headers)


@router.get("/api/fs/text")
async def fs_read_text(sess: SessionDep, state: StateDep, path: str) -> dict[str, Any]:
    return await asyncio.to_thread(ops.read_text, state.jail, path, _allow(sess))


class TextIn(BaseModel):
    path: str = Field(max_length=4096)
    content: str
    expected_mtime_ns: str | None = None


@router.put("/api/fs/text")
async def fs_write_text(body: TextIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    out = await asyncio.to_thread(
        ops.write_text, state.jail, body.path, _allow(sess), body.content, body.expected_mtime_ns
    )
    await _audit(state, request, sess, "fs.write", path=out["path"], size=out["size"])
    return out


@router.get("/api/fs/checksum")
async def fs_checksum(sess: SessionDep, state: StateDep, path: str, algo: str = "sha256") -> dict[str, str]:
    return await asyncio.to_thread(ops.checksum, state.jail, path, _allow(sess), algo)


@router.get("/api/fs/usage")
async def fs_usage(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return await asyncio.to_thread(ops.usage, state.jail)


# ---------------------------------------------------------------- bookmarks


class Bookmark(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    path: str = Field(min_length=1, max_length=4096)


class BookmarksIn(BaseModel):
    bookmarks: list[Bookmark] = Field(max_length=MAX_BOOKMARKS)


@router.get("/api/fs/bookmarks")
async def get_bookmarks(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    raw = await state.db.get_setting(BOOKMARKS_KEY)
    try:
        items = json.loads(raw) if raw else []
    except ValueError:
        items = []
    return {"bookmarks": items}


@router.put("/api/fs/bookmarks")
async def put_bookmarks(body: BookmarksIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    clean: list[dict[str, str]] = []
    for b in body.bookmarks:
        real = await asyncio.to_thread(ops.resolve, state.jail, b.path, False)
        clean.append({"name": b.name.strip(), "path": _rel(state, real)})
    await state.db.set_setting(BOOKMARKS_KEY, json.dumps(clean))
    return {"bookmarks": clean}


# ---------------------------------------------------------------- create / rename / chmod


class PathIn(BaseModel):
    path: str = Field(max_length=4096)


@router.post("/api/fs/mkdir")
async def fs_mkdir(body: PathIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    p = await asyncio.to_thread(ops.mkdir, state.jail, body.path, _allow(sess))
    await _audit(state, request, sess, "fs.mkdir", path=_rel(state, p))
    return await _entry(state, p)


@router.post("/api/fs/touch")
async def fs_touch(body: PathIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    p = await asyncio.to_thread(ops.touch, state.jail, body.path, _allow(sess))
    await _audit(state, request, sess, "fs.write", path=_rel(state, p), size=0, created=True)
    return await _entry(state, p)


class RenameIn(BaseModel):
    path: str = Field(max_length=4096)
    new_name: str = Field(max_length=1024)


@router.post("/api/fs/rename")
async def fs_rename(body: RenameIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    src, dest = await asyncio.to_thread(ops.rename, state.jail, body.path, _allow(sess), body.new_name)
    await _audit(state, request, sess, "fs.rename", path=_rel(state, src), to=_rel(state, dest))
    return await _entry(state, dest)


class ModeIn(BaseModel):
    path: str = Field(max_length=4096)
    mode: str = Field(max_length=8)


@router.post("/api/fs/chmod")
async def fs_chmod(body: ModeIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    p = await asyncio.to_thread(ops.chmod, state.jail, body.path, _allow(sess), body.mode)
    await _audit(state, request, sess, "fs.chmod", path=_rel(state, p), mode=body.mode)
    return await _entry(state, p)


# ---------------------------------------------------------------- move / copy / delete


class TransferIn(BaseModel):
    sources: list[str] = Field(max_length=1000)
    dest_dir: str = Field(max_length=4096)
    conflict: str = "rename"


@router.post("/api/fs/move")
async def fs_move(body: TransferIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    done = await asyncio.to_thread(
        ops.transfer, state.jail, body.sources, body.dest_dir, _allow(sess), body.conflict, copy=False
    )
    for src, dest in done:
        await _audit(state, request, sess, "fs.move", path=_rel(state, src), to=_rel(state, dest))
    return {"moved": [await _entry(state, d) for _, d in done]}


@router.post("/api/fs/copy")
async def fs_copy(body: TransferIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    done = await asyncio.to_thread(
        ops.transfer, state.jail, body.sources, body.dest_dir, _allow(sess), body.conflict, copy=True
    )
    for src, dest in done:
        await _audit(state, request, sess, "fs.copy", path=_rel(state, src), to=_rel(state, dest))
    return {"copied": [await _entry(state, d) for _, d in done]}


class PathsIn(BaseModel):
    paths: list[str] = Field(max_length=1000)


@router.post("/api/fs/delete")
async def fs_delete(body: PathsIn, request: Request, sess: RecentAuthDep, state: StateDep) -> dict[str, int]:
    gone = await asyncio.to_thread(ops.delete_paths, state.jail, body.paths, True)
    for p in gone:
        await _audit(state, request, sess, "fs.delete", path=_rel(state, p))
    return {"deleted": len(gone)}


# ---------------------------------------------------------------- trash


class IdsIn(BaseModel):
    ids: list[str] = Field(max_length=1000)


@router.post("/api/fs/trash")
async def fs_trash(body: PathsIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    out = await asyncio.to_thread(trash.trash_paths, state.jail, body.paths, _allow(sess))
    for item in out:
        await _audit(state, request, sess, "fs.trash", path=item["original_path"], id=item["id"])
    return {"trashed": out}


@router.get("/api/fs/trash")
async def fs_trash_list(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return {"items": await asyncio.to_thread(trash.list_items, state.jail)}


@router.post("/api/fs/trash/restore")
async def fs_trash_restore(body: IdsIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    paths = await asyncio.to_thread(trash.restore, state.jail, body.ids, _allow(sess))
    for p in paths:
        await _audit(state, request, sess, "fs.restore", path=_rel(state, p))
    return {"restored": [await _entry(state, p) for p in paths]}


@router.post("/api/fs/trash/delete")
async def fs_trash_delete(body: IdsIn, request: Request, sess: RecentAuthDep, state: StateDep) -> dict[str, int]:
    n = await asyncio.to_thread(trash.delete_items, state.jail, body.ids)
    await _audit(state, request, sess, "fs.delete", trash_ids=body.ids, count=n)
    return {"deleted": n}


@router.post("/api/fs/trash/empty")
async def fs_trash_empty(request: Request, sess: RecentAuthDep, state: StateDep) -> dict[str, int]:
    n = await asyncio.to_thread(trash.empty, state.jail)
    await _audit(state, request, sess, "fs.delete", trash="empty", count=n)
    return {"deleted": n}


# ---------------------------------------------------------------- uploads


class UploadInit(BaseModel):
    dest_dir: str = Field(max_length=4096)
    name: str = Field(max_length=1024)
    size: int = Field(ge=0)


class UploadComplete(BaseModel):
    conflict: str = "rename"


def _data_dir(state: AppState) -> Path:
    return Path(state.config.data_dir)


@router.post("/api/fs/upload/init")
async def upload_init(body: UploadInit, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return await asyncio.to_thread(
        uploads.init, state.jail, _data_dir(state), body.dest_dir, body.name, body.size, _allow(sess)
    )


@router.get("/api/fs/upload/{uid}")
async def upload_status(uid: str, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return await asyncio.to_thread(uploads.status, _data_dir(state), uid)


@router.put("/api/fs/upload/{uid}")
async def upload_chunk(
    uid: str, request: Request, sess: SessionDep, state: StateDep, offset: int = 0
) -> dict[str, Any]:
    if offset < 0:
        raise FsError(400, "invalid_path", "Invalid offset")
    buf = bytearray()
    async for part in request.stream():
        buf += part
        if len(buf) > uploads.CHUNK_SIZE:
            raise FsError(413, "too_large", "Chunk is larger than chunk_size")
    return await asyncio.to_thread(uploads.append, _data_dir(state), uid, offset, bytes(buf))


@router.post("/api/fs/upload/{uid}/complete")
async def upload_complete(
    uid: str, body: UploadComplete, request: Request, sess: SessionDep, state: StateDep
) -> dict[str, Any]:
    dest = await asyncio.to_thread(uploads.complete, state.jail, _data_dir(state), uid, body.conflict, _allow(sess))
    await _audit(state, request, sess, "fs.upload", path=_rel(state, dest))
    return await _entry(state, dest)


@router.delete("/api/fs/upload/{uid}")
async def upload_abort(uid: str, sess: SessionDep, state: StateDep) -> dict[str, bool]:
    await asyncio.to_thread(uploads.abort, _data_dir(state), uid)
    return {"ok": True}


# ---------------------------------------------------------------- zip / search


@router.get("/api/fs/zip")
async def fs_zip(sess: SessionDep, state: StateDep, paths: Annotated[list[str], Query()]) -> StreamingResponse:
    allow = _allow(sess)

    def prep() -> list[Path]:
        return [ops.resolve_link(state.jail, p, allow) for p in paths]

    sources = await asyncio.to_thread(prep)
    name = f"{sources[0].name}.zip" if len(sources) == 1 else "files.zip"
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "_")
    disp = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"
    stream = aiter_thread(archives.zip_producer(state.jail, sources, allow))
    return StreamingResponse(
        stream,
        media_type="application/zip",
        headers={"Content-Disposition": disp, "X-Content-Type-Options": "nosniff"},
    )


@router.get("/api/fs/search")
async def fs_search(
    sess: SessionDep,
    state: StateDep,
    q: str = Query(min_length=1, max_length=500),
    path: str = "~",
    mode: str = "name",
    hidden: int = 0,
    glob: str | None = Query(default=None, max_length=200),
) -> StreamingResponse:
    if mode not in ("name", "content"):
        raise FsError(400, "unsupported", "mode must be name or content")
    allow = _allow(sess)
    root = await asyncio.to_thread(ops.resolve, state.jail, path, allow, must_exist=True)
    if not root.is_dir():
        raise FsError(400, "invalid_path", "Not a folder")

    async def lines() -> AsyncIterator[bytes]:
        gen = search.search(state.jail, root, q, mode, bool(hidden), glob, allow)
        try:
            async for item in gen:
                yield (json.dumps(item, separators=(",", ":")) + "\n").encode()
        finally:
            await gen.aclose()

    return StreamingResponse(lines(), media_type="application/x-ndjson")


# ---------------------------------------------------------------- archives


@router.get("/api/fs/archive")
async def fs_archive(sess: SessionDep, state: StateDep, path: str) -> dict[str, Any]:
    return await asyncio.to_thread(archives.list_archive, state.jail, path, _allow(sess))


class ExtractIn(BaseModel):
    path: str = Field(max_length=4096)
    dest_dir: str | None = Field(default=None, max_length=4096)


@router.post("/api/fs/extract")
async def fs_extract(body: ExtractIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    out = await asyncio.to_thread(archives.extract, state.jail, body.path, body.dest_dir, _allow(sess))
    await _audit(state, request, sess, "fs.extract", path=body.path, to=_rel(state, out))
    return await _entry(state, out)


class CompressIn(BaseModel):
    paths: list[str] = Field(max_length=1000)
    dest: str = Field(max_length=4096)


@router.post("/api/fs/compress")
async def fs_compress(body: CompressIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    out = await asyncio.to_thread(archives.compress, state.jail, body.paths, body.dest, _allow(sess))
    await _audit(state, request, sess, "fs.compress", paths=body.paths, to=_rel(state, out))
    return await _entry(state, out)


# ---------------------------------------------------------------- watcher


@router.websocket("/ws/fs")
async def fs_ws(ws: WebSocket) -> None:
    sess = await websocket_session(ws)
    if sess is None:
        return
    state: AppState = ws.app.state.kiln
    await ws.accept()
    watcher: asyncio.Task[None] | None = None
    stop: asyncio.Event | None = None

    async def run_watch(dirs: dict[str, str], ev: asyncio.Event) -> None:
        # dirs: real path -> display path. Non-recursive: only direct children of a watched dir count.
        try:
            async for changes in awatch(
                *dirs,
                debounce=WATCH_DEBOUNCE_MS,
                step=min(50, WATCH_DEBOUNCE_MS),
                stop_event=ev,
                recursive=False,
                ignore_permission_denied=True,
                watch_filter=lambda _c, _p: True,
            ):
                touched = {os.path.dirname(p) for _c, p in changes} | {p for _c, p in changes if p in dirs}
                for real in sorted(touched & dirs.keys()):
                    await ws.send_json({"type": "changed", "path": dirs[real]})
        except (WebSocketDisconnect, RuntimeError):
            return

    async def stop_watcher() -> None:
        nonlocal watcher, stop
        if stop is not None:
            stop.set()
        if watcher is not None:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watcher
        watcher, stop = None, None

    async def set_watch(paths: list[Any]) -> None:
        nonlocal watcher, stop
        await stop_watcher()
        current = await state.sessions.get(sess.id)
        allow = bool(current and current.recently_authenticated())
        dirs: dict[str, str] = {}
        for raw in paths[:MAX_WATCH]:
            if not isinstance(raw, str):
                continue
            try:
                real = await asyncio.to_thread(ops.resolve, state.jail, raw, allow, must_exist=True)
            except FsError:
                continue
            if real.is_dir():
                dirs[str(real)] = state.jail.relative(real)
        if dirs:
            stop = asyncio.Event()
            watcher = asyncio.create_task(run_watch(dirs, stop))

    async def read_client() -> None:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            try:
                data = json.loads(msg.get("text") or "")
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            if data.get("type") == "watch" and isinstance(data.get("paths"), list):
                await set_watch(data["paths"])
            elif data.get("type") == "ping":
                await ws.send_json({"type": "pong"})

    async def recheck() -> None:
        while True:
            await asyncio.sleep(RECHECK_S)
            current = await state.sessions.get(sess.id)
            if current is None:
                await ws.close(code=4401)
                return
            if current.locked:
                await ws.close(code=4423)
                return

    tasks = [asyncio.create_task(read_client()), asyncio.create_task(recheck())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        await stop_watcher()
