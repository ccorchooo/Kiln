"""Configuration: TOML file at ~/.config/kiln/config.toml with KILN_* env overrides.

Env override format: KILN_<SECTION>__<KEY>=value (e.g. KILN_SERVER__PORT=9443).
Secrets (password hash, TOTP secret) never live here; they are in the database.
"""

from __future__ import annotations

import dataclasses
import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, get_type_hints

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("KILN_CONFIG_DIR", HOME / ".config" / "kiln"))
DATA_DIR = Path(os.environ.get("KILN_DATA_DIR", HOME / ".local" / "share" / "kiln"))
CONFIG_PATH = Path(os.environ.get("KILN_CONFIG", CONFIG_DIR / "config.toml"))


@dataclass
class ServerConfig:
    port: int = 8443
    # "0.0.0.0", "tailscale" (auto-bind to the Tailscale IPv4 only), or a literal IP.
    bind: str = "0.0.0.0"  # noqa: S104 - requested default; see firewall docs and exposure warning
    tls_cert: str = str(CONFIG_DIR / "tls" / "cert.pem")
    tls_key: str = str(CONFIG_DIR / "tls" / "key.pem")
    # Origins allowed for state-changing requests and WebSockets, in addition to the
    # request's own Host. Example: ["https://cachy.tail1234.ts.net:8443"]
    extra_origins: list[str] = field(default_factory=list)
    web_root: str = ""  # built frontend; empty = auto-detect
    dev_cors_origin: str = ""  # e.g. "https://localhost:5173" for vite dev only


@dataclass
class AuthConfig:
    session_idle_hours: float = 12.0
    session_absolute_days: float = 7.0
    idle_lock_minutes: float = 10.0  # 0 disables auto-lock
    reauth_window_minutes: float = 5.0
    lockout_threshold: int = 10  # failures per IP before hard lockout
    lockout_minutes: float = 15.0
    backoff_after: int = 3  # failures before exponential backoff starts


@dataclass
class UserConfig:
    display_name: str = "Augusto"
    assistant_name: str = "Ember"


@dataclass
class LocationConfig:
    city: str = "Buenos Aires"
    latitude: float = -34.6037
    longitude: float = -58.3816
    timezone: str = "America/Argentina/Buenos_Aires"


@dataclass
class AppearanceConfig:
    theme: str = "clay"
    mode: str = "auto"  # auto | light | dark
    # auto mode source: "sun" (sunrise/sunset from location) or "fixed"
    auto_source: str = "sun"
    light_at: str = "07:00"
    dark_at: str = "19:30"
    quality: str = "auto"  # auto | high | balanced | low | off


@dataclass
class LLMConfig:
    base_url: str = "http://127.0.0.1:11435/v1"  # AXION router (local-ai run)
    model: str = "qwen3.5:4b"
    api_key: str = "axion-local"
    context_length: int = 16384
    temperature: float = 0.7
    # Release the router's loaded model before an image job (the GPU is shared with ComfyUI).
    unload_for_images: bool = True
    max_tool_rounds: int = 8


@dataclass
class ImageConfig:
    comfyui_url: str = "http://127.0.0.1:8188"  # AXION's ComfyUI (local-ai run)
    output_dir: str = "~/Pictures/Kiln"  # inside the files jail, so Files can open the results
    unet: str = "z-image-turbo-Q5_K_M.gguf"
    vae: str = "ae.safetensors"
    clip: str = "qwen_3_4b_fp8_mixed.safetensors"
    clip_type: str = "lumina2"
    steps: int = 10
    shift: float = 3.0
    timeout_seconds: float = 300.0


@dataclass
class VoiceConfig:
    stt_model: str = "small"
    tts_base_url: str = "http://127.0.0.1:8891/v1"  # AXION TTS (OpenAI-compatible)
    tts_voice: str = ""
    wake_word: bool = False


@dataclass
class FilesConfig:
    jail_root: str = str(HOME)
    denylist: list[str] = field(
        default_factory=lambda: [
            "~/.ssh",
            "~/.gnupg",
            "~/.password-store",
            "~/.local/share/keyrings",
            "~/.mozilla",
            "~/.config/google-chrome",
            "~/.config/chromium",
            "~/.config/BraveSoftware",
            "~/.config/kiln",
            "~/.local/share/kiln",
            "**/.env",
            "**/.env.*",
        ]
    )
    max_read_bytes: int = 10 * 1024 * 1024


