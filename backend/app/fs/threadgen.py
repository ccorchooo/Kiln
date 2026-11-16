"""Run a blocking producer in a thread and consume its output as an async iterator with back-pressure."""

from __future__ import annotations

import asyncio
import contextlib
import queue
import threading
from collections.abc import AsyncIterator, Callable
from typing import Any

_END = object()


class Cancelled(Exception):
    """Raised inside the producer thread (from emit) when the consumer went away."""


async def aiter_thread[T](producer: Callable[[Callable[[T], None]], None], maxsize: int = 8) -> AsyncIterator[T]:
    q: queue.Queue[Any] = queue.Queue(maxsize=maxsize)
    cancel = threading.Event()

    def put(item: Any) -> None:
        while True:
            if cancel.is_set():
                raise Cancelled
            try:
                q.put(item, timeout=0.2)
                return
            except queue.Full:
                continue

    def run() -> None:
        err: BaseException | None = None
        try:
            producer(put)
        except Cancelled:
            return
        except BaseException as exc:  # noqa: BLE001 - re-raised on the consumer side
            err = exc
        with contextlib.suppress(Cancelled):
            put((_END, err))

    task = asyncio.ensure_future(asyncio.to_thread(run))
    try:
        while True:
            try:
                item = await asyncio.to_thread(q.get, True, 0.2)
            except queue.Empty:
                continue
            if isinstance(item, tuple) and len(item) == 2 and item[0] is _END:
                if item[1] is not None:
                    raise item[1]
                return
            yield item
    finally:
        cancel.set()
        with contextlib.suppress(Exception):
            while True:
                q.get_nowait()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await asyncio.shield(task)
