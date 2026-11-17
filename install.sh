#!/usr/bin/env bash
# Kiln installer. Runs as your normal user; asks before anything that needs sudo.
#   ./install.sh               install or upgrade
#   ./install.sh --rebuild     force a frontend rebuild
#   ./install.sh --no-service  don't install/start the systemd user service
#   ./install.sh --preview     try Kiln without installing: temporary, local-only, deleted when you stop it
#   ./install.sh --uninstall   remove Kiln and undo its system changes; keeps your data and settings
#   ./install.sh --purge       like --uninstall, and also deletes your data, settings and certificates
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PREFIX="${KILN_PREFIX:-$HOME/.local/share/kiln}"
CONF="${KILN_CONFIG_DIR:-$HOME/.config/kiln}"
UNIT_DIR="$HOME/.config/systemd/user"
STATE="$CONF/.install-state"  # system changes made here (firewall, tailscale), so --uninstall can undo them
REBUILD=0
SERVICE=1
MODE=install
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --no-service) SERVICE=0 ;;
    --preview) MODE=preview ;;
    --uninstall) MODE=uninstall ;;
    --purge) MODE=purge ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

clay=$'\e[38;5;173m'; ochre=$'\e[38;5;179m'; dim=$'\e[2m'; off=$'\e[0m'
say()  { printf '%s●%s %s\n' "$clay" "$off" "$*"; }
warn() { printf '%s▲ %s%s\n' "$ochre" "$*" "$off" >&2; }
die()  { warn "$*"; exit 1; }
ask()  { local a; read -r -p "  $1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

[[ $EUID -eq 0 ]] && die "Run install.sh as your normal user, not root."
mark() { grep -qxF "$1" "$STATE" 2>/dev/null || echo "$1" >> "$STATE"; }
safe_dir() { [[ -n "$1" && "$1" != "/" && "${1%/}" != "$HOME" ]]; }

# ── preview: everything lives in one temp folder, removed on exit ────────────
preview() {
  command -v openssl >/dev/null || die "openssl is required (sudo pacman -S openssl)"
  local py="" port web pw
  # Globals: the EXIT trap runs after this function's locals are gone.
  PREVIEW_PID=""
  PREVIEW_DIR="$(mktemp -d -t kiln-preview.XXXXXX)"
  local tmp="$PREVIEW_DIR"
  chmod 700 "$tmp"
  cleanup() {
    set +e  # a killed server makes `wait` fail; cleanup must still finish
    if [[ -n "$PREVIEW_PID" ]]; then kill "$PREVIEW_PID" 2>/dev/null; wait "$PREVIEW_PID" 2>/dev/null; fi
    rm -rf "$PREVIEW_DIR"
    say "Preview stopped and deleted."
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  # Every cache and data path points into $tmp, so nothing outside it changes.
  export KILN_CONFIG_DIR="$tmp/config" KILN_DATA_DIR="$tmp/data" KILN_CONFIG="$tmp/config/config.toml"
  export HF_HOME="$tmp/cache/hf" UV_CACHE_DIR="$tmp/cache/uv" PIP_CACHE_DIR="$tmp/cache/pip"
  export npm_config_cache="$tmp/cache/npm" PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$REPO/backend"
  mkdir -p "$tmp/config/tls" "$tmp/data" "$tmp/home/Pictures"

  # Reuse an existing Python environment read-only when it can run this checkout; else build one in $tmp.
  for c in "$PREFIX/venv/bin/python" "$REPO/backend/.venv/bin/python"; do
    [[ -x "$c" ]] && "$c" -c 'import app.main' 2>/dev/null && { py="$c"; break; }
  done
  if [[ -z "$py" ]]; then
    say "Setting up a temporary Python environment (this takes a minute)"
    python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' || die "Python 3.12+ is required"
    if command -v uv >/dev/null; then
      uv venv -q "$tmp/venv" && uv pip install -q -p "$tmp/venv/bin/python" "$REPO/backend"
    else
      python3 -m venv "$tmp/venv" && "$tmp/venv/bin/pip" install -q "$REPO/backend"
    fi
    py="$tmp/venv/bin/python"
  fi

  web="$REPO/frontend/dist"
  if [[ ! -f "$web/index.html" ]]; then
    command -v npm >/dev/null || die "npm is required to build the frontend (sudo pacman -S npm)"
    say "Building the frontend into the preview folder"
    (cd "$REPO/frontend" && { [[ -d node_modules ]] || npm ci --no-audit --no-fund --silent; } \
      && npx --no-install vite build --outDir "$tmp/web" --emptyOutDir --logLevel error)
    web="$tmp/web"
  fi

  port="$("$py" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
    -subj "/CN=Kiln preview" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$tmp/config/tls/key.pem" -out "$tmp/config/tls/cert.pem" 2>/dev/null
  cat > "$KILN_CONFIG" <<EOF
data_dir = "$tmp/data"
[server]
port = $port
bind = "127.0.0.1"
tls_cert = "$tmp/config/tls/cert.pem"
tls_key = "$tmp/config/tls/key.pem"
web_root = "$web"
[files]
jail_root = "$tmp/home"
[image]
output_dir = "$tmp/home/Pictures/Kiln"
EOF
  pw="$("$py" -c 'import secrets; print(secrets.token_urlsafe(12))')"
  printf '%s\n' "$pw" | "$py" -c 'import sys; from app.cli import main; sys.exit(main())' set-password --stdin >/dev/null

  say "Kiln preview at https://127.0.0.1:$port  (this machine only)"
  printf '  password: %s\n' "$pw"
  printf '%s  The certificate is self-signed: let your browser continue once.\n' "$dim"
  printf '  Files sees an empty sandbox folder. Terminal and Ember commands still run as you.\n'
  printf '  Press Ctrl+C (or close this terminal) to stop; everything is deleted.%s\n' "$off"
  "$py" -c 'import sys; from app.cli import main; sys.exit(main())' serve > "$tmp/server.log" 2>&1 &
  PREVIEW_PID=$!
  wait "$PREVIEW_PID" || { warn "Kiln stopped:"; tail -n 15 "$tmp/server.log" >&2; exit 1; }
}

# ── uninstall: undo what the installer did ───────────────────────────────────
uninstall() {
  local purge=$1 what port data line changes=()
  if [[ $purge -eq 1 ]]; then
    warn "This removes Kiln and deletes your Kiln password, chats, audit log, settings and certificates."
  else
    say "This removes Kiln, its service and the system changes the installer made. Your data and settings stay."
  fi
  ask "Continue?" || exit 0

  if [[ -f "$UNIT_DIR/kiln.service" ]]; then
    say "Stopping and removing the systemd user service"
    systemctl --user disable --now kiln.service 2>/dev/null || true
    rm -f "$UNIT_DIR/kiln.service"
    systemctl --user daemon-reload
  fi

  [[ -f "$STATE" ]] && mapfile -t changes < "$STATE"
  for line in "${changes[@]}"; do  # not `while read`: ask needs the keyboard on stdin
    read -r what port <<< "$line"
    case "$what" in
      ufw)
        ask "Remove the ufw rules the installer added for port $port (uses sudo)?" && {
          sudo ufw delete allow in on tailscale0 to any port "$port" proto tcp || true
          sudo ufw delete deny "$port"/tcp || true
        } ;;
      tailscale-operator)
        ask "Remove the Tailscale operator rights the installer gave $USER (uses sudo)?" \
          && { sudo tailscale set --operator= || true; } ;;
    esac
  done
  rm -f "$STATE"

  safe_dir "$PREFIX" || die "Refusing to remove $PREFIX"
  say "Removing the app from $PREFIX"
  rm -rf "$PREFIX/venv" "$PREFIX/web" "$PREFIX/web.new"

  if [[ $purge -eq 1 ]]; then
    data="$(sed -n 's/^data_dir *= *"\(.*\)".*/\1/p' "$CONF/config.toml" 2>/dev/null | head -1)"
    say "Deleting $PREFIX and $CONF"
    rm -rf "$PREFIX"
    safe_dir "$CONF" && rm -rf "$CONF"
    [[ -n "$data" ]] && warn "Your config set data_dir = $data; delete that folder yourself if you want it gone."
    local models=("$HOME"/.cache/huggingface/hub/models--Systran--faster-whisper-*)
    if [[ -e "${models[0]}" ]] && ask "Delete the speech-to-text models Kiln downloaded (${models[*]##*/})?"; then
      rm -rf "${models[@]}"
    fi
  else
    rmdir "$PREFIX" 2>/dev/null || true
    say "Kept your data in $PREFIX and settings in $CONF. ./install.sh --purge removes them too."
  fi
  printf '%s  Not touched: your images in ~/Pictures/Kiln, your Trash, and this repository.%s\n' "$dim" "$off"
  say "Kiln is uninstalled."
}