@dataclass
class ApprovalConfig:
    safe: str = "auto"  # auto | tap
    change: str = "tap"  # tap | typed
    danger: str = "typed"
    root: str = "typed"
    timeout_minutes: float = 30.0


@dataclass
class PackagesConfig:
    aur_helper: str = "yay"  # yay | paru | auto (yay, then paru)


@dataclass
class TerminalConfig:
    shell: str = ""  # empty = $SHELL, then the passwd shell, then /bin/bash
    keep_alive_minutes: float = 30.0  # detached terminals are killed after this long
    max_sessions: int = 16
    scrollback_bytes: int = 262144


@dataclass
class FeatureFlags:
    automations: bool = False
    clipboard: bool = False
    screenshots: bool = False
    media: bool = False
    notes: bool = False


@dataclass
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    user: UserConfig = field(default_factory=UserConfig)
    location: LocationConfig = field(default_factory=LocationConfig)
    appearance: AppearanceConfig = field(default_factory=AppearanceConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)
    image: ImageConfig = field(default_factory=ImageConfig)
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    files: FilesConfig = field(default_factory=FilesConfig)
    approvals: ApprovalConfig = field(default_factory=ApprovalConfig)
    packages: PackagesConfig = field(default_factory=PackagesConfig)
    features: FeatureFlags = field(default_factory=FeatureFlags)
    terminal: TerminalConfig = field(default_factory=TerminalConfig)
    data_dir: str = str(DATA_DIR)

    @property
    def db_path(self) -> Path:
        return Path(self.data_dir) / "kiln.db"


def _coerce(value: str, typ: Any) -> Any:
    if typ is bool:
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if typ is int:
        return int(value)
    if typ is float:
        return float(value)
    if typ == list[str]:
        return [v.strip() for v in value.split(",") if v.strip()]
    return value


def _apply(section: Any, values: dict[str, Any], where: str) -> None:
    hints = get_type_hints(type(section))
    for key, val in values.items():
        if key not in hints:
            raise ValueError(f"Unknown config key: {where}.{key}")
        current = getattr(section, key)
        if dataclasses.is_dataclass(current):
            if not isinstance(val, dict):
                raise ValueError(f"Config section {where}.{key} must be a table")
            _apply(current, val, f"{where}.{key}")
            continue
        typ = hints[key]
        if typ is float and isinstance(val, int):
            val = float(val)
        ok = isinstance(val, list) if typ == list[str] else isinstance(val, typ)
        if not ok or (typ is int and isinstance(val, bool)):
            raise ValueError(f"Config {where}.{key}: expected {typ}, got {type(val).__name__}")
        setattr(section, key, val)


def load_config(path: Path | None = None, env: dict[str, str] | None = None) -> Config:
    cfg = Config()
    path = path or CONFIG_PATH
    if path.exists():
        with path.open("rb") as fh:
            _apply(cfg, tomllib.load(fh), "config")
    source: Mapping[str, str] = os.environ if env is None else env
    for name, raw in source.items():
        if not name.startswith("KILN_") or "__" not in name:
            continue
        sect_name, key = name[5:].lower().split("__", 1)
        sect = getattr(cfg, sect_name, None)
        if sect is None or not dataclasses.is_dataclass(sect):
            continue
        hints = get_type_hints(type(sect))
        if key in hints:
            setattr(sect, key, _coerce(raw, hints[key]))
    for attr in ("tls_cert", "tls_key", "web_root"):
        val = getattr(cfg.server, attr)
        if val:
            setattr(cfg.server, attr, os.path.expanduser(val))
    cfg.data_dir = os.path.expanduser(cfg.data_dir)
    cfg.files.jail_root = os.path.expanduser(cfg.files.jail_root)
    cfg.image.output_dir = os.path.expanduser(cfg.image.output_dir)
    if cfg.appearance.mode not in {"auto", "light", "dark"}:
        raise ValueError("appearance.mode must be auto, light or dark")
    return cfg
