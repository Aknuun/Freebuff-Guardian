# 🛡️ Freebuff Guardian

[![version](https://img.shields.io/github/v/tag/Aknuun/Freebuff-Guardian?label=version&sort=semver)](https://github.com/Aknuun/Freebuff-Guardian/tags)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**🌐 Languages:** [English](#-english) · [فارسی](#-فارسی) · [Русский](#-русский)

---

## 🇬🇧 English

Telegram bot to **fully manage and chat with Freebuff on your server — no SSH needed**.
Everything is doable from Telegram with inline buttons, a fixed bottom keyboard, or text.

### Features
- 💬 **Chat** with free Freebuff models from Telegram, with multiple independent chat sessions.
- 🤖 **Models**: real switching (closes the session and re-admits), shows each model's cost (Freebucks/hour) and today's hours left; disabled models are grayed out.
- 🎛 **Response mode**: 🧩 Default · ⚡ Fast (Lite) · 🛠 Build (MAX) · 🗺 Plan.
- ⚙️ **Settings**: response mode, ads, model, expiry warning.
- 👤 **Multiple accounts** (shared use): add via **Web login** (the official CLI login flow — no server needed) or by pasting `credentials.json`. **Automatic failover** to the next account when a quota runs out.
- ⏳ **Session timer**: the free session is a fixed 1 hour (server-side); live countdown, warning before expiry, and a renew button only near expiry.
- 💵 **Quota**: shows used/left Freebucks and the session-count cap; clear messages when exhausted, with **Add account / Switch account / Buy plan** buttons.
- ⌨️ **Server control (agent tools)**: the model can run `run_terminal_command`, `read_file`, `list_directory` and `write_file` on this server. Dangerous commands require confirmation.
- 🎛 **UI**: inline buttons + a fixed bottom keyboard (`📊 Status` · `/start` · `🤖 Model`) + FA/EN language switch.
- 🔒 **Security**: only `ALLOWED_USER_IDS` are answered.

### ⚠️ Prerequisite: install Freebuff on the server first
The bot is only a front-end; you must install and log in to Freebuff on the same server:
```bash
npm i -g freebuff
freebuff          # then log in
```
Website: **https://freebuff.com** — after login, `~/.config/manicode/credentials.json` is created.

### 🚀 Install (one line)
```bash
git clone https://github.com/Aknuun/Freebuff-Guardian.git && cd Freebuff-Guardian && bash install.sh
```
The installer asks for:
1. **Bot token** from [@BotFather](https://t.me/BotFather) (`/newbot`).
2. **Your numeric id** from [@userinfobot](https://t.me/userinfobot).
3. Whether to **enable server control** (agent tools).

Then it writes `.env`, runs `npm install`, and optionally installs/starts a systemd service.

### ⌨️ Fixed bottom keyboard
`📊 Status` · `/start` · `🤖 Model` — always available, no typing. `/start` works exactly like the `/start` command.

### 💵 Quota & Freebucks
- Each **session** costs the model's **hourly price** in Freebucks, charged **once** when the session starts. Each session lasts **1 hour**.
- The daily budget refills at **midnight Pacific** and does **not** carry over.
- Prices (Freebucks/hour) and hours if you spend the whole budget on one model:

| Model | FB/hour | sessions with 70 FB |
|---|---|---|
| GLM 5.3 Flash / Kimi | 5 | ~14 |
| MiMo 2.5 / Solar Pro 4 | 10 | ~7 |
| DeepSeek V4 Flash | 15 | ~4 |
| Luna | 20 | ~3 |
| Gemini 3.8 | 50 | ~1 |

- The `🎟 session-count cap` (today/7d/month) is a **separate** counter; the real limit is Freebucks.
- When exhausted, the bot shows the reset time and buttons: **➕ Add account**, **🔄 Switch account**, **🛒 Buy plan**.

### ⏳ Session & timer
- Fixed **1 hour** TTL on the server; chatting does **not** extend it.
- A warning (default 5 min, configurable) before expiry, and the renew button appears **only** then.
- Your next message auto-starts a fresh session (or fails over to another account).

### ⌨️ Server control (agent tools)
- Tools: `run_terminal_command`, `read_file`, `list_directory`, `write_file` (up to 8 steps).
- During work, the top message shows progress; when done it becomes the **status block** (model · session time left · quota), and the answer is sent in a **separate** message.
- **Dangerous commands** (`rm -rf`, `mkfs`, `dd`, `shutdown`, `curl|sh`, `:(){...}`, …) require a **Run/Cancel** confirmation; safe commands run automatically.
- The bot runs as the server user (root by default). Enable/disable with `ENABLE_SERVER_TOOLS` (also asked during install).

### 👤 Accounts & automatic failover
- `/account add <name>` → choose **🌐 Web login** (a login link; sign in on the Freebuff site) or **📋 Paste credentials.json**.
- Accounts are stored in `accounts/` (gitignored, mode 600); `default` is the server's own account.
- When the active account's quota is exhausted, the bot **switches to the next account automatically**, starts a new session, and tells you. Works on chat errors, session start, and renew.

### 📦 Release
```bash
./release.sh patch "short title" "full description"
./release.sh minor "New feature" "…"
./release.sh 1.2.3 "Exact version" "…"
```
It bumps the version, updates `CHANGELOG.md`, commits, tags `vX.Y.Z`, pushes, and creates a GitHub Release.

### License
MIT

---

## 🇮🇷 فارسی

ربات تلگرامی برای **مدیریت و چت کامل با فری‌باف روی سرور، بدون نیاز به SSH**.
همه‌چیز از داخل تلگرام — با دکمه‌های شیشه‌ای، کیبورد ثابت پایین، یا متن — انجام می‌شود.

### ✨ قابلیت‌ها
- 💬 **چت** با مدل‌های رایگان فری‌باف از تلگرام، با چند جلسهٔ گفتگوی مستقل و تاریخچهٔ جدا.
- 🤖 **مدل‌ها**: سوییچ واقعی (جلسه را می‌بندد و دوباره admission می‌زند)؛ نمایش قیمت هر مدل (باک/ساعت) و سهمیهٔ ساعتی امروز؛ مدل‌های غیرفعال خاکستری و غیرقابل‌انتخاب.
- 🎛 **نوع پاسخ**: 🧩 پیش‌فرض · ⚡ سریع (Lite) · 🛠 ساخت کامل (Build/MAX) · 🗺 برنامه‌ریزی (Plan).
- ⚙️ **تنظیمات**: نوع پاسخ، تبلیغات، مدل، هشدار انقضا.
- 👤 **چند اکانت** (استفادهٔ شریکی): افزودن با **ورود وب** (همان مکانیزم رسمی login، بدون سرور) یا پیست `credentials.json`؛ **سوییچ خودکار** به اکانت بعدی وقتی سهمیه تمام شود.
- ⏳ **تایمر جلسه**: جلسهٔ رایگان دقیقاً ۱ ساعت (سمت سرور)؛ شمارش زندهٔ زمان، هشدار قبل از انقضا، و دکمهٔ تمدید فقط نزدیک انقضا.
- 💵 **سهمیه (باک)**: نمایش مانده/استفاده‌شده و سقف تعداد جلسه؛ هنگام اتمام، پیام شفاف با دکمه‌های **افزودن/تغییر اکانت** و **خرید اشتراک**.
- ⌨️ **کنترل سرور (ابزارهای مدل)**: مدل می‌تواند `run_terminal_command`، `read_file`، `list_directory` و `write_file` اجرا کند؛ دستورهای خطرناک تأیید می‌گیرند.
- 🎛 **رابط**: دکمه‌های شیشه‌ای + کیبورد ثابت پایین (`📊 وضعیت` · `/start` · `🤖 مدل`) + سوییچ زبان FA/EN.
- 🔒 **امنیت**: فقط به `ALLOWED_USER_IDS` پاسخ می‌دهد.

### ⚠️ پیش‌نیاز: اول فری‌باف را روی سرور نصب کن
```bash
npm i -g freebuff
freebuff          # login
```
سایت: **https://freebuff.com** — بعد از لاگین، فایل `~/.config/manicode/credentials.json` ساخته می‌شود.

### 🚀 نصب (یک‌خطی)
```bash
git clone https://github.com/Aknuun/Freebuff-Guardian.git && cd Freebuff-Guardian && bash install.sh
```
نصب‌کننده می‌پرسد: توکن ربات ([@BotFather](https://t.me/BotFather))، آیدی عددی ([@userinfobot](https://t.me/userinfobot)) و فعال‌بودن کنترل سرور؛ بعد `.env` می‌سازد، `npm install` می‌زند و در صورت تمایل سرویس systemd نصب می‌کند.

### 💵 سهمیه و باک
- هر **جلسه** معادل **قیمت ساعتی** مدل است که **یک‌بار** در شروع کم می‌شود؛ هر جلسه **۱ ساعت** است.
- بودجهٔ روزانه نیمه‌شب **Pacific** پر می‌شود و منتقل نمی‌شود.
- قیمت‌ها (باک/ساعت): GLM/Kimi=۵ · MiMo/Solar=۱۰ · DeepSeek V4 Flash=۱۵ · Luna=۲۰ · Gemini=۵۰.
- `🎟 سقف تعداد جلسه` یک شمارندهٔ **جدا** است؛ محدودیت اصلی همان باک است.
- هنگام اتمام: زمان ریست + دکمه‌های **➕ افزودن اکانت**، **🔄 تغییر اکانت**، **🛒 خرید اشتراک**.

### ⏳ جلسه و تایمر
- TTL ثابت **۱ ساعت** سمت سرور؛ چت آن را تمدید نمی‌کند.
- هشدار قبل از انقضا (پیش‌فرض ۵ دقیقه، قابل تنظیم) و دکمهٔ تمدید **فقط** در آن زمان.
- پیام بعدی خودکار جلسهٔ تازه می‌سازد (یا به اکانت دیگری failover می‌کند).

### ⌨️ کنترل سرور (ابزارها)
- ابزارها: `run_terminal_command`، `read_file`، `list_directory`، `write_file` (تا ۸ گام).
- در حین کار، پیام بالایی پیشرفت را نشان می‌دهد؛ در پایان به **بلوک وضعیت** (مدل · زمان مانده · سهمیه) تبدیل می‌شود و جواب در پیام **جداگانه** می‌آید.
- دستورهای **خطرناک** تأیید **اجرا/لغو** می‌گیرند؛ بقیه خودکار.
- ربات با کاربر سرور (پیش‌فرض root) اجرا می‌شود. فعال/غیرفعال با `ENABLE_SERVER_TOOLS`.

### 👤 اکانت‌ها و failover
- `/account add <name>` → **🌐 ورود وب** یا **📋 پیست credentials.json**.
- اکانت‌ها در `accounts/` (خارج از گیت، mode 600)؛ `default` همان حساب سرور است.
- با تمام‌شدن سهمیهٔ اکانت فعال، ربات **خودکار روی اکانت بعدی** سوییچ می‌کند و پیام می‌دهد.

### 📦 انتشار
```bash
./release.sh patch "عنوان کوتاه" "توضیح کامل"
```

---

## 🇷🇺 Русский

Telegram-бот для **полного управления Freebuff и общения с ним на вашем сервере — без SSH**.
Всё делается из Telegram: inline-кнопки, фиксированная нижняя клавиатура или текст.

### ✨ Возможности
- 💬 **Чат** с бесплатными моделями Freebuff из Telegram, несколько независимых сессий.
- 🤖 **Модели**: настоящее переключение (закрывает сессию и заново делает admission); показывается цена (баков/час) и остаток часов; недоступные модели серые и не нажимаются.
- 🎛 **Режим ответа**: 🧩 По умолчанию · ⚡ Быстрый (Lite) · 🛠 Сборка (MAX) · 🗺 План.
- ⚙️ **Настройки**: режим, реклама, модель, предупреждение об истечении.
- 👤 **Несколько аккаунтов**: добавление через **вход в веб** (официальный login-flow, сервер не нужен) или вставкой `credentials.json`; **авто‑переключение** на следующий аккаунт при исчерпании лимита.
- ⏳ **Таймер сессии**: сессия ровно 1 час (на стороне сервера); отсчёт, предупреждение и кнопка продления только перед истечением.
- 💵 **Лимит (баки)**: показывается использовано/осталось и счётчик сессий; при исчерпании — понятное сообщение и кнопки **Добавить аккаунт / Сменить аккаунт / Купить план**.
- ⌨️ **Управление сервером (инструменты модели)**: `run_terminal_command`, `read_file`, `list_directory`, `write_file`. Опасные команды требуют подтверждения.
- 🎛 **Интерфейс**: inline-кнопки + нижняя клавиатура (`📊 Статус` · `/start` · `🤖 Модель`) + переключатель языка FA/EN.
- 🔒 **Безопасность**: отвечает только `ALLOWED_USER_IDS`.

### ⚠️ Требование: сначала установите Freebuff на сервер
```bash
npm i -g freebuff
freebuff          # войти
```
Сайт: **https://freebuff.com** — после входа создаётся `~/.config/manicode/credentials.json`.

### 🚀 Установка (одна строка)
```bash
git clone https://github.com/Aknuun/Freebuff-Guardian.git && cd Freebuff-Guardian && bash install.sh
```
Установщик спросит токен бота ([@BotFather](https://t.me/BotFather)), ваш числовой id ([@userinfobot](https://t.me/userinfobot)) и включение управления сервером; затем создаст `.env`, выполнит `npm install` и (по желанию) установит сервис systemd.

### 💵 Лимит и баки
- Каждая **сессия** стоит **часовую цену** модели в баках, списывается **один раз** при старте; сессия длится **1 час**.
- Дневной бюджет обновляется в **полночь по Pacific** и не переносится.
- Цены (баков/час): GLM/Kimi=5 · MiMo/Solar=10 · DeepSeek V4 Flash=15 · Luna=20 · Gemini=50.
- `🎟 счётчик сессий` (день/7д/месяц) — **отдельный**; главный лимит — баки.
- При исчерпании: время сброса + кнопки **➕ Добавить аккаунт**, **🔄 Сменить аккаунт**, **🛒 Купить план**.

### ⏳ Сессия и таймер
- Фиксированный TTL **1 час** на сервере; чат его не продлевает.
- Предупреждение перед истечением (по умолчанию 5 минут) и кнопка продления **только** тогда.
- Следующее сообщение автоматически начнёт новую сессию (или переключит аккаунт).

### ⌨️ Управление сервером
- Инструменты: `run_terminal_command`, `read_file`, `list_directory`, `write_file` (до 8 шагов).
- Во время работы верхнее сообщение показывает прогресс; в конце становится **блоком статуса** (модель · остаток времени · лимит), а ответ приходит **отдельным** сообщением.
- **Опасные команды** требуют подтверждения **Запустить/Отмена**; остальные выполняются автоматически.
- Бот работает от пользователя сервера (по умолчанию root). Вкл/выкл: `ENABLE_SERVER_TOOLS`.

### 👤 Аккаунты и failover
- `/account add <name>` → **🌐 Вход в веб** или **📋 Вставить credentials.json**.
- Аккаунты хранятся в `accounts/` (вне git, режим 600); `default` — аккаунт сервера.
- При исчерпании лимита активного аккаунта бот **автоматически переключается** на следующий и сообщает об этом.

### 📦 Релиз
```bash
./release.sh patch "краткий заголовок" "полное описание"
```

---

## License
MIT
