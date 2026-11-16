"""Argon2id password hashing and TOTP."""

from __future__ import annotations

import time

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

# RFC 9106 second recommended option (memory-constrained): 64 MiB, t=3, p=4.
_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4, hash_len=32, salt_len=16)
# Used when no credentials exist, so a missing account costs the same time as a wrong password.
_DUMMY_HASH = _hasher.hash("kiln-dummy-password-for-constant-time")

MIN_PASSWORD_LENGTH = 10


def hash_password(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    return _hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    """Constant-time-ish verification; always runs one Argon2 verify."""
    try:
        return _hasher.verify(stored_hash or _DUMMY_HASH, password) and stored_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)


def new_totp_secret() -> str:
    return pyotp.random_base32(32)


def totp_uri(secret: str, account: str = "augus", issuer: str = "Kiln") -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=account, issuer_name=issuer)


def totp_window(secret: str, code: str, now: float | None = None) -> int | None:
    """Return the matching 30s time-step (±1 drift) or None. Caller enforces single use."""
    code = code.strip().replace(" ", "")
    if not (code.isdigit() and len(code) == 6):
        return None
    totp = pyotp.TOTP(secret)
    now = time.time() if now is None else now
    step = int(now // totp.interval)
    for delta in (0, -1, 1):
        candidate = step + delta
        if pyotp.utils.strings_equal(totp.at(candidate * totp.interval), code):
            return candidate
    return None
