"""`kiln` command: serve, set-password, totp, check, audit-verify."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import os
import socket
import subprocess
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path

from app.config import CONFIG_PATH, load_config
from app.state import AppState


def _banner(msg: str) -> None:
    print(f"\033[38;5;173m●\033[0m {msg}")


def _warn(msg: str) -> None:
    print(f"\033[38;5;179m▲ {msg}\033[0m", file=sys.stderr)


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from app.main import create_app
    from app.system.netcheck import exposure_warnings, resolve_bind

    cfg = load_config()
    if os.geteuid() == 0:
        _warn("Refusing to run as root. Run Kiln as your normal user.")
        return 1
    host = resolve_bind(cfg.server.bind)
    cert, key = Path(cfg.server.tls_cert), Path(cfg.server.tls_key)
    if not (cert.is_file() and key.is_file()):
        _warn(f"TLS certificate not found ({cert}). Run install.sh or `kiln cert` first. HTTPS is required.")
        return 1
    for line in exposure_warnings(host, cfg.server.port):
        _warn(line)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    _banner(f"Kiln listening on https://{host}:{cfg.server.port}")
    uvicorn.run(
        create_app(cfg),
        host=host,
        port=cfg.server.port,
        ssl_certfile=str(cert),
        ssl_keyfile=str(key),
        ssl_ciphers="ECDHE+AESGCM:ECDHE+CHACHA20",
        proxy_headers=False,  # never trust X-Forwarded-For; the peer address is what rate limiting uses
        server_header=False,
        log_level="info",
        ws_max_size=8 * 1024 * 1024,
    )
    return 0


async def _with_state[T](fn: Callable[[AppState], Awaitable[T]]) -> T:
    state = AppState.build(load_config())
    await state.db.open()
    try:
        return await fn(state)
    finally:
        await state.db.close()


def cmd_set_password(args: argparse.Namespace) -> int:
    from app.auth.passwords import MIN_PASSWORD_LENGTH

    if args.stdin:
        pw = sys.stdin.readline().rstrip("\n")
    else:
        pw = getpass.getpass("New Kiln password: ")
        if getpass.getpass("Repeat it: ") != pw:
            _warn("Passwords didn't match.")
            return 1
    if len(pw) < MIN_PASSWORD_LENGTH:
        _warn(f"Use at least {MIN_PASSWORD_LENGTH} characters.")
        return 1

    async def run(state: AppState) -> None:
        await state.credentials.set_password(pw)
        killed = await state.sessions.revoke_all()
        await state.audit.record("auth.password_set", actor="cli", sessions_revoked=killed)

    asyncio.run(_with_state(run))
    _banner("Password saved (Argon2id). All existing sessions were signed out.")
    return 0


def cmd_totp(args: argparse.Namespace) -> int:
    import qrcode

    from app.auth.passwords import new_totp_secret, totp_uri, totp_window

    if args.action == "disable":

        async def off(state: AppState) -> None:
            await state.credentials.set_totp(None)
            await state.audit.record("auth.totp_disabled", actor="cli")

        asyncio.run(_with_state(off))
        _banner("Two-factor sign-in disabled.")
        return 0

    async def has_pw(state: AppState) -> bool:
        return await state.credentials.is_setup()

    if not asyncio.run(_with_state(has_pw)):
        _warn("Set a password first: kiln set-password")
        return 1
    secret = new_totp_secret()
    uri = totp_uri(secret)
    qr = qrcode.QRCode(border=1)
    qr.add_data(uri)
    qr.print_ascii(invert=True)
    print(f"\nSecret (if you can't scan): {secret}\n")
    print("This is shown once. Scan it with your authenticator app.")
    for _ in range(3):
        code = input("Enter the 6-digit code to confirm: ").strip()
        if totp_window(secret, code) is not None:

            async def on(state: AppState) -> None:
                await state.credentials.set_totp(secret)
                await state.audit.record("auth.totp_enabled", actor="cli")

            asyncio.run(_with_state(on))
            _banner("Two-factor sign-in enabled.")
            return 0
        _warn("That code didn't match. Check your phone's clock.")
    return 1


def cmd_check(args: argparse.Namespace) -> int:
    from app.system.netcheck import exposure_warnings, resolve_bind, tailscale_ipv4

    cfg = load_config()
    print(f"config:     {CONFIG_PATH} ({'found' if CONFIG_PATH.exists() else 'defaults'})")
    print(f"database:   {cfg.db_path}")
    ts = tailscale_ipv4()
    print(f"tailscale:  {ts or 'not detected'}")
    try:
        host = resolve_bind(cfg.server.bind)
        print(f"bind:       {host}:{cfg.server.port}")
    except RuntimeError as exc:
        _warn(str(exc))
        return 1
    cert = Path(cfg.server.tls_cert)
    if cert.is_file():
        out = subprocess.run(
            ["openssl", "x509", "-noout", "-enddate", "-in", str(cert)], capture_output=True, text=True, check=False
        ).stdout.strip()
        print(f"tls:        {cert} ({out.replace('notAfter=', 'expires ') or 'unreadable'})")
    else:
        _warn(f"tls:        missing ({cert})")
    print(f"llm:        {cfg.llm.base_url} model={cfg.llm.model}")
    with socket.socket() as s:
        s.settimeout(1)
        llm_host = cfg.llm.base_url.split("//", 1)[-1].split("/", 1)[0]
        h, _, p = llm_host.partition(":")
        up = s.connect_ex((h, int(p or 80))) == 0
    print(f"llm up:     {'yes' if up else 'no (start it with `local-ai run`)'}")
    for line in exposure_warnings(host, cfg.server.port):
        _warn(line)
    return 0


def cmd_audit_verify(args: argparse.Namespace) -> int:
    async def run(state: AppState) -> tuple[bool, int | None]:
        return await state.audit.verify()

    ok, bad = asyncio.run(_with_state(run))
    if ok:
        _banner("Audit log chain is intact.")
        return 0
    _warn(f"Audit log chain is broken at entry {bad}.")
    return 2


def cmd_has_password(args: argparse.Namespace) -> int:
    async def run(state: AppState) -> bool:
        return await state.credentials.is_setup()

    return 0 if asyncio.run(_with_state(run)) else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="kiln", description="Kiln web shell")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve", help="run the server").set_defaults(fn=cmd_serve)
    sp = sub.add_parser("set-password", help="set or change the sign-in password")
    sp.add_argument("--stdin", action="store_true", help="read the password from stdin")
    sp.set_defaults(fn=cmd_set_password)
    tp = sub.add_parser("totp", help="enable or disable two-factor sign-in")
    tp.add_argument("action", choices=["enable", "disable"])
    tp.set_defaults(fn=cmd_totp)
    sub.add_parser("check", help="show config, bind, TLS and exposure status").set_defaults(fn=cmd_check)
    sub.add_parser("has-password", help="exit 0 if a password is set (for scripts)").set_defaults(fn=cmd_has_password)
    sub.add_parser("audit-verify", help="verify the audit log hash chain").set_defaults(fn=cmd_audit_verify)
    args = p.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    raise SystemExit(main())
