"""Error type shared by the filesystem modules; rendered as {"detail": {code, message, ...}}."""

from __future__ import annotations

from typing import Any

from app.fs.jail import JailError

_JAIL_STATUS = {
    "invalid_path": 400,
    "outside_jail": 403,
    "denied": 403,
    "not_found": 404,
    "too_large": 413,
}


class FsError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def detail(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **self.extra}


def from_jail(exc: JailError) -> FsError:
    return FsError(_JAIL_STATUS.get(exc.code, 400), exc.code, exc.message)
