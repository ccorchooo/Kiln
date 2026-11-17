"""Ember's conversation engine: history, the tool loop, approvals, cancellation, model choice.

A run is a producer task that writes events into a queue; the HTTP response streams that queue
as NDJSON. Stopping (button, client disconnect, lock-free panic) cancels the producer, which kills
any command it started, interrupts ComfyUI, and denies its pending approvals.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from app.ember import tools
from app.ember.comfy import SIZES, ComfyClient, ImageError
from app.ember.llm import LLMClient, LLMError, ToolCall
from app.ember.risk import Risk
from app.ember.voice import Voice
from app.fs import ops

if TYPE_CHECKING:
    from app.state import AppState

MODEL_KEY = "ember.model"
HISTORY_LIMIT = 200


class EmberBusy(Exception):
    pass


class ApprovalError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass
class Decision:
    approve: bool
    sudo_password: str | None = None


@dataclass
class Approval:
    id: str
    session_id: str
    conversation_id: str
    call_id: str
    tool: str
    risk: Risk
    mode: str  # tap | typed
    expect: str
    summary: str
    reason: str
    detail: str
    sudo: bool
    future: asyncio.Future[Decision]
    created_at: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "call_id": self.call_id,
            "tool": self.tool,
            "risk": self.risk.label,
            "mode": self.mode,
            "expect": self.expect if self.mode == "typed" else "",
            "summary": self.summary,
            "reason": self.reason,
            "detail": self.detail,
            "sudo": self.sudo,
            "reauth": self.risk >= Risk.DANGER,
            "created_at": self.created_at,
        }


@dataclass
class Run:
    conversation_id: str
    session_id: str
    queue: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None


def _now() -> float:
    return time.time()


def _title(text: str) -> str:
    line = " ".join(text.split())
    return (line[:57] + "…") if len(line) > 58 else (line or "New chat")


def _approx_tokens(msg: dict[str, Any]) -> int:
    return len(json.dumps(msg, ensure_ascii=False)) // 3 + 4


class EmberService:
    def __init__(self, state: AppState) -> None:
        self.state = state
        self.llm = LLMClient(state.config.llm)
        self.comfy = ComfyClient(state.config.image)
        self.voice = Voice(state.config.voice)
        self.runs: dict[str, Run] = {}
        self.approvals: dict[str, Approval] = {}
        self.procs: set[asyncio.subprocess.Process] = set()

    # ------------------------------------------------------------ models

    async def current_model(self) -> str:
        return (await self.state.db.get_setting(MODEL_KEY)) or self.state.config.llm.model

    async def models(self) -> dict[str, Any]:
        current = await self.current_model()
        try:
            models = await self.llm.models()
            reachable = True
        except Exception:
            models, reachable = [], False
        for m in models:
            m["current"] = current == m["id"] or current in m["aliases"]
        return {"models": models, "current": current, "reachable": reachable}

    async def set_model(self, model: str) -> str:
        listing = await self.llm.models()
        match = next((m for m in listing if model == m["id"] or model in m["aliases"]), None)
        if match is None:
            raise ValueError("The model server doesn't offer that model")
        await self.state.db.set_setting(MODEL_KEY, match["id"])
        return str(match["id"])

    # ------------------------------------------------------------ conversations

    async def list_conversations(self) -> list[dict[str, Any]]:
        sql = "SELECT id, title, created_at, updated_at FROM ember_conversations ORDER BY updated_at DESC LIMIT ?"
        async with self.state.db.conn.execute(sql, (HISTORY_LIMIT,)) as cur:
            rows = await cur.fetchall()
        return [dict(r) | {"running": r["id"] in self.runs} for r in rows]

    async def get_conversation(self, cid: str) -> dict[str, Any] | None:
        async with self.state.db.conn.execute(
            "SELECT id, title, created_at, updated_at FROM ember_conversations WHERE id = ?", (cid,)
        ) as cur:
            row = await cur.fetchone()
        if row is None:
            return None
        async with self.state.db.conn.execute(
            "SELECT id, role, content, data, created_at FROM ember_messages WHERE conversation_id = ? ORDER BY id",
            (cid,),
        ) as cur:
            msgs = [
                {
                    "id": r["id"],
                    "role": r["role"],
                    "content": r["content"],
                    "data": json.loads(r["data"]),
                    "created_at": r["created_at"],
                }
                for r in await cur.fetchall()
            ]
        pending = [a.public() for a in self.approvals.values() if a.conversation_id == cid]
        return dict(row) | {"messages": msgs, "running": cid in self.runs, "approvals": pending}

    async def delete_conversation(self, cid: str) -> None:
        await self.stop(cid)
        await self.state.db.conn.execute("DELETE FROM ember_conversations WHERE id = ?", (cid,))

    async def _create_conversation(self, title: str) -> str:
        cid = secrets.token_hex(8)
        now = _now()
        await self.state.db.conn.execute(
            "INSERT INTO ember_conversations(id, title, created_at, updated_at) VALUES(?, ?, ?, ?)",
            (cid, title, now, now),
        )
        return cid

    async def _add(self, cid: str, role: str, content: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        now = _now()
        async with self.state.db.conn.execute(
            "INSERT INTO ember_messages(conversation_id, role, content, data, created_at) VALUES(?, ?, ?, ?, ?)",
            (cid, role, content, json.dumps(data or {}), now),
        ) as cur:
            mid = cur.lastrowid
        await self.state.db.conn.execute("UPDATE ember_conversations SET updated_at = ? WHERE id = ?", (now, cid))
        return {"id": mid, "role": role, "content": content, "data": data or {}, "created_at": now}

    async def _history(self, cid: str) -> list[dict[str, Any]]:
        async with self.state.db.conn.execute(
            "SELECT role, content, data FROM ember_messages WHERE conversation_id = ? ORDER BY id", (cid,)
        ) as cur:
            rows = await cur.fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            data = json.loads(r["data"])
            if r["role"] == "assistant" and data.get("kind") == "image":
                paths = ", ".join(data.get("images", []))
                note = f"[I generated an image of “{data.get('prompt')}”: {paths}]"
                out.append({"role": "assistant", "content": note})
            elif r["role"] == "assistant":
                msg: dict[str, Any] = {"role": "assistant", "content": r["content"]}
                if data.get("tool_calls"):
                    msg["tool_calls"] = [
                        {
                            "id": c["id"],
                            "type": "function",
                            "function": {"name": c["name"], "arguments": c["arguments"]},
                        }
                        for c in data["tool_calls"]
                    ]
                out.append(msg)
            elif r["role"] == "tool":
                out.append({"role": "tool", "tool_call_id": data.get("tool_call_id", ""), "content": r["content"]})
            else:
                out.append({"role": "user", "content": r["content"]})
        return out

    def _system_prompt(self) -> str:
        cfg = self.state.config
        try:
            now = datetime.now(ZoneInfo(cfg.location.timezone))
        except Exception:
            now = datetime.now()
        return (
            f"You are {cfg.user.assistant_name}, the assistant inside Kiln, a web desktop for "
            f"{cfg.user.display_name}'s CachyOS (Arch Linux) PC. "
            "You run on a local model; nothing leaves the machine.\n"
            f"Now: {now:%A %d %B %Y, %H:%M} ({cfg.location.city}). Home folder: {self.state.jail.root}.\n"
            "Be calm, warm and concise. Reply in the user's language (if Spanish, rioplatense voseo).\n"
            "You act on the real PC through tools. Look things up instead of guessing, and prefer read-only tools. "
            "Kiln asks the user to approve anything that changes the system; if a call is denied, don't retry it - "
            "ask what they'd prefer. Commands are non-interactive: pass --noconfirm or -y. Use sudo only when root "
            f"is required. The AUR helper is {cfg.packages.aur_helper}.\n"
            "When the user asks for a picture, drawing or image, call generate_image with a detailed English prompt.\n"
            "Format with Markdown. Keep answers short unless asked for detail."
        )

    def _fit(self, system: dict[str, Any], history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        budget = int(self.state.config.llm.context_length * 0.7) - _approx_tokens(system) - 1500
        msgs = list(history)
        total = sum(_approx_tokens(m) for m in msgs)
        while msgs and total > budget and len(msgs) > 1:
            total -= _approx_tokens(msgs.pop(0))
            while msgs and msgs[0]["role"] != "user":  # never start with an orphaned tool result
                total -= _approx_tokens(msgs.pop(0))
        return [system, *msgs]

    # ------------------------------------------------------------ runs

    def is_running(self, cid: str) -> bool:
        return cid in self.runs

    async def start(
        self, session_id: str, cid: str | None, text: str, image: dict[str, Any] | None, ip: str | None
    ) -> tuple[str, Run]:
        if cid is not None:
            if cid in self.runs:
                raise EmberBusy("Ember is still answering in this chat")
            if await self.get_conversation(cid) is None:
                raise KeyError(cid)
        else:
            cid = await self._create_conversation(_title(text))
        run = Run(conversation_id=cid, session_id=session_id)
        self.runs[cid] = run
        run.task = asyncio.create_task(self._produce(run, text, image, ip))
        return cid, run

    async def stream(self, run: Run) -> AsyncIterator[bytes]:
        try:
            while True:
                ev = await run.queue.get()
                if ev is None:
                    break
                yield (json.dumps(ev, ensure_ascii=False) + "\n").encode()
        finally:
            if run.task is not None and not run.task.done():
                run.task.cancel()

    async def stop(self, cid: str) -> bool:
        run = self.runs.get(cid)
        if run is None or run.task is None:
            return False
        run.task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await run.task
        return True

    async def panic(self) -> None:
        for cid in list(self.runs):
            await self.stop(cid)
        for proc in list(self.procs):
            tools.kill_group(proc)
        await self.comfy.interrupt()

    async def stop_all(self) -> None:
        await self.panic()

    async def _produce(self, run: Run, text: str, image: dict[str, Any] | None, ip: str | None) -> None:
        cid = run.conversation_id
        emit = run.queue.put_nowait
        partial: dict[str, str] = {"content": ""}
        try:
            conv = await self.get_conversation(cid)
            user_msg = await self._add(cid, "user", text, {"kind": "image_request", **image} if image else {})
            emit(
                {
                    "type": "start",
                    "conversation": {"id": cid, "title": conv["title"] if conv else _title(text)},
                    "message": user_msg,
                }
            )
            if image is not None:
                await self._image_turn(run, text, image)
            else:
                await self._chat_turns(run, partial, ip)
        except asyncio.CancelledError:
            if partial["content"].strip():
                with contextlib.suppress(Exception):
                    await self._add(cid, "assistant", partial["content"] + "\n\n*(stopped)*", {"stopped": True})
            emit({"type": "stopped"})
        except (LLMError, ImageError) as exc:
            emit({"type": "error", "message": str(exc)})
            with contextlib.suppress(Exception):
                await self._add(cid, "assistant", "", {"error": str(exc)})
        except Exception as exc:  # pragma: no cover - surfaced to the user, logged by the audit trail
            emit({"type": "error", "message": f"Something went wrong: {type(exc).__name__}: {exc}"[:300]})
        finally:
            for a in [a for a in self.approvals.values() if a.conversation_id == cid]:
                if not a.future.done():
                    a.future.set_result(Decision(False))
                self.approvals.pop(a.id, None)
            self.runs.pop(cid, None)
            emit({"type": "done"})
            emit(None)

    async def _image_turn(self, run: Run, prompt: str, image: dict[str, Any]) -> None:
        size = image.get("size") if image.get("size") in SIZES else "square"
        call_id = "img_" + secrets.token_hex(4)
        run.queue.put_nowait(
            {
                "type": "tool_call",
                "call": {
                    "id": call_id,
                    "name": "generate_image",
                    "risk": "safe",
                    "summary": "Generate an image",
                    "detail": prompt,
                },
            }
        )

        async def progress(note: str) -> None:
            run.queue.put_nowait({"type": "tool_output", "call_id": call_id, "text": note, "replace": True})

        out = await self.generate_image(
            prompt, size=str(size), negative=str(image.get("negative") or ""), progress=progress
        )
        rel = [self.state.jail.relative(Path(p)) for p in out["paths"]]
        msg = await self._add(
            run.conversation_id,
            "assistant",
            "",
            {
                "kind": "image",
                "prompt": prompt,
                "images": rel,
                "seed": out["seed"],
                "size": size,
                "width": out["width"],
                "height": out["height"],
            },
        )
        run.queue.put_nowait({"type": "tool_result", "call_id": call_id, "status": "ok", "images": rel, "output": ""})
        run.queue.put_nowait({"type": "message", "message": msg})
        await self.state.audit.record(
            "ember.image", actor="ember", session_id=run.session_id, prompt=prompt[:200], files=rel
        )

    async def generate_image(
        self, prompt: str, *, size: str = "square", negative: str = "", progress: tools.Emit | None = None
    ) -> dict[str, Any]:
        dest = await asyncio.to_thread(ops.resolve, self.state.jail, self.state.config.image.output_dir, False)

        async def before() -> None:
            if self.state.config.llm.unload_for_images:
                if progress is not None:
                    await progress("Freeing the GPU…")
                await self.llm.unload_all()

        return await self.comfy.generate(prompt, dest, size=size, negative=negative, progress=progress, before=before)

    async def _chat_turns(self, run: Run, partial: dict[str, str], ip: str | None) -> None:
        cid = run.conversation_id
        q = run.queue
        model = await self.current_model()
        system = {"role": "system", "content": self._system_prompt()}
        for _round in range(max(1, self.state.config.llm.max_tool_rounds)):
            await self.comfy.free()
            messages = self._fit(system, await self._history(cid))
            partial["content"] = ""
            turn = None
            q.put_nowait({"type": "turn", "model": model})
            async for kind, value in self.llm.stream(model, messages, tools.SCHEMAS):
                if kind == "content":
                    partial["content"] += value
                    q.put_nowait({"type": "delta", "text": value})
                elif kind == "reasoning":
                    q.put_nowait({"type": "reasoning", "text": value})
                else:
                    turn = value
            assert turn is not None
            calls: list[ToolCall] = turn.tool_calls
            data: dict[str, Any] = {"model": model}
            if turn.reasoning:
                data["reasoning"] = turn.reasoning
            if calls:
                data["tool_calls"] = [{"id": c.id, "name": c.name, "arguments": c.arguments} for c in calls]
            if turn.timings.get("predicted_per_second"):
                data["tps"] = round(float(turn.timings["predicted_per_second"]), 1)
            msg = await self._add(cid, "assistant", turn.content, data)
            partial["content"] = ""
            q.put_nowait({"type": "message", "message": msg})
            if not calls:
                return
            for call in calls:
                await self._handle_call(run, call, ip)
        note = await self._add(
            cid,
            "assistant",
            "I've reached the limit of steps for one message. Tell me to continue if you want me to keep going.",
            {"model": model},
        )
        q.put_nowait({"type": "message", "message": note})

    async def _handle_call(self, run: Run, call: ToolCall, ip: str | None) -> None:
        cid = run.conversation_id
        q = run.queue

        async def result(
            status: str,
            output: str,
            *,
            plan: tools.Plan | None = None,
            images: list[str] | None = None,
            meta: dict[str, Any] | None = None,
        ) -> None:
            data = {
                "tool_call_id": call.id,
                "name": call.name,
                "status": status,
                "images": images or [],
                "meta": meta or {},
                "risk": plan.risk.label if plan else "safe",
                "summary": plan.summary if plan else call.name,
                "detail": plan.detail if plan else "",
            }
            msg = await self._add(cid, "tool", output, data)
            q.put_nowait(
                {
                    "type": "tool_result",
                    "call_id": call.id,
                    "status": status,
                    "output": output,
                    "images": images or [],
                    "message": msg,
                }
            )

        try:
            args = call.args()
            plan = tools.plan(call.name, args, self)
        except (ValueError, LLMError) as exc:
            q.put_nowait(
                {
                    "type": "tool_call",
                    "call": {"id": call.id, "name": call.name, "risk": "safe", "summary": call.name, "detail": ""},
                }
            )
            await result("error", f"Error: {exc}")
            return

        q.put_nowait(
            {
                "type": "tool_call",
                "call": {
                    "id": call.id,
                    "name": call.name,
                    "risk": plan.risk.label,
                    "summary": plan.summary,
                    "detail": plan.detail,
                    "reason": plan.reason,
                },
            }
        )
        policy = getattr(self.state.config.approvals, plan.risk.label, "typed")
        sudo_password: str | None = None
        decided = "auto"
        if policy != "auto":
            decision = await self._ask(run, call, plan, "typed" if policy == "typed" else "tap")
            if not decision.approve:
                await self.state.audit.record(
                    "ember.tool",
                    actor="ember",
                    outcome="denied",
                    session_id=run.session_id,
                    ip=ip,
                    tool=call.name,
                    risk=plan.risk.label,
                    summary=plan.summary,
                    detail=plan.detail[:500],
                )
                await result(
                    "denied", "The user denied this action. Don't retry it; ask what they'd like instead.", plan=plan
                )
                return
            sudo_password = decision.sudo_password
            decided = "approved"

        q.put_nowait({"type": "tool_running", "call_id": call.id})

        async def emit(text: str) -> None:
            q.put_nowait({"type": "tool_output", "call_id": call.id, "text": text})

        try:
            res = await tools.execute(call.name, args, self, emit, sudo_password)
        finally:
            sudo_password = None
        await self.state.audit.record(
            "ember.tool",
            actor="ember",
            outcome="ok" if res.ok else "error",
            session_id=run.session_id,
            ip=ip,
            tool=call.name,
            risk=plan.risk.label,
            decision=decided,
            summary=plan.summary,
            detail=plan.detail[:500],
        )
        await result("ok" if res.ok else "error", res.output, plan=plan, images=res.images, meta=res.meta)

    async def _ask(self, run: Run, call: ToolCall, plan: tools.Plan, mode: str) -> Decision:
        expect = ""
        if mode == "typed":
            if call.name == "run_command":
                words = [w for w in plan.detail.split() if w not in {"sudo", "doas"} and "=" not in w]
                expect = (words[0].rsplit("/", 1)[-1] if words else "run")[:24]
            else:
                expect = {"write_file": "write"}.get(call.name, "yes")
        loop = asyncio.get_running_loop()
        approval = Approval(
            id=secrets.token_hex(8),
            session_id=run.session_id,
            conversation_id=run.conversation_id,
            call_id=call.id,
            tool=call.name,
            risk=plan.risk,
            mode=mode,
            expect=expect,
            summary=plan.summary,
            reason=plan.reason,
            detail=plan.detail,
            sudo=plan.sudo,
            future=loop.create_future(),
        )
        self.approvals[approval.id] = approval
        run.queue.put_nowait({"type": "approval", "approval": approval.public()})
        self.state.events.publish("ember.approvals", {"pending": len(self.approvals)}, session_id=run.session_id)
        try:
            timeout = max(10.0, self.state.config.approvals.timeout_minutes * 60)
            try:
                return await asyncio.wait_for(asyncio.shield(approval.future), timeout=timeout)
            except TimeoutError:
                return Decision(False)
        finally:
            self.approvals.pop(approval.id, None)
            run.queue.put_nowait({"type": "approval_resolved", "id": approval.id})
            self.state.events.publish("ember.approvals", {"pending": len(self.approvals)}, session_id=run.session_id)

    def resolve(
        self,
        approval_id: str,
        session_id: str,
        recent_auth: bool,
        approve: bool,
        typed: str,
        sudo_password: str | None,
    ) -> None:
        a = self.approvals.get(approval_id)
        if a is None or a.session_id != session_id or a.future.done():
            raise ApprovalError(404, "not_found", "That approval is no longer pending")
        if not approve:
            a.future.set_result(Decision(False))
            return
        if a.risk >= Risk.DANGER and not recent_auth:
            raise ApprovalError(403, "reauth_required", "Confirm your password")
        if a.mode == "typed" and typed.strip() != a.expect:
            raise ApprovalError(400, "typed_mismatch", f"Type “{a.expect}” to confirm")
        if a.sudo and not sudo_password:
            raise ApprovalError(400, "sudo_required", "This command needs your sudo password")
        a.future.set_result(Decision(True, sudo_password if a.sudo else None))
