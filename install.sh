#!/usr/bin/env bash
# install.sh — نصب تعاملی نگهبان فری‌باف
# اول توکن BotFather و آیدی عددی را می‌گیرد، پیش‌نیاز فری‌باف را چک می‌کند و
# بعد ربات را نصب/اجرا می‌کند.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
ENV_FILE="$DIR/.env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠️  %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m❌ %s\033[0m\n' "$*" >&2; }

echo
bold "🛡️  نصب نگهبان فری‌باف (Freebuff Guardian)"
echo "──────────────────────────────────────────────"

# ── ۱) پیش‌نیاز Node ─────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { err "Node.js نصب نیست. نصب کن: https://nodejs.org"; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm نصب نیست."; exit 1; }
bold "Node: $(node -v) — npm: $(npm -v)"

# ── ۲) پیش‌نیاز فری‌باف (باید روی سرور نصب و لاگین شده باشد) ───────
echo
bold "پیش‌نیاز: فری‌باف"
echo "این ربات بدون فری‌باف کار نمی‌کند. اول باید فری‌باف را روی همین سرور"
echo "نصب و لاگین کنی:"
echo "    npm i -g freebuff"
echo "    freebuff          # سپس login کن"
echo "سایت اصلی:  https://freebuff.com"
echo

FB_CRED="$HOME/.config/manicode/credentials.json"
if [[ ! -f "$FB_CRED" ]]; then
  warn "credentials فری‌باف پیدا نشد: $FB_CRED"
  warn "اگر تا حالا نصب/لاگین نکرده‌ای، ربات بعداً نمی‌تواند چت کند."
  read -rp "با این حال ادامه می‌دهی؟ [y/N] " ans
  [[ "${ans,,}" == "y" ]] || { echo "لغو شد. اول فری‌باف را نصب کن: https://freebuff.com"; exit 1; }
else
  ok "credentials فری‌باف پیدا شد."
fi

# ── ۳) گرفتن توکن و آیدی ─────────────────────────────────────────
echo
bold "اطلاعات ربات تلگرام"
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
USER_IDS="${ALLOWED_USER_IDS:-}"

if [[ -z "$TOKEN" ]]; then
  echo "۱) توکن ربات را از @BotFather بگیر (دستور /newbot) و اینجا بگذار:"
  read -rp "   TELEGRAM_BOT_TOKEN: " TOKEN
fi
if [[ ! "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{25,}$ ]]; then
  err "فرمت توکن نامعتبر است. باید شبیه 123456:AA... باشد."
  exit 1
fi

if [[ -z "$USER_IDS" ]]; then
  echo "۲) آیدی عددی خودت را از @userinfobot بگیر (چند نفر با کاما جدا شوند):"
  read -rp "   ALLOWED_USER_IDS: " USER_IDS
fi
USER_IDS="${USER_IDS// /}"
if [[ ! "$USER_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  err "آیدی نامعتبر است. فقط عدد (و کاما برای چند نفر)."
  exit 1
fi
ok "توکن و آیدی دریافت شد."

# ── ۴) ساخت .env ────────────────────────────────────────────────
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
ok "فایل .env ساخته/به‌روزرسانی شد."

# ── ۵) نصب وابستگی‌ها ────────────────────────────────────────────
echo
bold "نصب وابستگی‌ها (npm install)…"
npm install --no-audit --no-fund
ok "وابستگی‌ها نصب شدند."

# ── ۶) اجرا یا نصب به‌عنوان سرویس ────────────────────────────────
echo
if command -v systemctl >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  read -rp "به‌عنوان سرویس systemd نصب و اجرا شود؟ [Y/n] " run_svc
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
    ok "سرویس freebuff-guardian اجرا شد."
    echo "   لاگ:  journalctl -u freebuff-guardian -f"
  else
    echo "برای اجرا: node $DIR/src/index.mjs"
  fi
else
  echo "اجرای ربات:"
  echo "    node $DIR/src/index.mjs"
  echo "(برای نصب به‌عنوان سرویس، با sudo این اسکریپت را اجرا کن.)"
fi

echo
ok "تمام! در تلگرام به ربات پیام بده و /menu را بزن."
