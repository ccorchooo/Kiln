"""Host tool discovery. Optional tools degrade gracefully with an install hint."""

from __future__ import annotations

import shutil

INSTALL_HINTS = {
    "playerctl": "sudo pacman -S playerctl",
    "grim": "sudo pacman -S grim",
    "smartctl": "sudo pacman -S smartmontools",
    "sensors": "sudo pacman -S lm_sensors",
    "rg": "sudo pacman -S ripgrep",
    "fd": "sudo pacman -S fd",
    "tailscale": "sudo pacman -S tailscale && sudo systemctl enable --now tailscaled",
}


def which(name: str) -> str | None:
    return shutil.which(name)


def aur_helper(preference: str = "auto") -> str | None:
    """Resolve the AUR helper: an explicit "yay"/"paru" if installed, else yay, then paru."""
    order = [preference] if preference in {"yay", "paru"} else []
    order += [h for h in ("yay", "paru") if h not in order]
    return next((h for h in order if shutil.which(h)), None)


def tool_status(names: list[str]) -> dict[str, dict[str, str | bool | None]]:
    return {
        n: {"available": shutil.which(n) is not None, "path": shutil.which(n), "install": INSTALL_HINTS.get(n)}
        for n in names
    }
