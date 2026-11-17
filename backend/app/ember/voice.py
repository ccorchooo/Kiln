"""Ember's voice: speech-to-text with a local faster-whisper, text-to-speech through AXION's TTS.

Whisper runs on the CPU (int8) so it never fights the language model for the shared GPU.
The model loads on the first transcription and stays in memory.
"""

from __future__ import annotations

import asyncio
import io
from typing import Any

import httpx

from app.config import VoiceConfig


class VoiceError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class Voice:
    def __init__(self, cfg: VoiceConfig) -> None:
        self.cfg = cfg
        self._model: Any = None
        self._lock = asyncio.Lock()  # one transcription at a time; whisper is CPU-bound

    @property
    def tts_base(self) -> str:
        return self.cfg.tts_base_url.rstrip("/")

    @staticmethod
    def stt_installed() -> bool:
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return False
        return True

    async def tts_available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as c:
                return (await c.get(f"{self.tts_base}/audio/voices")).status_code == 200
        except httpx.HTTPError:
            return False

    def _transcribe_sync(self, audio: bytes) -> dict[str, Any]:
        if self._model is None:
            from faster_whisper import WhisperModel

            self._model = WhisperModel(self.cfg.stt_model, device="cpu", compute_type="int8")
        segments, info = self._model.transcribe(io.BytesIO(audio), vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language}

    async def transcribe(self, audio: bytes) -> dict[str, Any]:
        if not self.stt_installed():
            raise VoiceError(503, "stt_unavailable", "Speech input needs faster-whisper (reinstall Kiln).")
        async with self._lock:
            try:
                return await asyncio.to_thread(self._transcribe_sync, audio)
            except Exception as exc:  # undecodable audio, model download failure…
                raise VoiceError(422, "stt_failed", f"Couldn't transcribe that: {exc}"[:300]) from exc

    async def speak(self, text: str) -> tuple[bytes, str]:
        payload = {"model": "axion-tts", "input": text, "voice": self.cfg.tts_voice, "response_format": "mp3"}
        try:
            # The first request loads the TTS engine, which can take a while.
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=180.0)) as c:
                r = await c.post(f"{self.tts_base}/audio/speech", json=payload)
        except httpx.ConnectError as exc:
            msg = "Voice output isn't running. Start it with `local-ai run`."
            raise VoiceError(503, "tts_unavailable", msg) from exc
        except httpx.HTTPError as exc:
            raise VoiceError(502, "tts_failed", "The voice server didn't answer.") from exc
        if r.status_code >= 400:
            raise VoiceError(502, "tts_failed", f"The voice server refused: {r.text[:200]}")
        return r.content, r.headers.get("content-type", "audio/mpeg")
