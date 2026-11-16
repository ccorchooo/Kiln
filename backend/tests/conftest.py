from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from app.config import Config
from app.main import create_app
from app.state import AppState

ORIGIN = "https://kiln.test"
PASSWORD = "correct horse battery"


@pytest.fixture
def config(tmp_path: Path) -> Config:
    cfg = Config()
    cfg.data_dir = str(tmp_path / "data")
    cfg.server.web_root = str(tmp_path / "no-web")
    cfg.files.jail_root = str(tmp_path)
    return cfg


@pytest.fixture
async def app_and_state(config: Config) -> AsyncIterator[tuple[object, AppState]]:
    app = create_app(config)
    async with app.router.lifespan_context(app):
        yield app, app.state.kiln


@pytest.fixture
async def state(app_and_state: tuple[object, AppState]) -> AppState:
    return app_and_state[1]


@pytest.fixture
async def client(app_and_state: tuple[object, AppState]) -> AsyncIterator[httpx.AsyncClient]:
    app, _ = app_and_state
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url=ORIGIN, headers={"origin": ORIGIN}) as c:
        yield c


async def login(client: httpx.AsyncClient, state: AppState, password: str = PASSWORD) -> str:
    """Set the password if needed, sign in, return the CSRF token."""
    if not await state.credentials.is_setup():
        await state.credentials.set_password(PASSWORD)
    r = await client.post("/api/auth/unlock", json={"password": password})
    assert r.status_code == 200, r.text
    return str(r.json()["csrf"])
