"""Image generation through AXION's ComfyUI (Z-Image Turbo, single pass).

The workflow is built here in ComfyUI's API format from the model files named in `[image]`,
so it doesn't depend on a UI-format workflow export. Results are copied into the files jail
(`~/Pictures/Kiln` by default) so Files and the previews can open them.
"""

from __future__ import annotations

import asyncio
import random
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from app.config import ImageConfig

ProgressFn = Callable[[str], Awaitable[None]]

SIZES: dict[str, tuple[int, int]] = {
    "square": (1024, 1024),
    "landscape": (1216, 832),
    "portrait": (832, 1216),
    "wide": (1344, 768),
    "tall": (768, 1344),
}
DEFAULT_NEGATIVE = (
    "blurry, low detail, oversmoothed, plastic skin, deformed, bad hands, extra fingers, warped anatomy, "
    "overexposed, underexposed, watermark, text artifacts"
)


class ImageError(Exception):
    pass


def build_graph(cfg: ImageConfig, prompt: str, negative: str, width: int, height: int, seed: int) -> dict[str, Any]:
    return {
        "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": cfg.unet}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": cfg.vae}},
        "3": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": cfg.clip, "type": cfg.clip_type, "device": "default"},
        },
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": cfg.shift}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["3", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["3", 0]}},
        "7": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "8": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": seed,
                "steps": cfg.steps,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "positive": ["5", 0],
                "negative": ["6", 0],
                "latent_image": ["7", 0],
                "denoise": 1.0,
            },
        },
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["2", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "Kiln"}},
    }


def _slug(text: str) -> str:
    words = re.findall(r"[a-zA-Z0-9]+", text.lower())[:6]
    return "-".join(words)[:48] or "image"


class ComfyClient:
    def __init__(self, cfg: ImageConfig) -> None:
        self.cfg = cfg
        self.client_id = uuid.uuid4().hex
        self._lock = asyncio.Lock()  # one job at a time: the GPU is shared
        self._dirty = False  # ComfyUI holds weights in VRAM since the last job
        self._current: str | None = None

    @property
    def base(self) -> str:
        return self.cfg.comfyui_url.rstrip("/")

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    async def available(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as c:
                r = await c.get(f"{self.base}/system_stats")
                return r.status_code == 200
        except httpx.HTTPError:
            return False

    async def free(self) -> None:
        """Release ComfyUI's cached weights so the language model has the GPU. Best effort."""
        if not self._dirty or self.busy:
            return
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                await c.post(f"{self.base}/free", json={"unload_models": True, "free_memory": True})
            self._dirty = False
        except httpx.HTTPError:
            pass

    async def interrupt(self) -> None:
        pid = self._current
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                if pid:
                    await c.post(f"{self.base}/queue", json={"delete": [pid]})
                await c.post(f"{self.base}/interrupt", json={"prompt_id": pid} if pid else {})
        except httpx.HTTPError:
            pass

    async def _check_nodes(self, c: httpx.AsyncClient) -> None:
        try:
            r = await c.get(f"{self.base}/object_info/UnetLoaderGGUF")
        except httpx.ConnectError as exc:
            raise ImageError("ComfyUI isn't running. Start it with `local-ai run`.") from exc
        info = r.json() if r.status_code == 200 else {}
        node = info.get("UnetLoaderGGUF")
        if not node:
            raise ImageError("ComfyUI is missing the GGUF loader node (ComfyUI-GGUF).")
        names = node.get("input", {}).get("required", {}).get("unet_name", [[]])[0]
        if isinstance(names, list) and self.cfg.unet not in names:
            raise ImageError(f"ComfyUI doesn't have the image model {self.cfg.unet}.")

    async def generate(
        self,
        prompt: str,
        dest_dir: Path,
        *,
        size: str = "square",
        negative: str = "",
        seed: int | None = None,
        progress: ProgressFn | None = None,
        before: Callable[[], Awaitable[Any]] | None = None,
    ) -> dict[str, Any]:
        prompt = prompt.strip()
        if not prompt:
            raise ImageError("Describe the image first.")
        width, height = SIZES.get(size, SIZES["square"])
        seed = seed if seed is not None else random.randint(1, 2**48)  # noqa: S311 - not security related
        async with self._lock:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=30.0)) as c:
                await self._check_nodes(c)
                if before is not None:
                    await before()
                graph = build_graph(self.cfg, prompt, negative.strip() or DEFAULT_NEGATIVE, width, height, seed)
                r = await c.post(f"{self.base}/prompt", json={"prompt": graph, "client_id": self.client_id})
                if r.status_code >= 400:
                    raise ImageError(f"ComfyUI rejected the workflow: {r.text[:300]}")
                pid = r.json().get("prompt_id")
                if not pid:
                    raise ImageError("ComfyUI didn't return a job id.")
                self._current = pid
                self._dirty = True
                try:
                    images = await self._wait(c, pid, progress)
                finally:
                    self._current = None
                saved = []
                await asyncio.to_thread(dest_dir.mkdir, parents=True, exist_ok=True)
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                for i, img in enumerate(images):
                    r = await c.get(
                        f"{self.base}/view",
                        params={
                            "filename": img["filename"],
                            "subfolder": img.get("subfolder", ""),
                            "type": img.get("type", "output"),
                        },
                    )
                    r.raise_for_status()
                    suffix = Path(img["filename"]).suffix or ".png"
                    name = f"{stamp}-{_slug(prompt)}{'-' + str(i + 1) if i else ''}{suffix}"
                    target = dest_dir / name
                    await asyncio.to_thread(target.write_bytes, r.content)
                    saved.append(target)
        return {"paths": saved, "seed": seed, "width": width, "height": height}

    async def _wait(self, c: httpx.AsyncClient, pid: str, progress: ProgressFn | None) -> list[dict[str, Any]]:
        deadline = time.monotonic() + self.cfg.timeout_seconds
        last_note = ""
        while time.monotonic() < deadline:
            r = await c.get(f"{self.base}/history/{pid}")
            hist = r.json().get(pid) if r.status_code == 200 else None
            if hist:
                status = hist.get("status") or {}
                if status.get("status_str") == "error":
                    msgs = [
                        m[1].get("exception_message", "")
                        for m in status.get("messages", [])
                        if m[0] == "execution_error"
                    ]
                    raise ImageError(f"ComfyUI failed: {(msgs[0] if msgs else 'unknown error')[:300]}")
                images = [img for out in (hist.get("outputs") or {}).values() for img in out.get("images", [])]
                images = [i for i in images if i.get("type", "output") == "output"]
                if images:
                    return images
                if status.get("completed"):
                    raise ImageError("ComfyUI finished without an image.")
            elif progress is not None:
                q = await c.get(f"{self.base}/queue")
                running = q.json().get("queue_running", []) if q.status_code == 200 else []
                note = "Generating…" if any(len(j) > 1 and j[1] == pid for j in running) else "Waiting for the GPU…"
                if note != last_note:
                    last_note = note
                    await progress(note)
            await asyncio.sleep(0.75)
        await self.interrupt()
        raise ImageError("The image took too long; it was cancelled.")
