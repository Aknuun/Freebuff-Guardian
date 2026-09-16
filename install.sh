#!/usr/bin/env bash
# install.sh — interactive installer for Freebuff Guardian
# Asks for the BotFather token and your numeric user id, checks the Freebuff
# prerequisite, then installs/starts the bot.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
ENV_FILE="$DIR/.env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠️  %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m❌ %s\033[0m\n' "$*" >&2; }

echo
bold "🛡️  Freebuff Guardian — installer"
echo "──────────────────────────────────────────────"

# ── 1) Node prerequisite ────────────────────────────────────────
command -v node >/dev/null 2>&1 || { err "Node.js is not installed. Install it: https://nodejs.org"; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm is not installed."; exit 1; }
bold "Node: $(node -v) — npm: $(npm -v)"

# ── 2) Freebuff prerequisite (must be installed + logged in) ────
echo
bold "Prerequisite: Freebuff"
echo "This bot cannot work without Freebuff. First install and log in to"
echo "Freebuff on THIS server:"
echo "    npm i -g freebuff"
echo "    freebuff          # then log in"
echo "Website:  https://freebuff.com"
echo

FB_CRED="$HOME/.config/manicode/credentials.json"
if [[ ! -f "$FB_CRED" ]]; then
  warn "Freebuff credentials not found: $FB_CRED"
  warn "If you have not installed/logged in yet, the bot will not be able to chat."
  read -rp "Continue anyway? [y/N] " ans
  [[ "${ans,,}" == "y" ]] || { echo "Aborted. Install Freebuff first: https://freebuff.com"; exit 1; }
else
  ok "Freebuff credentials found."
fi

# ── 3) Telegram token + user id ─────────────────────────────────
echo
bold "Telegram bot info"
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
USER_IDS="${ALLOWED_USER_IDS:-}"

if [[ -z "$TOKEN" ]]; then
  echo "1) Get your bot token from @BotFather (/newbot) and paste it here:"
  read -rp "   TELEGRAM_BOT_TOKEN: " TOKEN
fi
if [[ ! "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{25,}$ ]]; then
  err "Invalid token format. It should look like 123456:AA..."
  exit 1
fi

if [[ -z "$USER_IDS" ]]; then
  echo "2) Get your numeric id from @userinfobot (separate multiple ids with commas):"
  read -rp "   ALLOWED_USER_IDS: " USER_IDS
fi
USER_IDS="${USER_IDS// /}"
if [[ ! "$USER_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  err "Invalid id. Digits only (comma-separated for several users)."
  exit 1
fi
ok "Token and user id received."

# ── 4) Create .env ──────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || cp "$DIR/.env.example" "$ENV_FILE"

set_kv() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENV_FILE"; then
    sed -i -E "s#^${k}=.*#${k}=${v}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}
set_kv TELEGRAM_BOT_TOKEN "$TOKEN"
set_kv ALLOWED_USER_IDS "$USER_IDS"
set_kv STATE_FILE "$DIR/state.json"
set_kv FREEBUFF_WORKDIR "$DIR"

# Server control by the model (run_terminal_command)
echo
echo "Server control: when enabled, the model can run commands on this server"
echo "(dangerous commands require your confirmation first)."
SERVTOOLS="${ENABLE_SERVER_TOOLS:-}"
if [[ -z "$SERVTOOLS" ]]; then
  read -rp "Enable it? [Y/n] " SERVTOOLS || true
fi
if [[ "${SERVTOOLS,,}" == "n" ]]; then
  set_kv ENABLE_SERVER_TOOLS false
  echo "  → disabled."
else
  set_kv ENABLE_SERVER_TOOLS true
  echo "  → enabled."
fi
ok ".env created/updated."

# ── 5) Install dependencies ─────────────────────────────────────
echo
bold "Installing dependencies (npm install)…"
npm install --no-audit --no-fund
ok "Dependencies installed."

# ── 6) Run, or install as a systemd service ─────────────────────
echo
if command -v systemctl >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  read -rp "Install and start as a systemd service? [Y/n] " run_svc
  if [[ "${run_svc,,}" != "n" ]]; then
    cat > /etc/systemd/system/freebuff-guardian.service <<UNIT
[Unit]
Description=Freebuff Guardian Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$(command -v node) $DIR/src/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable --now freebuff-guardian
    ok "Service freebuff-guardian started."
    echo "   Logs:  journalctl -u freebuff-guardian -f"
  else
    echo "To run: node $DIR/src/index.mjs"
  fi
else
  echo "Run the bot:"
  echo "    node $DIR/src/index.mjs"
  echo "(To install as a service, run this script with sudo.)"
fi

echo
ok "Done! Message the bot on Telegram and send /menu."
