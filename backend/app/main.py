"""FastAPI application factory, security middleware and static frontend serving."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.auth.deps import UNSAFE_METHODS, origin_ok
from app.auth.routes import router as auth_router
from app.config import DATA_DIR, Config, load_config
from app.routes_core import router as core_router
from app.routes_fs import install_error_handlers
from app.routes_fs import router as fs_router
from app.routes_metrics import router as metrics_router
from app.routes_terminal import router as terminal_router
from app.state import AppState

log = logging.getLogger("kiln")

CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        # Framer Motion and xterm set inline style attributes; no inline <style>/<script> elements are served.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

SECURITY_HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"strict-transport-security", b"max-age=31536000"),
    (b"x-frame-options", b"DENY"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"permissions-policy", b"microphone=(self), camera=(), geolocation=(), payment=(), usb=()"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
]


class SecurityMiddleware:
    """Adds security headers and rejects cross-origin state-changing requests (pure ASGI)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope["method"] in UNSAFE_METHODS:
            headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
            if not origin_ok(scope["app"].state.kiln, headers):
                resp = JSONResponse(
                    {"detail": {"code": "bad_origin", "message": "Cross-origin request refused"}}, status_code=403
                )
                await self._with_headers(resp, scope, receive, send)
                return
        await self._with_headers(self.app, scope, receive, send)

    @staticmethod
    async def _with_headers(app: ASGIApp, scope: Scope, receive: Receive, send: Send) -> None:
        is_api = scope["path"].startswith("/api/")

        async def wrapped(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                # Routes may set stricter values (e.g. /api/fs/raw's sandbox CSP); never duplicate them.
                present = {k.lower() for k, _ in headers}
                headers.extend(h for h in SECURITY_HEADERS if h[0] not in present)
                if is_api:
                    headers.append((b"cache-control", b"no-store"))
                message["headers"] = headers
            await send(message)

        await app(scope, receive, wrapped)


def find_web_root(config: Config) -> Path | None:
    candidates = [Path(config.server.web_root)] if config.server.web_root else []
    candidates += [Path(__file__).resolve().parents[2] / "frontend" / "dist", DATA_DIR / "web"]
    return next((p for p in candidates if (p / "index.html").is_file()), None)


async def _housekeeping(state: AppState) -> None:
    while True:
        await asyncio.sleep(300)
        with contextlib.suppress(Exception):
            await state.sessions.purge_expired()


def create_app(config: Config | None = None) -> FastAPI:
    config = config or load_config()
    state = AppState.build(config)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await state.db.open()
        await state.sessions.purge_expired()
        await state.audit.record("server.start", actor="system", port=config.server.port, bind=config.server.bind)
        state.metrics.start()
        state.terminals.start()
        task = asyncio.create_task(_housekeeping(state))
        try:
            yield
        finally:
            task.cancel()
            await state.metrics.stop()
            await state.terminals.stop()
            await state.audit.record("server.stop", actor="system")
            await state.db.close()

    app = FastAPI(title="Kiln", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.kiln = state
    app.add_middleware(SecurityMiddleware)
    app.include_router(auth_router)
    app.include_router(core_router)
    app.include_router(metrics_router)
    app.include_router(terminal_router)
    app.include_router(fs_router)
    install_error_handlers(app)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def api_404(rest: str) -> JSONResponse:
        return JSONResponse({"detail": {"code": "not_found", "message": "No such endpoint"}}, status_code=404)

    web_root = find_web_root(config)
    if web_root is not None:
        root = web_root.resolve()
        index = root / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str, request: Request) -> Response:
            target = (root / path).resolve()
            if path and target.is_relative_to(root) and target.is_file():
                immutable = path.startswith("assets/") or path.startswith("fonts/")
                cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
                return FileResponse(target, headers={"cache-control": cache})
            return FileResponse(index, headers={"cache-control": "no-cache"})
    else:
        log.warning("Frontend build not found; run `npm run build` in frontend/ (API still works).")

    return app
