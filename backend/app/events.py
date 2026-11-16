"""In-process pub/sub feeding /ws/events. Each socket belongs to a session."""

from __future__ import annotations

import asyncio
import itertools
from dataclasses import dataclass, field
from typing import Any


@dataclass(eq=False)  # identity-hashed so it can live in a set
class Subscriber:
    session_id: str
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=256))


class EventHub:
    def __init__(self) -> None:
        self._subs: set[Subscriber] = set()
        self._seq = itertools.count(1)

    def subscribe(self, session_id: str) -> Subscriber:
        sub = Subscriber(session_id)
        self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subs.discard(sub)

    def publish(
        self, kind: str, data: dict[str, Any] | None = None, *, session_id: str | None = None, lock_safe: bool = False
    ) -> None:
        """lock_safe events may be delivered to locked sessions (no sensitive content)."""
        msg = {"seq": next(self._seq), "kind": kind, "data": data or {}, "lock_safe": lock_safe}
        for sub in list(self._subs):
            if session_id is not None and sub.session_id != session_id:
                continue
            try:
                sub.queue.put_nowait(msg)
            except asyncio.QueueFull:
                pass  # slow consumer; client resyncs on reconnect
