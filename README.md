# Kiln

A warm, minimal, AI-centered web shell for this CachyOS machine, reachable from any browser on your
Tailscale network. Ember, the local assistant, lives in the orb.

> **Status: Phase 8 of 10.** The System app (live overview, processes, services, packages, network, storage,
> power) and a live Logs app are in. Phase 7 gave Ember a voice: talk to it with the mic or `Ctrl+Alt+Space`,
> hear replies spoken by AXION's TTS, with captions under the orb. Phase 6 brought chat with tools, approvals, image generation
> and a model picker, in a sidebar the orb opens. Files, previews and the editor arrived in Phase 5, the terminal
> in Phase 4, widgets in Phase 3. Earlier: **Phase 2.** Security core, lock screen, wallpaper and orb, plus the desktop shell
> (taskbar, Spotlight, workspaces with tiling/floating, task view) are done. Apps are placeholders
> until their phases land. See [Roadmap](#roadmap).

## Using the desktop

| Action | How |
|---|---|
| Talk to Ember | Click the orb on Home (or Ember in the dock or widget). The sidebar docks on the right and the desktop shrinks beside it; `Esc` closes it. The window button pops Ember out as a normal app. |
| Search apps, windows, settings and actions | `Ctrl+Space` or the magnifier in the center island. `Tab` hands the query to Ember. |
| Task view (all workspaces) | `Ctrl+Alt+Tab` or the grid button. Drag windows between workspaces; drag the numbers to reorder. |
| Previous/next workspace | `Ctrl+Alt+←/→`, a horizontal trackpad swipe, or a touch swipe on a title bar or Home |
| Speak to Ember | The mic in Ember's composer, or `Ctrl+Alt+Space` anywhere. It stops by itself when you pause; press again to stop early. |
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
./install.sh --preview  # try it without installing (see below)
./install.sh --uninstall  # remove Kiln, keep your data and settings
./install.sh --purge    # remove Kiln and delete your data, settings and certificates
```

**Preview** runs Kiln from one temporary folder with a random port, a throwaway certificate and a generated
password (printed in the terminal), reachable only from this machine at `https://127.0.0.1:<port>`, so it needs
no setup, firewall or service. Files only sees an empty sandbox folder; Terminal and Ember commands still run
as you. Ctrl+C or closing the terminal stops it and deletes the folder. It reuses an installed or repo Python
environment when one exists (otherwise it builds one inside the temp folder).

**Uninstall** stops and removes the systemd user service, deletes the app (venv and web build) and undoes the
firewall rules and Tailscale operator rights the installer added, asking before each `sudo` step. `--purge`
also deletes `~/.local/share/kiln` (password, chats, audit log), `~/.config/kiln` (settings, certificates) and,
if you agree, the speech model Kiln downloaded. Your images in `~/Pictures/Kiln`, your Trash and this
repository are never touched.

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

## Ember

Ember talks to any OpenAI-compatible endpoint configured in `[llm]`. The default is the **AXION** router
that `local-ai run` starts at `http://127.0.0.1:11435/v1`. Voice uses AXION's TTS at `:8891` and a local
faster-whisper for speech-to-text. Kiln never calls a cloud API unless you configure one.

- **Sidebar:** the orb on Home docks Ember on the right; the whole desktop shrinks into a rounded card
  beside it (a full-screen sheet on phones). The window button in its header opens Ember as a normal app
  window and closes the sidebar; the panel button there docks it back. Chats are kept on the server; the
  clock button lists them, the pen starts a new one. Spotlight, Files and the terminal's
  "Explain selection / Fix last error" hand their text to Ember.
- **Your screen:** the screen button in the composer asks the browser to share this tab (or anything you
  pick), takes one frame, and attaches it to your next message for a vision model (marked "vision" in the
  picker). Nothing keeps recording; the picture is stored with the chat.
- **Models:** the picker in the header lists every model the AXION router serves (with "vision" and
  "loaded" badges). The choice is remembered on the server; `[llm] model` is only the default.
- **Tools:** list/read/search/write files (the same jail as Files; protected locations stay closed to
  Ember), run commands as you, system status, the journal, package search (pacman + AUR), and image
  generation.
- **Risk tiers**, decided on the server for every call: **safe** (read-only) runs at once; **change**
  needs a tap; **danger** (deleting, killing, stopping services, force-pushing…) needs you to type the
  command's name and confirm your Kiln password; **root** (sudo) does too, plus your sudo password, which
  is fed once to `sudo -S` and never stored or logged. Unknown commands count as change at least, and a
  shell line is as risky as its riskiest part. Policies live in `[approvals]`. Every call is audited.
- **Images:** switch the composer to **Image** (or just ask Ember for a picture) to generate with AXION's
  ComfyUI and Z-Image Turbo (`[image]`). Kiln frees the language model's VRAM first, since the RTX 3080 is
  shared, and gives it back before the next reply. Results land in `~/Pictures/Kiln` and open in Files.
- **Stopping:** the stop button, closing the tab, or panic cancels the run and kills any command it started.
  The orb shows what Ember is doing: listening, thinking, speaking, waiting for your OK (ochre), or an error.
- **Voice:** the mic records until you pause, then faster-whisper transcribes it on the CPU (`[voice] stt_model`,
  English and Spanish detected automatically; the first use downloads the model from Hugging Face) and sends
  it. Replies to voice messages are spoken by AXION's TTS (`tts_voice`, empty = its default); the speaker
  button in the header reads every reply aloud, and stops speech that is playing. Captions under the orb show
  what Ember heard and the sentence it is saying. The mic and speech stop when Kiln locks.

## System and Logs

- **Overview:** CPU (per core), memory and swap, GPU, network, disks, temperatures, uptime and pending
  updates, live from the same stream the widgets use.
- **Processes:** every process, sorted by CPU, memory or name, searchable by name, command or PID.
  **Stop** sends SIGTERM and **Force stop** SIGKILL, for your own processes only; each asks once in place.
- **Services:** system and user units (running, failed or all), with start, stop, restart, enable and
  disable, and a **Logs** button that opens the Logs app on that unit. Kiln refuses to stop its own service.
- **Packages:** pending updates (repositories and the AUR), the packages you installed, and search.
  Installing, removing and updating open a Terminal and run `pacman` or your AUR helper there, so you see
  every prompt before anything changes.
- **Network:** interfaces with addresses, link speed and live throughput, plus your Tailscale devices.
- **Storage:** filesystems (btrfs subvolumes grouped by device) and the physical drives.
- **Power:** lock, suspend, restart and power off.
- **Logs:** `journalctl -f`, live: system or your own journal, filtered by unit, level, time and a
  case-insensitive regex. Pause holds the view while new lines queue; colors mark errors and warnings.

Every action (stopping a process, changing a service, power) needs your Kiln password if you haven't
confirmed it in the last few minutes, and is written to the audit log. Root actions first go through
polkit; if that is refused, Kiln asks for your sudo password once, feeds it to `sudo -k -S`, and forgets it.

## Files and Editor

Files is rooted at your home folder: the same jail Ember's file tools will use.

- **Views and tabs:** list, grid with image thumbnails, and Miller columns; tabs, back and forward,
  and editable breadcrumbs (double-click, or `Ctrl+L`).
- **Sidebar:** places, bookmarks, recent files, Trash, and a disk usage bar.
- **Search:** by name or by content (`fd` / `rg`, streamed).
- **Everyday operations:** new, rename (`F2`), cut, copy and paste across windows, and drag to move
  (hold `Ctrl` to copy).
- **Trash:** `Delete` moves things to the freedesktop Trash, so Dolphin and Nautilus see the same items.
  Restore them from Trash in the sidebar.
- **Deleting forever:** `Shift+Delete` asks for confirmation and then your password.
- **Upload and download:** drop files on a folder, or use the button. Uploads are 4 MiB chunks and
  resume after network drops. Folders download as a zip built on the fly.
- **Previews:** images (zoom and pan), video, audio, PDF (pdf.js), markdown, code (Monaco, read-only),
  3D models (`.glb`, `.gltf`, `.obj`, `.fbx`) and archive listings. Extract and compress from the
  right-click menu.
- **Details pane:** permissions editor (chmod), owner, timestamps, and a SHA-256 checksum on demand.
- **Protected locations** (`~/.ssh`, `~/.gnupg`, `.env` files, browser profiles…) ask for your password
  before showing their contents.
- **Live:** folders refresh as they change on disk.

The Editor (Monaco) opens text and code files as tabs. `Ctrl+S` saves. If the file changed on disk
since you opened it, you can compare, overwrite or reload; nothing is silently lost.

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
.venv/bin/pytest            # 150 tests: auth, CSRF, rate limit, sessions, audit, path jail, sun, config, media, metrics, widgets, terminal, filesystem, Ember
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
KILN_URL=https://127.0.0.1:8443 KILN_TEST_PASSWORD='…' npm run e2e   # Ember tests need AXION; KILN_E2E_IMAGES=1 adds ComfyUI
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
  fs/              ops, freedesktop trash, chunked uploads, archives, search, watcher
  routes_fs.py     /api/fs/*, /ws/fs (contract: docs/phase5-fs-api.md)
  routes_core.py   appearance, audit API, /ws/events
  ember/           llm (AXION client), risk (command classifier), tools, comfy (ComfyUI), service (chat loop, approvals)
  routes_ember.py  /api/ember/* (NDJSON chat stream, conversations, approvals, models)
  system/admin.py  processes, services, packages, network, storage, power, journal filters
  routes_system.py /api/system/* (System app), /ws/logs (live journal)
frontend/src/
  app/             App, LockScreen, PasswordPill
  shell/           window manager store, Strip (Home + workspaces + task view), Window,
                   WorkspacePage (tiling/floating), Taskbar (dock, island, tray), Spotlight, app registry
  ember/           Ember sidebar (chat, tool cards, approvals, image mode, model picker) and its store
  apps/            Settings (appearance, dock, taskbar widgets, devices, security); placeholders
  apps/system/     System app (overview, processes, services, packages, network, storage, power)
  apps/logs/       Logs app (live journal with filters)
  apps/files/      file manager (views, panels, uploads, watcher)
  apps/editor/     Monaco editor app + workers/themes
  previews/        lazy viewers per file kind
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
5. ✅ File manager, previews (image, video, audio, PDF, markdown, code, 3D, archives), Monaco editor
6. ✅ Ember (text): sidebar, tools, risk classifier, approvals, ComfyUI images, model picker
7. ✅ Voice: STT/TTS, full orb states, captions
8. ✅ System apps (dashboard, processes, services, packages, logs, network, storage, power)
9. Polish: six themes × light/dark, theme editor, motion, mobile, PWA
10. Extras: automations, clipboard, screenshots, media, notes
