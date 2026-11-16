"""Process-wide application state, created in the FastAPI lifespan."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from app.audit.log import AuditLog
from app.auth.credentials import Credentials
from app.auth.ratelimit import LoginRateLimiter
from app.auth.sessions import SessionStore
from app.config import Config
from app.db import Database
from app.events import EventHub
from app.system.hub import MetricsHub

PanicHook = Callable[[], Awaitable[None]]


@dataclass
class AppState:
    config: Config
    db: Database
    audit: AuditLog
    sessions: SessionStore
    credentials: Credentials
    limiter: LoginRateLimiter
    metrics: MetricsHub
    events: EventHub = field(default_factory=EventHub)
    # Registered by subsystems (terminals, running AI tools) to kill everything on panic.
    panic_hooks: list[PanicHook] = field(default_factory=list)

    @classmethod
    def build(cls, config: Config) -> AppState:
        db = Database(config.db_path)
        return cls(
            config=config,
            db=db,
            audit=AuditLog(db),
            sessions=SessionStore(db, config.auth),
            credentials=Credentials(db),
            limiter=LoginRateLimiter(db, config.auth),
            metrics=MetricsHub(config),
        )
