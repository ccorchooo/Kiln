"""Bind-address resolution and exposure warnings."""

from __future__ import annotations

import ipaddress
import socket

import psutil

TAILSCALE_IFACE = "tailscale0"
TAILSCALE_V4 = ipaddress.ip_network("100.64.0.0/10")


def tailscale_ipv4() -> str | None:
    for iface, addrs in psutil.net_if_addrs().items():
        for a in addrs:
            if a.family != socket.AF_INET:
                continue
            ip = ipaddress.ip_address(a.address)
            if iface == TAILSCALE_IFACE or ip in TAILSCALE_V4:
                return str(a.address)
    return None


def resolve_bind(bind: str) -> str:
    if bind == "tailscale":
        ip = tailscale_ipv4()
        if ip is None:
            raise RuntimeError('bind = "tailscale" but no Tailscale IPv4 address was found. Is tailscaled up?')
        return ip
    return bind


def exposure_warnings(host: str, port: int) -> list[str]:
    """Interfaces (other than loopback/Tailscale) where the server is reachable at the socket level."""
    if host not in {"0.0.0.0", "::", ""}:  # noqa: S104
        ip = ipaddress.ip_address(host)
        if ip.is_loopback or ip in TAILSCALE_V4:
            return []
        return [f"Kiln is bound to {host}:{port}, which is not a Tailscale address."]
    exposed: list[str] = []
    for iface, addrs in psutil.net_if_addrs().items():
        if iface == TAILSCALE_IFACE or iface == "lo":
            continue
        for a in addrs:
            if a.family in (socket.AF_INET, socket.AF_INET6):
                addr = a.address.split("%")[0]
                ip = ipaddress.ip_address(addr)
                if ip.is_loopback or ip.is_link_local or ip in TAILSCALE_V4:
                    continue
                exposed.append(f"{iface} ({addr})")
    if not exposed:
        return []
    return [
        f"Port {port} is bound on all interfaces and may be reachable via: {', '.join(exposed)}.",
        "Restrict it to tailscale0 with your firewall (see README → Firewall) or set "
        'server.bind = "tailscale" in config.toml.',
    ]
