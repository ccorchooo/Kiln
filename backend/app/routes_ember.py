"""Ember API: chat (NDJSON stream), conversations, approvals, model choice, image status, voice."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from app.auth.deps import SessionDep, StateDep, client_ip
from app.ember.comfy import SIZES
from app.ember.service import ApprovalError, EmberBusy
from app.ember.voice import VoiceError

router = APIRouter()


class ImageOpts(BaseModel):
    size: Literal["square", "landscape", "portrait", "wide", "tall"] = "square"
    negative: str = Field(default="", max_length=2000)


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=32000)
    conversation_id: str | None = Field(default=None, max_length=64)
    image: ImageOpts | None = None


class ModelIn(BaseModel):
    model: str = Field(min_length=1, max_length=200)


class DecisionIn(BaseModel):
    approve: bool
    typed: str = Field(default="", max_length=200)
    sudo_password: str | None = Field(default=None, max_length=1024)


@router.get("/api/ember/models")
async def ember_models(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return await state.ember.models()


@router.put("/api/ember/model")
async def ember_set_model(body: ModelIn, request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    try:
        model = await state.ember.set_model(body.model)
    except ValueError as exc:
        raise HTTPException(400, detail={"code": "unknown_model", "message": str(exc)}) from exc
    except Exception as exc:
        raise HTTPException(502, detail={"code": "llm_unreachable", "message": "Can't reach the model server"}) from exc
    await state.audit.record("ember.model", ip=client_ip(request), session_id=sess.id, model=model)
    return {"current": model}


@router.get("/api/ember/conversations")
async def ember_conversations(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return {"conversations": await state.ember.list_conversations()}


@router.get("/api/ember/conversations/{cid}")
async def ember_conversation(cid: str, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    conv = await state.ember.get_conversation(cid)
    if conv is None:
        raise HTTPException(404, detail={"code": "not_found", "message": "No such conversation"})
    return conv


@router.delete("/api/ember/conversations/{cid}")
async def ember_delete(cid: str, sess: SessionDep, state: StateDep) -> dict[str, bool]:
    await state.ember.delete_conversation(cid)
    return {"ok": True}


@router.post("/api/ember/conversations/{cid}/stop")
async def ember_stop(cid: str, sess: SessionDep, state: StateDep) -> dict[str, bool]:
    return {"stopped": await state.ember.stop(cid)}


@router.post("/api/ember/chat")
async def ember_chat(body: ChatIn, request: Request, sess: SessionDep, state: StateDep) -> StreamingResponse:
    try:
        _, run = await state.ember.start(
            sess.id,
            body.conversation_id,
            body.text,
            body.image.model_dump() if body.image else None,
            client_ip(request),
        )
    except EmberBusy as exc:
        raise HTTPException(409, detail={"code": "busy", "message": str(exc)}) from exc
    except KeyError as exc:
        raise HTTPException(404, detail={"code": "not_found", "message": "No such conversation"}) from exc
    return StreamingResponse(
        state.ember.stream(run),
        media_type="application/x-ndjson",
        headers={"x-accel-buffering": "no"},
    )


@router.get("/api/ember/approvals")
async def ember_approvals(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return {"approvals": [a.public() for a in state.ember.approvals.values() if a.session_id == sess.id]}


@router.post("/api/ember/approvals/{aid}")
async def ember_decide(aid: str, body: DecisionIn, sess: SessionDep, state: StateDep) -> dict[str, bool]:
    try:
        state.ember.resolve(aid, sess.id, sess.recently_authenticated(), body.approve, body.typed, body.sudo_password)
    except ApprovalError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code, "message": exc.message}) from exc
    finally:
        body.sudo_password = None
    return {"ok": True}


MAX_AUDIO_BYTES = 8 * 1024 * 1024  # ~10 minutes of browser opus; a voice message is far smaller


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _voice_error(exc: VoiceError) -> HTTPException:
    return HTTPException(exc.status, detail={"code": exc.code, "message": exc.message})


@router.get("/api/ember/voice/status")
async def ember_voice_status(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    voice = state.ember.voice
    return {"stt": voice.stt_installed(), "tts": await voice.tts_available()}


@router.post("/api/ember/voice/transcribe")
async def ember_transcribe(request: Request, sess: SessionDep, state: StateDep) -> dict[str, Any]:
    buf = bytearray()
    async for part in request.stream():
        buf += part
        if len(buf) > MAX_AUDIO_BYTES:
            raise HTTPException(413, detail={"code": "too_large", "message": "That recording is too long"})
    if not buf:
        raise HTTPException(400, detail={"code": "empty", "message": "No audio"})
    try:
        return await state.ember.voice.transcribe(bytes(buf))
    except VoiceError as exc:
        raise _voice_error(exc) from exc


@router.post("/api/ember/voice/speak")
async def ember_speak(body: SpeakIn, sess: SessionDep, state: StateDep) -> Response:
    try:
        audio, media_type = await state.ember.voice.speak(body.text)
    except VoiceError as exc:
        raise _voice_error(exc) from exc
    return Response(audio, media_type=media_type, headers={"cache-control": "no-store"})


@router.get("/api/ember/image/status")
async def ember_image_status(sess: SessionDep, state: StateDep) -> dict[str, Any]:
    return {
        "available": await state.ember.comfy.available(),
        "busy": state.ember.comfy.busy,
        "sizes": {k: list(v) for k, v in SIZES.items()},
        "output_dir": state.config.image.output_dir,
    }
