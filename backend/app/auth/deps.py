"""Request guards: client IP, session, CSRF and recent-auth requirements."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request, WebSocket

from app.auth.sessions import COOKIE_NAME, Session
from app.state import AppState

CSRF_HEADER = "x-csrf-token"
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.kiln
    return state


def client_ip(request: Request | WebSocket) -> str:
    # Uvicorn runs with proxy headers disabled, so this is the real peer address.
    return request.client.host if request.client else "unknown"


def allowed_origins(state: AppState, host: str | None) -> set[str]:
    origins = {o.rstrip("/") for o in state.config.server.extra_origins}
    if state.config.server.dev_cors_origin:
        origins.add(state.config.server.dev_cors_origin.rstrip("/"))
    if host:
        origins.add(f"https://{host}")
    return origins


def origin_ok(state: AppState, headers: Mapping[str, str]) -> bool:
    get = headers.get
    origin = get("origin")
    if origin is None:
        referer = get("referer")
        if not referer:
            return False
        parts = urlsplit(referer)
        origin = f"{parts.scheme}://{parts.netloc}"
    return str(origin).rstrip("/") in allowed_origins(state, get("host"))


async def optional_session(request: Request) -> Session | None:
    state = get_state(request)
    cached: Session | None = getattr(request.state, "kiln_session", None)
    if cached is not None:
        return cached
    sess = await state.sessions.lookup(request.cookies.get(COOKIE_NAME))
    request.state.kiln_session = sess
    return sess


def _check_csrf(request: Request, sess: Session) -> None:
    if request.method in UNSAFE_METHODS and not sess.csrf_ok(request.headers.get(CSRF_HEADER)):
        raise HTTPException(403, detail={"code": "csrf", "message": "Missing or invalid CSRF token"})


async def any_session(request: Request, sess: Annotated[Session | None, Depends(optional_session)]) -> Session:
    """A valid session, possibly locked. CSRF-checked."""
    if sess is None:
        raise HTTPException(401, detail={"code": "unauthenticated", "message": "Sign in required"})
    _check_csrf(request, sess)
    return sess


async def require_session(sess: Annotated[Session, Depends(any_session)]) -> Session:
    """A valid, unlocked session."""
    if sess.locked:
        raise HTTPException(423, detail={"code": "locked", "message": "Session is locked"})
    return sess


async def require_recent_auth(sess: Annotated[Session, Depends(require_session)]) -> Session:
    if not sess.recently_authenticated():
        raise HTTPException(403, detail={"code": "reauth_required", "message": "Confirm your password"})
    return sess


async def websocket_session(ws: WebSocket, allow_locked: bool = False) -> Session | None:
    """Authenticate a WebSocket from its cookie and Origin. Returns None (and closes) on failure."""
    state: AppState = ws.app.state.kiln
    if not origin_ok(state, ws.headers):
        await ws.close(code=4403)
        return None
    sess = await state.sessions.lookup(ws.cookies.get(COOKIE_NAME))
    if sess is None or (sess.locked and not allow_locked):
        await ws.close(code=4401)
        return None
    return sess


SessionDep = Annotated[Session, Depends(require_session)]
AnySessionDep = Annotated[Session, Depends(any_session)]
RecentAuthDep = Annotated[Session, Depends(require_recent_auth)]
StateDep = Annotated[AppState, Depends(get_state)]