case "$MODE" in
  preview) preview; exit 0 ;;
  uninstall) uninstall 0; exit 0 ;;
  purge) uninstall 1; exit 0 ;;
esac

# ── dependencies ─────────────────────────────────────────────────────────────
command -v python3 >/dev/null || die "python3 is required (sudo pacman -S python)"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' || die "Python 3.12+ is required"
command -v openssl >/dev/null || die "openssl is required (sudo pacman -S openssl)"

missing=()
for pair in "tailscale:tailscale" "rg:ripgrep" "fd:fd" "sensors:lm_sensors" "smartctl:smartmontools" \
            "playerctl:playerctl" "grim:grim"; do
  command -v "${pair%%:*}" >/dev/null || missing+=("${pair#*:}")
done
if ! command -v paru >/dev/null && ! command -v yay >/dev/null; then
  warn "No AUR helper (yay/paru) found: package features will use pacman only."
fi
((${#missing[@]})) && warn "Optional tools not found: ${missing[*]}  →  sudo pacman -S --needed ${missing[*]}"

# ── backend ──────────────────────────────────────────────────────────────────
say "Installing the backend into $PREFIX/venv"
mkdir -p "$PREFIX" && chmod 700 "$PREFIX"
if command -v uv >/dev/null; then
  [[ -x "$PREFIX/venv/bin/python" ]] || uv venv -q "$PREFIX/venv"
  uv pip install -q -p "$PREFIX/venv/bin/python" --reinstall-package kiln "$REPO/backend"
else
  [[ -x "$PREFIX/venv/bin/python" ]] || python3 -m venv "$PREFIX/venv"
  "$PREFIX/venv/bin/pip" install -q --upgrade pip
  "$PREFIX/venv/bin/pip" install -q --force-reinstall --no-deps "$REPO/backend"
  "$PREFIX/venv/bin/pip" install -q "$REPO/backend"
fi
KILN="$PREFIX/venv/bin/kiln"

# ── frontend ─────────────────────────────────────────────────────────────────
if [[ $REBUILD -eq 1 || ! -f "$REPO/frontend/dist/index.html" ]]; then
  command -v npm >/dev/null || die "npm is required to build the frontend (sudo pacman -S npm)"
  say "Building the frontend"
  (cd "$REPO/frontend" && npm ci --no-audit --no-fund --silent && npm run build --silent)
fi
say "Copying the web build to $PREFIX/web"
rm -rf "$PREFIX/web.new" && cp -r "$REPO/frontend/dist" "$PREFIX/web.new"
rm -rf "$PREFIX/web" && mv "$PREFIX/web.new" "$PREFIX/web"

# ── config ───────────────────────────────────────────────────────────────────
mkdir -p "$CONF/tls" && chmod 700 "$CONF" "$CONF/tls"
if [[ ! -f "$CONF/config.toml" ]]; then
  say "Writing $CONF/config.toml"
  install -m 600 "$REPO/config.example.toml" "$CONF/config.toml"
  sed -i "s|~/.config/kiln/tls/|$CONF/tls/|" "$CONF/config.toml"
else
  say "Keeping your existing $CONF/config.toml"
fi
PORT="$(sed -n 's/^port *= *\([0-9]\+\).*/\1/p' "$CONF/config.toml" | head -1)"
PORT="${PORT:-8443}"

# ── TLS ──────────────────────────────────────────────────────────────────────
CERT="$CONF/tls/cert.pem"; KEY="$CONF/tls/key.pem"
TS_NAME=""; TS_IP=""
if command -v tailscale >/dev/null && tailscale status --json >/dev/null 2>&1; then
  TS_NAME="$(tailscale status --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
fi
if [[ ! -f "$CERT" ]]; then
  if [[ -n "$TS_NAME" ]] && ask "Get a trusted certificate for $TS_NAME with 'tailscale cert'?"; then
    # Lets your user fetch certs without sudo afterwards (one-time).
    tailscale cert --cert-file "$CERT" --key-file "$KEY" "$TS_NAME" 2>/dev/null || {
      warn "tailscale cert needs operator rights once: sudo tailscale set --operator=$USER"
      ask "Run that now with sudo?" && sudo tailscale set --operator="$USER" && mark tailscale-operator \
        && tailscale cert --cert-file "$CERT" --key-file "$KEY" "$TS_NAME"
    }
  fi
  if [[ ! -f "$CERT" ]]; then
    say "Generating a self-signed certificate (browsers will ask you to trust it once)"
    SAN="DNS:localhost,DNS:$(hostname),IP:127.0.0.1"
    [[ -n "$TS_NAME" ]] && SAN+=",DNS:$TS_NAME"
    [[ -n "$TS_IP" ]] && SAN+=",IP:$TS_IP"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
      -subj "/CN=Kiln on $(hostname)" -addext "subjectAltName=$SAN" \
      -keyout "$KEY" -out "$CERT" 2>/dev/null
  fi
  chmod 600 "$KEY" "$CERT"
fi

# ── password + 2FA ───────────────────────────────────────────────────────────
if ! "$KILN" has-password 2>/dev/null; then
  say "Choose your Kiln password (at least 10 characters; stored as an Argon2id hash)"
  until "$KILN" set-password; do :; done
  if ask "Enable two-factor sign-in (TOTP)?"; then "$KILN" totp enable || warn "Skipped 2FA; run 'kiln totp enable' later."; fi
fi

# ── firewall ─────────────────────────────────────────────────────────────────
if systemctl is-active --quiet ufw 2>/dev/null; then
  say "ufw is active. Recommended: allow port $PORT only on tailscale0:"
  printf '%s    sudo ufw allow in on tailscale0 to any port %s proto tcp\n    sudo ufw deny %s/tcp%s\n' "$dim" "$PORT" "$PORT" "$off"
  if ask "Apply these ufw rules now (uses sudo)?"; then
    sudo ufw allow in on tailscale0 to any port "$PORT" proto tcp
    sudo ufw deny "$PORT"/tcp
    mark "ufw $PORT"
  fi
else
  warn "No active ufw found. See README → Firewall for nftables / firewalld rules."
fi

# ── service ──────────────────────────────────────────────────────────────────
if [[ $SERVICE -eq 1 ]]; then
  say "Installing the systemd user service"
  mkdir -p "$UNIT_DIR"
  sed -e "s|%h/Documents/connecta|$REPO|" -e "s|%h/.local/share/kiln|$PREFIX|" \
    "$REPO/kiln.service" > "$UNIT_DIR/kiln.service"
  systemctl --user daemon-reload
  systemctl --user enable --quiet kiln.service
  systemctl --user restart kiln.service
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
    warn "Kiln stops when you log out. To keep it running: loginctl enable-linger $USER"
  fi
fi

"$KILN" check || true
HOST="${TS_NAME:-${TS_IP:-$(hostname)}}"
say "Done. Open https://$HOST:$PORT"
printf '%s  logs: journalctl --user -u kiln -f%s\n' "$dim" "$off"
