"""Server-side risk classification for Ember's tool calls.

Tiers, lowest to highest: SAFE (read-only), CHANGE (modifies your files or user state),
DANGER (destroys data, kills processes, stops services, or can't be undone), ROOT (needs sudo).
The classifier is deliberately conservative: anything it doesn't recognise is at least CHANGE,
and a shell line is as risky as its riskiest part.
"""

from __future__ import annotations

import re
import shlex
from enum import IntEnum


class Risk(IntEnum):
    SAFE = 0
    CHANGE = 1
    DANGER = 2
    ROOT = 3

    @property
    def label(self) -> str:
        return self.name.lower()


ROOT_CMDS = {"sudo", "doas", "pkexec", "su", "run0"}

SAFE_CMDS = {
    "ls",
    "cat",
    "head",
    "tail",
    "less",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "fd",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "column",
    "df",
    "du",
    "free",
    "uptime",
    "ps",
    "pgrep",
    "uname",
    "whoami",
    "id",
    "date",
    "pwd",
    "echo",
    "printf",
    "which",
    "whereis",
    "type",
    "file",
    "stat",
    "realpath",
    "readlink",
    "basename",
    "dirname",
    "lsblk",
    "lscpu",
    "lsusb",
    "lspci",
    "lsmod",
    "nvidia-smi",
    "sensors",
    "hostname",
    "hostnamectl",
    "timedatectl",
    "journalctl",
    "ip",
    "ss",
    "ping",
    "dig",
    "host",
    "nslookup",
    "tree",
    "md5sum",
    "sha256sum",
    "sha1sum",
    "diff",
    "cmp",
    "jq",
    "true",
    "false",
    "test",
    "[",
    "env",
    "printenv",
    "locale",
    "fastfetch",
    "neofetch",
    "inxi",
    "btop",
    "top",
    "checkupdates",
    "tailscale",
    "playerctl",
    "findmnt",
    "mount",
    "loginctl",
    "w",
    "who",
    "last",
    "groups",
    "getent",
    "nproc",
    "vmstat",
    "iostat",
    "dmesg",
    "zcat",
    "xxd",
    "hexdump",
    "strings",
    "seq",
    "sleep",
    "awk",
    "sed",
    "find",
    "git",
    "pacman",
    "yay",
    "paru",
    "systemctl",
    "flatpak",
    "docker",
    "podman",
    "npm",
    "pip",
    "python",
    "python3",
    "node",
    "cargo",
    "uv",
}

# Always destructive or disruptive, whatever the arguments.
DANGER_CMDS = {
    "rm",
    "rmdir",
    "shred",
    "dd",
    "mkfs",
    "wipefs",
    "fdisk",
    "sfdisk",
    "parted",
    "gdisk",
    "kill",
    "pkill",
    "killall",
    "shutdown",
    "reboot",
    "poweroff",
    "halt",
    "truncate",
    "srm",
    "unlink",
    "mkswap",
    "swapoff",
    "cryptsetup",
    "losetup",
    "blkdiscard",
    "chattr",
    "snapper",
    "btrfs",
}

READ_SUBCOMMANDS = {
    "git": {
        "status",
        "log",
        "diff",
        "show",
        "branch",
        "remote",
        "rev-parse",
        "describe",
        "blame",
        "ls-files",
        "shortlog",
        "tag",
        "config",
        "reflog",
        "grep",
    },
    "systemctl": {
        "status",
        "list-units",
        "list-unit-files",
        "list-timers",
        "is-active",
        "is-enabled",
        "is-failed",
        "show",
        "cat",
        "list-dependencies",
        "--failed",
        "get-default",
    },
    "tailscale": {"status", "ip", "netcheck", "version", "whois", "ping"},
    "docker": {"ps", "images", "logs", "inspect", "version", "info", "stats"},
    "podman": {"ps", "images", "logs", "inspect", "version", "info", "stats"},
    "flatpak": {"list", "info", "search", "remotes", "history"},
    "playerctl": {"status", "metadata", "-l", "--list-all", "position", "volume"},
    "npm": {"ls", "list", "view", "outdated", "--version", "-v"},
    "pip": {"list", "show", "freeze", "--version"},
    "cargo": {"--version", "tree", "metadata"},
    "uv": {"--version", "pip"},
    "ip": {"a", "addr", "address", "r", "route", "link", "neigh", "-br", "-c", "-4", "-6", "-s"},
    "hostnamectl": {"status"},
    "timedatectl": {"status", "show"},
    "loginctl": {"list-sessions", "show-session", "session-status", "show-user", "user-status"},
}

DANGER_SUBCOMMANDS = {
    "systemctl": {
        "stop",
        "disable",
        "mask",
        "kill",
        "isolate",
        "poweroff",
        "reboot",
        "halt",
        "suspend",
        "hibernate",
        "restart",
        "reset-failed",
        "daemon-reexec",
    },
    "git": {"clean", "filter-branch", "gc", "prune"},
    "docker": {"rm", "rmi", "prune", "kill", "stop", "system", "volume"},
    "podman": {"rm", "rmi", "prune", "kill", "stop", "system", "volume"},
    "crontab": {"-r"},
    "flatpak": {"uninstall", "remove"},
}

