# 🛡️ Freebuff Guardian

[![version](https://img.shields.io/github/v/tag/Aknuun/Freebuff-Guardian?label=version&sort=semver)](https://github.com/Aknuun/Freebuff-Guardian/tags)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**🌐 Languages:** **English** · [فارسی](README.fa.md) · [Русский](README.ru.md)

---

## About Freebuff

**Freebuff** is a *100% free* AI coding agent, funded by ads instead of a subscription.
It ships in several forms — **CLI**, **Desktop**, **Web**, **Cloud** and **Chat** — and lets you
use powerful coding models at no cost. It runs directly on your machine/server and works on
your real files and commands.

- 🌐 Website: **https://freebuff.com**
- 💻 CLI install: `npm i -g freebuff` then run `freebuff`
- 🧩 Free for everyone: no API key, no credit card
- 📉 Limited by a daily **Freebucks** budget (see below)

`Freebuff Guardian` is an independent Telegram front-end for Freebuff; it is **not** affiliated
with the Freebuff team. You still need a Freebuff account and the CLI on the same server.

## What is Freebuff Guardian?

A Telegram bot that lets you **fully manage Freebuff and chat with it on your server — without SSH**.
You install it once, and from then on everything happens inside Telegram: chatting with the model,
switching models, controlling the server, managing several Freebuff accounts, watching your quota,
and letting the model run commands on your machine.

It is designed for people who run Freebuff on a remote VPS and want convenient, phone‑friendly
control over it (and over the server itself) from anywhere.

## ✨ Features

- 💬 **Chat with the free models** from Telegram, with multiple independent chat sessions and
  separate history per session.
- 🤖 **Model management**: a real switch — the bot closes the current free session and re‑admits
  with the requested model (the server locks a free session to one model). Each model shows its
  **cost (Freebucks/hour)** and the **hours left today**; models that are unavailable are shown
  **gray and non‑clickable**.
- 🎛 **Response mode**: 🧩 Default · ⚡ Fast (Lite) · 🛠 Build (MAX) · 🗺 Plan — the same modes the
  CLI exposes.
- ⚙️ **Settings menu**: response mode, ads on/off, active model, expiry‑warning threshold, and
  **auto-renew session** (warns 5 min before and renews the session automatically; with a cancel button).
- 👤 **Multiple Freebuff accounts** (shared use): add an account via the official **Web login**
  flow (no server needed for that account, with a copy-login-link button). When quota runs out it
  asks with buttons and, if unanswered within **1 minute**, **fails over automatically** to the next
  account without cutting the session.
- 💾 **Account backup/restore**: automatic daily backup plus Backup and Restore-from-file buttons in
  the Accounts menu.
- ⏳ **Session timer**: the free session has a fixed **1‑hour** lifetime on the server; the bot shows
  a live countdown (e.g. "51 min left"), warns you before expiry, and shows a **renew** button only near expiry.
- 💵 **Quota view**: used/left **Freebucks** and the separate session‑count cap, in both the status
  and the accounts screens. When the quota is exhausted, you get a clear message plus
  **Add account / Switch account / Buy plan** buttons.
- ⌨️ **Server control (agent tools)**: the model can run `run_terminal_command`, `read_file`,
  `list_directory` and `write_file` on this server, in a multi‑step loop. Dangerous commands
  require a **Run / Cancel** confirmation.
- 🎛 **Two UIs at once**: inline (glass) buttons for everything, plus a **fixed bottom keyboard**
  (`📊 Status` · `/start` · `🤖 Model`) and a **FA/EN language switch**.
- 🔒 **Security**: the bot answers **only** to the numeric ids listed in `ALLOWED_USER_IDS`.

## 🧠 How it works (briefly)

Freebuff's free mode is only accepted by the backend when the request looks like the official
CLI. The bot reverse‑engineers that behaviour and reproduces it:

1. It reads your Freebuff credentials from `~/.config/manicode/credentials.json`.
2. It opens/uses a free **session** (`/api/v1/freebuff/session`) valid for one hour.
3. It calls the model with `cost_mode: free` and a system prompt that starts exactly with
   `You are Buffy, the coding agent behind Codebuff.` (otherwise the server replies
   `free_mode_cli_required`).
4. For tool‑calling, it sends tool definitions and executes the requested tools **locally**,
   feeding the results back to the model.
5. It keeps the session's `instanceId`, so it never kicks an interactive CLI session (HTTP 409).

## 🚀 Install

### One‑line install (recommended)
```bash
git clone https://github.com/Aknuun/Freebuff-Guardian.git && cd Freebuff-Guardian && bash install.sh
```
The installer (fully in English) asks for:
1. **Bot token** from [@BotFather](https://t.me/BotFather) (`/newbot`).
2. **Your numeric id** from [@userinfobot](https://t.me/userinfobot).
3. Whether to **enable server control** (agent tools).

It then writes `.env`, runs `npm install`, and optionally installs and starts a systemd service.

### Manual install
```bash
git clone https://github.com/Aknuun/Freebuff-Guardian.git
cd Freebuff-Guardian
cp .env.example .env      # then edit TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS
npm install
node src/index.mjs
```

### systemd service (manual)
```bash
cp freebuff-guardian.service /etc/systemd/system/
# adjust paths if needed
systemctl daemon-reload
systemctl enable --now freebuff-guardian
journalctl -u freebuff-guardian -f
```

## ⌨️ Fixed bottom keyboard

Send `/menu` or `/start` once and Telegram shows a fixed keyboard at the bottom:
`📊 Status` · `/start` · `🤖 Model`. It stays available, so you rarely need to type a command.
The `/start` button behaves exactly like the `/start` command.

## 🔘 Button reference

The in‑bot **Help** is button‑based: tap any section and its explanation shows in place.
Buttons are colour‑coded by purpose: 🟦 info/navigation · 🟩 create/enable · 🟥 delete/cancel/off
· some are neutral (default).

| Button | What it does |
|---|---|
| 📊 Status | Server load, model, response mode, active session, quota, timer |
| /start | Opens the home menu (same as the command) |
| 🤖 Model | Switch model (shows cost + hours left; unavailable are gray) |
| 💬 Chats | List, switch and delete chat sessions (delete asks for confirmation) |
| ➕ New chat | Create a new conversation |
| 🧹 Clear history | Clear the active chat's messages |
| 👤 Accounts | Switch/add Freebuff accounts, see per‑account quota |
| ⚙️ Settings | Response mode · Ads · Model · Expiry warning |
| ⏰ Expiry warning | Off / 2 / 5 / 10 minutes before session expiry |
| 🔄 Renew session | Close the session and start a fresh one (resets the 1‑hour timer) |
| 🖥 Server | Processes · Run command (`/sh`) · restart freebuff · instance · release lock |
| ❓ Help | Section‑by‑section help |
| Plain message | Chat with the active model |

## 💵 Quota & Freebucks (the real limit)

Freebuff gives a **daily budget** called **Freebucks**, shared across all models.
The key rules:

- Each **session** costs the model's **hourly price** in Freebucks, charged **once** when the
  session **starts** (not per message). Each free session lasts **1 hour**.
- The daily budget **refills at midnight Pacific** and does **not** carry over.
- The `🎟 session‑count cap` (today / 7‑day / month) is a **separate** counter; the real limiter is
  Freebucks.
- Some models are **premium** and also have their own small daily cap.

Typical prices and how far the budget goes:

| Model | Freebucks/hour | Sessions with ~70 FB |
|---|---|---|
| GLM 5.3 Flash · Kimi | 5 | ~14 |
| MiMo 2.5 · Solar Pro 4 | 10 | ~7 |
| DeepSeek V4 Flash | 15 | ~4 |
| Luna | 20 | ~3 |
| Gemini 3.8 | 50 | ~1 |

You can mix models. When the budget is exhausted the bot shows the reset time and offers
**➕ Add account**, **🔄 Switch account** and **🛒 Buy plan** buttons.

Paid plans (as reported by the account):
Starter **$8/mo** (first month $5) · Plus **$25/mo** (first $19) · Pro **$60/mo** (first $45).

## ⏳ Session & timer

- A free session lives exactly **1 hour** (server‑side) and **chatting does not extend it**.
- The bot shows the remaining time in `/status`, the home menu and the status block.
- A warning appears before expiry (default **5 min**, configurable via Settings → ⏰ Expiry warning).
- The **renew** button appears **only** near expiry; otherwise the answer has no buttons.
- Your next message auto‑starts a fresh session, and if the current account has no quota the bot
  **fails over** to another account automatically.

## ⌨️ Server control (agent tools)

When `ENABLE_SERVER_TOOLS=true` (asked during install), the model gets tools and can do real work
on your server in a multi‑step loop (up to 8 steps):

- `run_terminal_command` — run any shell command (with optional `cwd`, `timeoutSec`).
- `read_file` — read a text file.
- `list_directory` — list a directory.
- `write_file` — create/overwrite a file.

Behaviour:
- While working, the **top message** shows progress (a thinking indicator and the commands being
  run). When the model is done, that message turns into the **status block**
  (model · session time left · quota), and the **answer is sent as a separate message**.
- **Dangerous commands** — e.g. `rm -rf`, `mkfs`, `dd if=`, `shutdown`/`reboot`, `curl|sh`,
  `:(){...}`, `iptables -F` — are shown with **✅ Run / ❌ Cancel** buttons and only run after you
  confirm. Safe commands run automatically.
- The bot runs as the server user (root by default). Prefer the manual `/sh <command>` or the
  Server → Run command button when you want to run something yourself.

## 👤 Accounts & automatic failover

- `/account add <name>` → choose **🌐 Web login** (the bot gives a login link plus a copy-link
  button; sign in on the Freebuff site).
- Accounts are stored in `accounts/` (gitignored, permissions `600`). `default` is the server's own
  account and cannot be deleted.
- Each account has its **own session and Freebucks**.
- The Accounts page shows only the **active** account's details; tap any account button to activate
  it and see its info right there. **▶️ Start session**, **➕ Add account** and **🗑 Delete account**
  are on the same page.
- When the active account's quota is exhausted, the bot asks:
  `♻️ Account "X" quota is used up; switching to "Y".`
  with **➡️ Switch to Y** and **❌ Cancel** buttons. If you don't tap within **1 minute**, it
  switches to the next account **automatically** and the **session is not cut**. This happens on
  chat errors, session start and renew.
- **💾 Backup & ♻️ restore accounts**: in the Accounts menu, the backup button creates a JSON file
  of all accounts (including `default`) and sends it to the chat. The bot also sends a backup
  **once a day** automatically. To restore, tap "♻️ Restore from file" and send that JSON file in
  the chat.

Only add accounts whose owner has given permission — adding extra accounts may violate Freebuff's
rules and risks a ban.

## 🔒 Security

- Only the numeric ids in `ALLOWED_USER_IDS` are served; everyone else is ignored silently.
- `.env`, `state.json`, `accounts/` and secrets are **never** committed (see `.gitignore`).
- Server tools run as the bot's OS user. Keep the server access list tight.

## 🧩 Troubleshooting / FAQ

- **`free_mode_cli_required`** — the request must include the official system‑prompt prefix; the
  bot adds it automatically. Update to the latest version if you still see it.
- **`session_superseded` (409)** — two instances used the same account. The bot always reuses the
  active session's `instanceId`; avoid running a second client on the same account.
- **`waiting_room_required` (428)** — the session expired mid‑request. Your next message starts a
  new one automatically.
- **Quota exhausted** — Freebucks is a daily budget; the bot shows the reset time. Wait, upgrade,
  or switch account.
- **The model says it has no shell** — make sure `ENABLE_SERVER_TOOLS=true` (Settings/install) and
  that you added a Freebuff account with quota.

## 🏗 Architecture

```
src/
├── index.mjs      entry point (loads config, starts the bot)
├── config.mjs     .env + Freebuff credentials + model→agent map
├── state.mjs      sessions/history + small global settings
├── settings.mjs   reads/writes Freebuff's settings.json (mode/ads/model)
├── instance.mjs   locks & instance handling (avoid takeover)
├── accounts.mjs   multiple account profiles (Web login / credentials.json)
├── backup.mjs     accounts backup/restore as a JSON file
├── chat.mjs       session + agent-runs + chat/completions (+ tool support)
└── bot.mjs        Telegram UI, buttons, agent tools, failover
```

## 📦 Release

```bash
./release.sh patch "short title" "full description"
./release.sh minor "New feature" "…"
./release.sh 1.2.3 "Exact version" "…"
```
It bumps the version, updates `CHANGELOG.md`, commits, tags `vX.Y.Z`, pushes, and creates a
GitHub Release with a short title and the full description in the body.

## Contributing

Issues and PRs are welcome. Please keep the code style consistent and never commit secrets.

## License

MIT
