"""OpenAI-compatible client for AXION's router (or any /v1 endpoint): models, streaming chat, unload."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import LLMConfig


class LLMError(Exception):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str = ""

    def args(self) -> dict[str, Any]:
        try:
            parsed = json.loads(self.arguments or "{}")
        except json.JSONDecodeError as exc:
            raise LLMError(f"Malformed tool arguments: {exc}") from exc
        if not isinstance(parsed, dict):
            raise LLMError("Tool arguments must be a JSON object")
        return parsed


@dataclass
class Turn:
    """One assistant turn, accumulated from the stream."""

    content: str = ""
    reasoning: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    timings: dict[str, Any] = field(default_factory=dict)


class LLMClient:
    def __init__(self, config: LLMConfig) -> None:
        self.config = config

    @property
    def base(self) -> str:
        return self.config.base_url.rstrip("/")

    @property
    def root(self) -> str:
        """Router root without /v1 (llama.cpp's router control endpoints live there)."""
        return self.base[:-3] if self.base.endswith("/v1") else self.base

    def _headers(self) -> dict[str, str]:
        h = {"User-Agent": "Kiln"}
        if self.config.api_key:
            h["Authorization"] = f"Bearer {self.config.api_key}"
        return h

    async def models(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{self.base}/models", headers=self._headers())
            r.raise_for_status()
            data = r.json()
        out = []
        for m in data.get("data", []):
            if not isinstance(m, dict) or not isinstance(m.get("id"), str):
                continue
            status = m.get("status")
            arch = m.get("architecture") or {}
            out.append(
                {
                    "id": m["id"],
                    "aliases": [a for a in m.get("aliases") or [] if isinstance(a, str)],
                    "status": status.get("value") if isinstance(status, dict) else None,
                    "vision": "image" in (arch.get("input_modalities") or []),
                }
            )
        return out

    async def unload_all(self) -> list[str]:
        """Ask the router to release every loaded model (frees VRAM for ComfyUI). Best effort."""
        released: list[str] = []
        try:
            models = await self.models()
        except Exception:
            return released
        async with httpx.AsyncClient(timeout=10.0) as client:
            for m in models:
                if m["status"] not in {"loaded", "loading"}:
                    continue
                try:
                    r = await client.post(
                        f"{self.root}/models/unload", json={"model": m["id"]}, headers=self._headers()
                    )
                    if r.status_code < 400:
                        released.append(m["id"])
                except httpx.HTTPError:
                    pass
        return released

    async def stream(
        self, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
    ) -> AsyncIterator[tuple[str, Any]]:
        """Yield ("content"|"reasoning", text) deltas, then ("turn", Turn) once the stream ends."""
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "temperature": self.config.temperature,
            "stream_options": {"include_usage": True},
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        turn = Turn()
        calls: dict[int, ToolCall] = {}
        timeout = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=5.0)
        try:
            async with (
                httpx.AsyncClient(timeout=timeout) as client,
                client.stream("POST", f"{self.base}/chat/completions", json=body, headers=self._headers()) as r,
            ):
                if r.status_code >= 400:
                    text = (await r.aread()).decode("utf-8", "replace")[:400]
                    raise LLMError(f"The model server answered {r.status_code}: {text}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("usage"):
                        turn.usage = chunk["usage"]
                    if chunk.get("timings"):
                        turn.timings = chunk["timings"]
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        if choice.get("finish_reason"):
                            turn.finish_reason = choice["finish_reason"]
                        rc = delta.get("reasoning_content")
                        if rc:
                            turn.reasoning += rc
                            yield "reasoning", rc
                        c = delta.get("content")
                        if c:
                            turn.content += c
                            yield "content", c
                        for tc in delta.get("tool_calls") or []:
                            idx = int(tc.get("index", 0))
                            fn = tc.get("function") or {}
                            call = calls.get(idx)
                            if call is None:
                                call = calls[idx] = ToolCall(id=tc.get("id") or f"call_{idx}", name="")
                            if tc.get("id"):
                                call.id = tc["id"]
                            if fn.get("name"):
                                call.name += fn["name"]
                            if fn.get("arguments"):
                                call.arguments += fn["arguments"]
        except httpx.ConnectError as exc:
            raise LLMError("Can't reach the model server. Start it with `local-ai run`.") from exc
        except httpx.TimeoutException as exc:
            raise LLMError("The model server took too long to answer.") from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"Model server error: {exc}") from exc
        turn.tool_calls = [c for _, c in sorted(calls.items()) if c.name]
        yield "turn", turn