PKG_QUERY = re.compile(r"^-(Q|S[si]|F)[a-zA-Z]*$")  # pacman -Q*, -Ss, -Si, -F*
PKG_REMOVE = re.compile(r"^-R[a-zA-Z]*$")
SEPARATORS = re.compile(r"\|\||&&|;|\|&?|(?<![>&])&(?!>)|\n")
SUBST = re.compile(r"\$\(|`|<\(|>\(")
WRITE_REDIRECT = re.compile(r"(?<![0-9<])>{1,2}\s*(?!&|/dev/null\b)(\S+)|\d>{1,2}\s*(?!&|/dev/null\b)(\S+)")


def _git_danger(args: list[str]) -> bool:
    sub = args[0] if args else ""
    if sub == "push" and any(a in {"-f", "--force", "--force-with-lease", "--delete", "-d"} for a in args):
        return True
    if sub == "reset" and "--hard" in args:
        return True
    if sub == "branch" and any(a in {"-D", "--delete", "-d"} for a in args):
        return True
    if sub == "checkout" and any(a in {"--", "-f", "--force", "."} for a in args):
        return True
    if sub == "restore" or (sub == "stash" and any(a in {"drop", "clear"} for a in args)):
        return True
    return sub in DANGER_SUBCOMMANDS["git"]


def _first_sub(args: list[str]) -> str:
    """First argument that isn't an option, e.g. `systemctl --user stop x` -> stop."""
    for a in args:
        if a in {"--user", "--system", "--no-pager", "-q", "--quiet", "--global", "-a", "--all"}:
            continue
        return a
    return ""


