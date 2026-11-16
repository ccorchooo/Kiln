# Kiln

A warm, minimal, AI-centered web shell for this CachyOS machine, reachable from any browser on your
Tailscale network. Ember, the local assistant, lives in the orb.

> **Status: Phase 4 of 10.** The terminal is real now; widgets with live metrics arrived in Phase 3.
> Earlier: **Phase 2.** Security core, lock screen, wallpaper and orb, plus the desktop shell
> (taskbar, Spotlight, workspaces with tiling/floating, task view) are done. Apps are placeholders
> until their phases land. See [Roadmap](#roadmap).

## Using the desktop

| Action | How |
|---|---|
| Search apps, windows, settings and actions | `Ctrl+Space` or the magnifier in the center island. `Tab` hands the query to Ember. |
| Task view (all workspaces) | `Ctrl+Alt+Tab` or the grid button. Drag windows between workspaces; drag the numbers to reorder. |
| Previous/next workspace | `Ctrl+Alt+←/→`, a horizontal trackpad swipe, or a touch swipe on a title bar or Home |
| Lock / panic | `Ctrl+Alt+L` / `Ctrl+Alt+Shift+K` |
| Open an app on its own workspace | `Shift`-click or middle-click it in the dock |
| Float or tile a workspace | The window button, or double-click a title bar. Drag a floating window to the screen edge to re-tile it. |

Terminal, Files, Editor, Notes and Logs are *pairable*: opening one while a workspace holds a single
app puts it alongside, split 50/50 with a draggable divider. A workspace never holds more than two apps.
Layout is remembered per device.

## Install

```bash
./install.sh            # install or upgrade (runs as you; asks before any sudo)
./install.sh --rebuild  # force a frontend rebuild
```

The installer does the following:

1. Creates a venv in `~/.local/share/kiln/venv` and installs the backend.
2. Builds the frontend if needed and copies it to `~/.local/share/kiln/web`.
3. Writes `~/.config/kiln/config.toml` (mode 600) from `config.example.toml`.
4. Gets a TLS certificate: `tailscale cert` if Tailscale is up, otherwise a self-signed one.
5. Asks for your password (stored as an Argon2id hash, never in plain text) and offers TOTP 2FA.
6. Offers the ufw rules that restrict the port to `tailscale0`.
7. Installs and starts the systemd **user** service `kiln.service`.

To keep Kiln running when you're logged out, enable lingering once: `loginctl enable-linger $USER`.

Useful commands:

```bash
systemctl --user status kiln       # service state
journalctl --user -u kiln -f       # logs
~/.local/share/kiln/venv/bin/kiln check         # config, bind, TLS, LLM and exposure report
~/.local/share/kiln/venv/bin/kiln set-password  # change password (signs out every session)
~/.local/share/kiln/venv/bin/kiln totp enable   # 2FA (QR shown once in the terminal)
~/.local/share/kiln/venv/bin/kiln audit-verify  # verify the audit log hash chain
```

## HTTPS

Browsers only allow the microphone on a secure context, so Kiln serves HTTPS only.

**Recommended: `tailscale cert`** gives a real, trusted certificate for `<machine>.<tailnet>.ts.net`.

1. In the Tailscale admin console, enable **MagicDNS** and **HTTPS Certificates** (DNS page).
2. One time, let your user fetch certificates: `sudo tailscale set --operator=$USER`
3. Fetch the certificate:
   ```bash
   tailscale cert --cert-file ~/.config/kiln/tls/cert.pem \
                  --key-file  ~/.config/kiln/tls/key.pem  <machine>.<tailnet>.ts.net
   ```
4. Restart Kiln with `systemctl --user restart kiln` and open `https://<machine>.<tailnet>.ts.net:8443`.

Certificates last 90 days, so re-run step 3 to renew. A monthly user timer works well for this.

**Fallback:** `install.sh` generates a self-signed certificate (P-256, 825 days). Each browser asks you
to trust it once.

## Firewall

Kiln binds to `0.0.0.0` by default, as requested. Pair that with a firewall rule so the port is only
reachable over Tailscale. The alternative is `bind = "tailscale"` in `config.toml`, which listens only on
the Tailscale IPv4. Kiln prints a warning at startup if the port is reachable on another interface.

**ufw** (active on this machine):

```bash
sudo ufw allow in on tailscale0 to any port 8443 proto tcp
sudo ufw deny 8443/tcp
```

**nftables** (`/etc/nftables.conf`, inside your `inet filter` `input` chain):

```nft
iifname "tailscale0" tcp dport 8443 accept
tcp dport 8443 drop
```

**firewalld:**

```bash
sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0
sudo firewall-cmd --permanent --zone=trusted --add-port=8443/tcp
sudo firewall-cmd --reload     # and make sure 8443 is NOT open in your default zone
```

## Local AI

Ember talks to any OpenAI-compatible endpoint configured in `[llm]`. The default is the **AXION** router
that `local-ai run` starts at `http://127.0.0.1:11435/v1`, with `qwen3.5:4b`. Voice (Phase 7) uses AXION's
TTS at `:8891` and a local faster-whisper for speech-to-text. Kiln never calls a cloud API unless you
configure one.

## Terminal

The Terminal app runs your login shell (`$SHELL`, zsh here) in a real PTY on the server, as you, never root.

- **Tabs and panes:** each tab can split into two panes, side by side or stacked.
- **Persistence:** reloading the page or switching devices re-attaches to the same shells with their
  recent output (256 KB replay buffer). A shell with nobody attached keeps running for 30 minutes
  (`[terminal] keep_alive_minutes`). Locking keeps shells alive; panic kills them. Closing the Terminal
  window ends its shells.
- **One viewer at a time:** opening the same shell elsewhere moves it there. The old view offers "Use here"
  to take it back.
- **Copy and paste:** copy-on-select, `Ctrl+Shift+C` / `Ctrl+Shift+V`, and a right-click menu.
  `Ctrl+Shift+F` searches.
- **Links:** URLs and paths under your home folder are clickable. Paths open in Files once Phase 5 lands.
- **Ember:** "Explain selection" and "Fix last error" send the text to Ember (Phase 6).
- **Snippets:** the bookmark button holds saved commands, which run in the focused pane with one click.
- **Phone:** an extra key row (Esc, Tab, sticky Ctrl/Alt, arrows, `|`, `~`, `/`).
- **Audit:** every shell's start and end is audited. What you type is never logged; the terminal is your
  direct shell and doesn't go through Ember's approvals.

Fresh zsh shells will show the Powerlevel10k setup wizard until it is configured (`p10k configure`).

## Widgets

Settings → Taskbar (or search "widgets") holds the library: Ember, CPU, GPU, memory, temperatures, disk,
network/Tailscale, clock (seconds, second time zone), weather (Open-Meteo, no key), media, updates,
notifications, battery and uptime. Each can be compact or expanded (with a mini chart) and can be shown on
the lock screen. Widget config lives on the server, so it's the same on every device.

All widgets share one `/ws/metrics` socket. The server samples only the topics someone has subscribed to,
skips GPU queries while every tab is hidden, and throttles hidden tabs to one update every 5 seconds.
**While a session is locked, the server only sends the topics of lock-screen widgets.** It also strips
sensitive fields: the Tailscale IP and exit node, and media titles unless that widget allows them. This
filtering happens on the server, not in the browser.

## Optional tools

Kiln uses these when they're installed and degrades gracefully when they're not:

- **AUR:** `yay` (preferred; set `[packages] aur_helper`) or `paru`
- **Media widget:** `playerctl`. Without it, `/api/media` reports `available: false` along with the
  install command (`sudo pacman -S playerctl`), and the widget shows that hint.
- **Screenshots:** `grim`. **Disk health:** `smartctl`. **Temperatures:** `sensors`. **Search:** `rg`, `fd`.

`GET /api/system/tools` lists which of these are available.

## Security model

- **Never runs as root.** It refuses to start as root. Privileged actions will go through an explicit
  sudo prompt per approval (Phase 6/8), and the sudo password is never stored or logged.
- **Auth:** Argon2id (64 MiB, t=3, p=4) plus optional TOTP with replay protection. Sessions are
  server-side, the cookie holds a random token (`HttpOnly; Secure; SameSite=Strict`), and only its
  SHA-256 is stored. Sessions have idle and absolute expiry, and the token rotates on unlock.
- **CSRF:** every state-changing request needs a same-origin `Origin`/`Referer`, and authenticated
  requests also need the per-session `X-CSRF-Token`. WebSockets check the cookie and `Origin`.
- **Brute force:** per-IP exponential backoff after 3 failures and a hard lockout after 10, persisted
  across restarts. Proxy headers are never trusted.
- **Auto-lock** after 10 idle minutes (configurable). It's enforced by the server, so closing the tab
  doesn't skip it. A locked session can't call any API except unlock, lock, logout and panic.
- **Re-authentication** (password within the last 5 minutes) is required for security settings, 2FA
  changes and the password change. It will also gate DANGER/ROOT approvals and denylisted paths.
- **Panic:** `Ctrl+Alt+Shift+K`, or hold the power button on the desktop, revokes every session and kills
  registered processes (terminals and AI tools as they arrive).
- **Headers:** strict CSP (no inline scripts), HSTS, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, and a `Permissions-Policy` that allows the mic only for Kiln itself.
- **Path jail** (`backend/app/fs/jail.py`) is the single gate for every file endpoint and AI file tool. It
  follows every symlink (including dangling ones), rejects NUL, control and bidi characters, and enforces
  the denylist on both the real and the written path.
- **Audit log:** append-only (SQLite triggers block UPDATE and DELETE) and hash-chained, so `kiln
  audit-verify` detects edits made outside Kiln. Secrets are scrubbed before writing.

Cosmetic settings (theme, light/dark, graphics quality) only need an unlocked session. Security settings
need re-authentication.

## Development

```bash
# backend
cd backend && uv venv .venv && uv pip install -p .venv/bin/python -e '.[dev]'
.venv/bin/pytest            # 94 tests: auth, CSRF, rate limit, sessions, audit, path jail, sun, config, media, metrics, widgets, terminal
.venv/bin/ruff check app tests && .venv/bin/mypy app

# run against a scratch config (doesn't touch ~/.config/kiln)
export KILN_CONFIG_DIR=/tmp/kiln-dev/cfg KILN_DATA_DIR=/tmp/kiln-dev/data
mkdir -p $KILN_CONFIG_DIR/tls && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 30 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
  -keyout $KILN_CONFIG_DIR/tls/key.pem -out $KILN_CONFIG_DIR/tls/cert.pem
.venv/bin/kiln set-password
KILN_SERVER__DEV_CORS_ORIGIN=http://localhost:5173 .venv/bin/kiln serve

# frontend (hot reload, proxies /api and /ws to the backend)
cd frontend && npm install && npm run dev            # http://localhost:5173
npm run typecheck && npm run lint && npm run build

# smoke test against a running server
KILN_URL=https://127.0.0.1:8443 KILN_TEST_PASSWORD='…' npm run e2e
```

## Layout

```
backend/app/
  main.py          app factory, security headers + origin middleware, SPA serving
  config.py        TOML config + KILN_* env overrides
  db.py            SQLite (WAL), versioned migrations
  cli.py           `kiln` command
  auth/            passwords (Argon2id/TOTP), sessions, CSRF guards, rate limiting, routes
  audit/           append-only hash-chained audit log
  fs/jail.py       the path-validation gate
  system/          sunrise/sunset, bind/exposure checks, tool discovery (yay/paru), media (playerctl),
                   metrics collectors + MetricsHub (one shared sampling loop)
  widgets.py       widget config validation, lock-screen filter/sanitizer
  routes_metrics.py  /ws/metrics, snapshot, widget settings
  terminal/        PTY manager (spawn, replay buffer, keep-alive, titles, panic kill)
  routes_terminal.py /api/terminals, /ws/terminal/{id}, /api/snippets
  routes_core.py   appearance, audit API, /ws/events
frontend/src/
  app/             App, LockScreen, PasswordPill
  shell/           window manager store, Strip (Home + workspaces + task view), Window,
                   WorkspacePage (tiling/floating), Taskbar (dock, island, tray), Spotlight, app registry
  apps/            Settings (appearance, dock, taskbar widgets, devices, security); placeholders
  apps/terminal/   xterm.js panes, tabs/splits, snippets, search, key row
  widgets/         widget registry + pill/segment + popovers, metrics socket/store, formatters
  three/           shared canvas: wallpaper shader → composite → orb; OrbAnchor
  theme/           tokens/themes (+ WCAG checker), appearance controller
  lib/             api client, stores, events socket, idle lock
  components/      clock pill, toasts, motion presets
```

## Roadmap

1. ✅ Skeleton, security, lock screen, wallpaper, orb (idle)
2. ✅ Shell: three-pill taskbar, Spotlight, workspaces + tiling WM, task view, lock ↔ desktop collapse
3. ✅ Widgets (14 types), Settings → Taskbar, lock-screen toggles, `/ws/metrics`
4. ✅ Terminal: real PTY over WebSocket, tabs, split panes, persistence, snippets, mobile key row
5. File manager
6. Ember (text): tools, risk classifier, approvals
7. Voice: STT/TTS, full orb states, captions
8. System apps (dashboard, processes, services, packages, logs, network, storage, power)
9. Polish: six themes × light/dark, theme editor, motion, mobile, PWA
10. Extras: automations, clipboard, screenshots, media, notes
