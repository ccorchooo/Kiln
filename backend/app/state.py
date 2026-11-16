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
from app.fs.jail import Jail
from app.system.hub import MetricsHub
from app.terminal.manager import TerminalManager

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
    terminals: TerminalManager
    jail: Jail
    events: EventHub = field(default_factory=EventHub)
    # Registered by subsystems (terminals, running AI tools) to kill everything on panic.
    panic_hooks: list[PanicHook] = field(default_factory=list)

    @classmethod
    def build(cls, config: Config) -> AppState:
        db = Database(config.db_path)
        audit = AuditLog(db)
        terminals = TerminalManager(config, audit)
        state = cls(
            config=config,
            db=db,
            audit=audit,
            sessions=SessionStore(db, config.auth),
            credentials=Credentials(db),
            limiter=LoginRateLimiter(db, config.auth),
            metrics=MetricsHub(config),
            terminals=terminals,
            jail=Jail(
                config.files.jail_root,
                config.files.denylist,
                home=config.files.jail_root,
                max_read_bytes=config.files.max_read_bytes,
            ),
        )
        state.panic_hooks.append(terminals.panic)
        return state
