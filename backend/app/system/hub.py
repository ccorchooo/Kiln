"""MetricsHub: one shared sampling loop feeding every /ws/metrics subscriber."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from app.config import Config
from app.system.metrics import ALL_TOPICS, FAST_TOPICS, SLOW_TOPICS, Collectors

log = logging.getLogger("kiln.metrics")

HIDDEN_INTERVAL_S = 5.0
MEDIA_INTERVAL_S = 2.0
UPDATES_FIRST_RUN_S = 10.0

Message = tuple[float, dict[str, Any]]


@dataclass(eq=False)
class MetricsSub:
    session_id: str
    topics: set[str] = field(default_factory=set)
    hidden: bool = False
    queue: asyncio.Queue[Message] = field(default_factory=lambda: asyncio.Queue(maxsize=16))
    pending: dict[str, Any] = field(default_factory=dict)
    last_sent: float = 0.0

    def _put(self, ts: float, data: dict[str, Any]) -> None:
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        self.queue.put_nowait((ts, data))

    def flush(self, now: float) -> None:
        if self.pending:
            self._put(now, self.pending)
            self.pending = {}
            self.last_sent = now

    def deliver(self, data: dict[str, Any], now: float) -> None:
        relevant = {t: v for t, v in data.items() if t in self.topics}
        if not relevant:
            return
        self.pending.update(relevant)
        if not self.hidden or now - self.last_sent >= HIDDEN_INTERVAL_S:
            self.flush(now)


class MetricsHub:
    def __init__(self, config: Config) -> None:
        self.collectors = Collectors(config)
        self.tick_s = 1.0
        self.updates_delay_s = UPDATES_FIRST_RUN_S
        self.latest: dict[str, Any] = {}
        self._subs: set[MetricsSub] = set()
        self._loop_task: asyncio.Task[None] | None = None
        self._bg_task: asyncio.Task[None] | None = None
        self._started = time.monotonic()
        self._last_media = 0.0

    def start(self) -> None:
        self._started = time.monotonic()

    async def stop(self) -> None:
        for t in (self._loop_task, self._bg_task):
            if t is not None:
                t.cancel()
        for t in (self._loop_task, self._bg_task):
            if t is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
        self._loop_task = self._bg_task = None
        self._subs.clear()

    # --- subscribers

    def subscribe(self, session_id: str) -> MetricsSub:
        sub = MetricsSub(session_id)
        self._subs.add(sub)
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self._run())
        if self._bg_task is None or self._bg_task.done():
            self._bg_task = asyncio.create_task(self._background())
        return sub

    def unsubscribe(self, sub: MetricsSub) -> None:
        self._subs.discard(sub)

    def set_topics(self, sub: MetricsSub, topics: set[str]) -> None:
        sub.topics = topics & set(ALL_TOPICS)
        sub.deliver({t: v for t, v in self.latest.items() if t in sub.topics}, time.time())

    def set_hidden(self, sub: MetricsSub, hidden: bool) -> None:
        sub.hidden = hidden
        if not hidden:
            sub.flush(time.time())

    # --- sampling

    def _wanted(self) -> set[str]:
        return set().union(*(s.topics for s in self._subs)) if self._subs else set()

    async def _sample(self, topic: str) -> Any:
        return await self.collectors.collect(topic)

    async def tick(self) -> None:
        wanted = self._wanted()
        all_hidden = all(s.hidden for s in self._subs)
        data: dict[str, Any] = {}
        for t in FAST_TOPICS:
            if t in wanted and not (t == "gpu" and all_hidden):
                data[t] = await self._sample(t)
        mono = time.monotonic()
        if "media" in wanted and mono - self._last_media >= MEDIA_INTERVAL_S:
            self._last_media = mono
            data["media"] = await self._sample("media")
        for t in SLOW_TOPICS:
            if t in wanted:
                v = await self._sample(t)
                if v != self.latest.get(t):
                    data[t] = v
        self.latest.update(data)
        now = time.time()
        for sub in list(self._subs):
            sub.deliver(data, now)

    async def _run(self) -> None:
        while self._subs:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("metrics tick failed")
            await asyncio.sleep(self.tick_s)

    async def _background(self) -> None:
        """Refresh the slow, cached topics (updates, weather, AI reachability) without blocking ticks."""
        while self._subs:
            wanted = self._wanted()
            for topic in SLOW_TOPICS:
                if topic not in wanted:
                    continue
                if topic == "updates" and time.monotonic() - self._started < self.updates_delay_s:
                    continue
                try:
                    await self.collectors.refresh(topic)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("refresh %s failed", topic)
            await asyncio.sleep(min(self.tick_s, 1.0))

    async def snapshot(self, topics: set[str]) -> dict[str, Any]:
        """Latest values for the topics, sampling once for any the hub has not produced yet."""
        out: dict[str, Any] = {}
        for t in sorted(topics & set(ALL_TOPICS)):
            if t not in self.latest or (not self._subs and t not in SLOW_TOPICS):
                if t in SLOW_TOPICS and self.collectors.never_refreshed(t) and t != "updates":
                    await self.collectors.refresh(t, force=True)
                self.latest[t] = await self._sample(t)
            out[t] = self.latest[t]
        return out
