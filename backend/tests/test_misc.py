from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.config import AppearanceConfig, LocationConfig, load_config
from app.system.sun import appearance_now, sun_times


def test_buenos_aires_sun_times() -> None:
    rise, set_ = sun_times(date(2026, 11, 16), LocationConfig())
    assert rise and set_
    # NOAA solar calculator: sunrise 05:39, sunset 19:37 local (UTC-3)
    assert abs((rise - datetime(2026, 11, 16, 8, 39, 30, tzinfo=UTC)).total_seconds()) < 120
    assert abs((set_ - datetime(2026, 11, 16, 22, 37, tzinfo=UTC)).total_seconds()) < 120


def test_appearance_auto_and_manual() -> None:
    loc, app = LocationConfig(), AppearanceConfig()
    noon = datetime(2026, 11, 16, 15, 0, tzinfo=UTC)  # 12:00 local
    midnight = datetime(2026, 11, 17, 3, 0, tzinfo=UTC)
    assert appearance_now(app, loc, now=noon)["mode"] == "light"
    assert appearance_now(app, loc, now=midnight)["mode"] == "dark"
    assert appearance_now(app, loc, now=noon)["next_switch"] is not None
    assert appearance_now(app, loc, override="dark", now=noon)["mode"] == "dark"
    fixed = AppearanceConfig(auto_source="fixed", light_at="07:00", dark_at="19:30")
    assert appearance_now(fixed, loc, now=datetime(2026, 11, 16, 23, 0, tzinfo=UTC))["mode"] == "dark"


def test_config_file_and_env(tmp_path: Path) -> None:
    p = tmp_path / "c.toml"
    p.write_text('[server]\nport = 9000\nbind = "tailscale"\n[llm]\nmodel = "x"\n')
    cfg = load_config(p, env={"KILN_SERVER__PORT": "9443", "KILN_AUTH__IDLE_LOCK_MINUTES": "3"})
    assert cfg.server.port == 9443 and cfg.server.bind == "tailscale"
    assert cfg.llm.model == "x" and cfg.auth.idle_lock_minutes == 3.0


def test_config_rejects_unknown_and_bad_types(tmp_path: Path) -> None:
    p = tmp_path / "c.toml"
    p.write_text("[server]\nprot = 1\n")
    with pytest.raises(ValueError, match="Unknown"):
        load_config(p, env={})
    p.write_text('[server]\nport = "x"\n')
    with pytest.raises(ValueError, match="expected"):
        load_config(p, env={})


def test_example_config_loads() -> None:
    example = Path(__file__).resolve().parents[2] / "config.example.toml"
    cfg = load_config(example, env={})
    assert cfg.server.port == 8443
    assert not cfg.server.tls_cert.startswith("~")
    assert cfg.llm.base_url.endswith(":11435/v1")