def classify_segment(words: list[str]) -> tuple[Risk, str]:
    """Classify one simple command (already split into words, env assignments allowed)."""
    while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        words = words[1:]
    if not words:
        return Risk.SAFE, ""
    cmd = words[0].rsplit("/", 1)[-1]
    args = words[1:]

    if cmd in ROOT_CMDS:
        return Risk.ROOT, f"{cmd} runs as root"
    if cmd in {
        "eval",
        "exec",
        "source",
        ".",
        "xargs",
        "nohup",
        "setsid",
        "timeout",
        "nice",
        "ionice",
        "watch",
        "time",
        "command",
        "builtin",
        "stdbuf",
    }:
        inner = [a for a in args if not a.startswith("-")]
        if cmd == "timeout" and inner:
            inner = inner[1:]
        if cmd in {"eval", "source", "."}:
            return Risk.CHANGE, f"{cmd} runs code Kiln can't inspect"
        if inner:
            r, why = classify_segment(inner)
            return max(r, Risk.CHANGE), why or f"runs {inner[0]}"
        return Risk.CHANGE, f"{cmd} runs other commands"
    if cmd in {"bash", "sh", "zsh", "fish", "dash"}:
        if "-c" in args:
            i = args.index("-c")
            if i + 1 < len(args):
                r, why = classify_line(args[i + 1])
                return max(r, Risk.CHANGE), why
        return Risk.CHANGE, "starts a shell"
    if cmd in {"python", "python3", "node", "perl", "ruby"} and any(a in {"-c", "-e"} for a in args):
        return Risk.CHANGE, f"runs inline {cmd} code"
    if cmd in DANGER_CMDS or cmd.startswith("mkfs."):
        return Risk.DANGER, f"{cmd} can destroy data or stop processes"
    if cmd == "find":
        if any(a in {"-delete", "-exec", "-execdir", "-ok", "-okdir"} for a in args):
            exec_at = next((i for i, a in enumerate(args) if a in {"-exec", "-execdir", "-ok", "-okdir"}), None)
            if "-delete" in args:
                return Risk.DANGER, "find -delete removes files"
            if exec_at is not None:
                inner = []
                for a in args[exec_at + 1 :]:
                    if a in {";", "+", "\\;"}:
                        break
                    inner.append(a)
                r, why = classify_segment(inner)
                return max(r, Risk.CHANGE), why or "find -exec runs commands"
        return Risk.SAFE, ""
    if cmd in {"chmod", "chown", "chgrp"}:
        recursive = any(a in {"-R", "--recursive"} or (a.startswith("-") and "R" in a) for a in args)
        if recursive:
            return Risk.DANGER, f"recursive {cmd}"
        return Risk.CHANGE, f"{cmd} changes permissions"
    if cmd == "mv" or cmd == "cp":
        if any(a in {"-f", "--force"} or (a.startswith("-") and not a.startswith("--") and "f" in a) for a in args):
            return Risk.DANGER, f"{cmd} -f overwrites without asking"
        return Risk.CHANGE, f"{cmd} changes files"
    if cmd == "git":
        if _git_danger(args):
            return Risk.DANGER, "git operation that discards or rewrites work"
        sub = _first_sub(args)
        if sub in READ_SUBCOMMANDS["git"] and not (
            sub in {"branch", "tag", "config", "remote"} and len(args) > 1 and not args[1].startswith("-")
        ):
            return Risk.SAFE, ""
        return Risk.CHANGE, "git changes the repository"
    if cmd in {"pacman", "yay", "paru"}:
        flags = [a for a in args if a.startswith("-")]
        if any(PKG_REMOVE.match(f) for f in flags):
            return (Risk.ROOT if cmd == "pacman" else Risk.DANGER), "removes packages"
        if (
            flags
            and all(PKG_QUERY.match(f) or f.startswith("--") for f in flags)
            and any(PKG_QUERY.match(f) for f in flags)
        ):
            return Risk.SAFE, ""
        if cmd == "pacman":
            return Risk.ROOT, "pacman changes system packages"
        return Risk.CHANGE, f"{cmd} installs or upgrades packages (asks for sudo itself)"
    if cmd == "systemctl":
        sub = _first_sub(args)
        user = "--user" in args
        if not sub or sub in READ_SUBCOMMANDS["systemctl"]:
            return Risk.SAFE, ""
        if not user:
            return Risk.ROOT, "changes a system service"
        if sub in DANGER_SUBCOMMANDS["systemctl"]:
            return Risk.DANGER, f"systemctl {sub} stops or disables a service"
        return Risk.CHANGE, f"systemctl --user {sub}"
    if cmd == "journalctl":
        if any(a.startswith("--vacuum") or a in {"--rotate", "--flush"} for a in args):
            return Risk.DANGER, "deletes journal data"
        return Risk.SAFE, ""
    if cmd == "sed":
        if any(a == "-i" or a.startswith("-i") or a.startswith("--in-place") for a in args):
            return Risk.CHANGE, "sed -i edits files in place"
        return Risk.SAFE, ""
    if cmd == "awk" and any("system(" in a or ">" in a for a in args):
        return Risk.CHANGE, "awk script runs commands or writes files"
    if cmd == "tee":
        return Risk.CHANGE, "tee writes files"
    if cmd in {"curl", "wget"}:
        if any(a in {"-o", "-O", "--output", "--remote-name"} for a in args) or cmd == "wget":
            return Risk.CHANGE, "downloads a file"
        if any(a in {"-X", "--request", "-d", "--data", "-F", "--form", "-T", "--upload-file"} for a in args):
            return Risk.CHANGE, "sends data to a server"
        return Risk.SAFE, ""
    if cmd == "crontab":
        if "-r" in args:
            return Risk.DANGER, "crontab -r deletes every cron job"
        if "-l" in args:
            return Risk.SAFE, ""
        return Risk.CHANGE, "edits cron jobs"
    if cmd in READ_SUBCOMMANDS and cmd not in {"git", "systemctl"}:
        sub = _first_sub(args)
        if not sub or sub in READ_SUBCOMMANDS[cmd]:
            return Risk.SAFE, ""
        if sub in DANGER_SUBCOMMANDS.get(cmd, set()):
            return Risk.DANGER, f"{cmd} {sub}"
        return Risk.CHANGE, f"{cmd} {sub}"
    if cmd in {"python", "python3", "node", "npm", "pip", "cargo", "uv"}:
        return Risk.CHANGE, f"runs {cmd}"
    if cmd in SAFE_CMDS:
        if cmd == "dmesg" and any(a in {"-c", "-C", "--clear", "--read-clear"} for a in args):
            return Risk.DANGER, "clears the kernel log"
        if cmd == "tailscale":
            return Risk.CHANGE, "changes Tailscale"
        return Risk.SAFE, ""
    return Risk.CHANGE, f"{cmd} isn't on Kiln's read-only list"


def _split_words(segment: str) -> list[str]:
    try:
        return shlex.split(segment, comments=True)
    except ValueError:
        return segment.split()


def classify_line(line: str) -> tuple[Risk, str]:
    """Classify a full shell line: the maximum over its pipeline/list parts and redirections."""
    text = line.strip()
    if not text:
        return Risk.SAFE, ""
    risk, reason = Risk.SAFE, ""

    def bump(r: Risk, why: str) -> None:
        nonlocal risk, reason
        if r > risk:
            risk, reason = r, why

    if re.search(r":\(\)\s*\{", text):
        bump(Risk.DANGER, "fork bomb")
    if SUBST.search(text):
        bump(Risk.CHANGE, "command substitution Kiln can't fully inspect")
        for inner in re.findall(r"\$\(([^()]*)\)|`([^`]*)`", text):
            r, why = classify_line(inner[0] or inner[1])
            bump(r, why)
    for m in WRITE_REDIRECT.finditer(text):
        target = m.group(1) or m.group(2) or ""
        if target.startswith("/dev/sd") or target.startswith("/dev/nvme") or target.startswith("/etc/"):
            bump(Risk.DANGER, f"writes to {target}")
        else:
            bump(Risk.CHANGE, f"writes to {target}")
    if re.search(r"\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b", text):
        bump(Risk.DANGER, "pipes downloaded or generated text into a shell")
    for part in SEPARATORS.split(text):
        words = _split_words(part)
        if words:
            r, why = classify_segment(words)
            bump(r, why)
    return risk, reason
