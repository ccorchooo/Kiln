#!/usr/bin/env bash
# Kiln installer. Runs as your normal user; asks before anything that needs sudo.
#   ./install.sh               install or upgrade
#   ./install.sh --rebuild     force a frontend rebuild
#   ./install.sh --no-service  don't install/start the systemd user service
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PREFIX="${KILN_PREFIX:-$HOME/.local/share/kiln}"
CONF="${KILN_CONFIG_DIR:-$HOME/.config/kiln}"
UNIT_DIR="$HOME/.config/systemd/user"
REBUILD=0
SERVICE=1
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --no-service) SERVICE=0 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

clay=$'\e[38;5;173m'; ochre=$'\e[38;5;179m'; dim=$'\e[2m'; off=$'\e[0m'
say()  { printf '%s●%s %s\n' "$clay" "$off" "$*"; }
warn() { printf '%s▲ %s%s\n' "$ochre" "$*" "$off" >&2; }
die()  { warn "$*"; exit 1; }
ask()  { local a; read -r -p "  $1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

[[ $EUID -eq 0 ]] && die "Run install.sh as your normal user, not root."

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
  warn "No AUR helper (paru/yay) found: package features will use pacman only."
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
      ask "Run that now with sudo?" && sudo tailscale set --operator="$USER" \
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
