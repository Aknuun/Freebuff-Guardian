# 🛡️ Freebuff Guardian — نگهبان فری‌باف

[![version](https://img.shields.io/github/v/tag/Aknuun/Freebuff-Guardian?label=version&sort=semver)](https://github.com/Aknuun/Freebuff-Guardian/tags)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#مجوز)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

ربات تلگرامی برای **مدیریت و چت کامل با فری‌باف (Freebuff) روی سرور، بدون نیاز به SSH**.
همه‌چیز از داخل تلگرام — با دکمه‌های شیشه‌ای یا دستور متنی — قابل کنترل است.

---

## ✨ قابلیت‌ها

### 💬 چت با فری‌باف
- چت مستقیم با مدل‌های رایگان فری‌باف از تلگرام (`cost_mode: free`).
- پشتیبانی از چند **سشن چت مستقل** با تاریخچهٔ جداگانه برای هرکدام.
- محدودسازی خودکار طول پاسخ و تعداد پیام‌های تاریخچه برای کنترل توکن.
- تشخیص و رفع خطاهای رایج بک‌اند (۴۰۳ مود رایگان، ۴۰۹ تداخل سشن و…).

### 🤖 مدیریت مدل‌ها
- لیست کامل مدل‌های رایگان با `/models` یا دکمهٔ «مدل».
- **سوییچ واقعی مدل**: سشن رایگان سمت سرور به یک مدل قفل است؛ ربات سشن فعلی را
  می‌بندد و با مدل جدید `admission` می‌زند.
- انتخاب خودکار **agent** متناسب با مدل (رفع خطای `free_mode_invalid_agent_model`).
- نمایش دلیل دقیق سرور وقتی مدلی موقتاً در دسترس نیست (`withdrawn` / پنجرهٔ دسترسی).

### 🎛 تنظیمات فری‌باف
- تغییر **مود** (DEFAULT / AGENT / PLAN / PRINT).
- روشن/خاموش‌کردن **تبلیغات**.
- خواندن/نوشتن مستقیم همان فایل واقعی CLI: `~/.config/manicode/settings.json`.

### 🗂 مدیریت سشن‌ها
- ساخت، سوییچ، حذف (با تأیید) و پاک‌کردن تاریخچهٔ سشن‌ها.
- نمایش تعداد پیام و سشن فعال برای هر کاربر.

### 🖥 مدیریت سرور
- `/ps` — پروسه‌های پرحافظه.
- `/restart <svc>` — ری‌استارت سرویس systemd.
- `/freebuff start|stop|restart` — کنترل CLI فری‌باف داخل tmux.
- `/instances` و `/unlock` — وضعیت/آزادسازی قفل و instance.

### 🔐 رفع خطای takeover و مدیریت instance
- خواندن `freebuff-instance-owner.json` برای تشخیص CLI تعاملی فعال.
- پیش از هر چت، سشن فعال از `GET /api/v1/freebuff/session` خوانده می‌شود و از همان
  `instanceId` استفاده می‌شود تا سشن کاربر kick نشود (خطای ۴۰۹).
- قفل تک‌نمونه‌ای برای خود ربات.

### 🎛 رابط دکمه‌ای (Inline)
- `/menu` منوی کامل: وضعیت، تنظیمات، مدل، مود، تبلیغات، سشن‌ها، سرور و instance.
- ناوبری کامل بدون تایپ؛ حذف سشن با تأیید.

### 🔒 امنیت
- فقط به `ALLOWED_USER_IDS` پاسخ می‌دهد؛ غریبه‌ها بی‌پاسخ می‌مانند.
- توکن‌ها و اطلاعات حساس در `.env` و خارج از گیت نگه داشته می‌شوند.

---

## 🚀 نصب سریع
```bash
git clone https://github.com/Aknuun/Freebuff-Guardian.git
cd Freebuff-Guardian
cp .env.example .env
# .env را با TELEGRAM_BOT_TOKEN و ALLOWED_USER_IDS پر کن
npm install
node src/index.mjs   # تست
```

پیش‌نیاز: روی سرور باید فری‌باف نصب و لاگین شده باشد
(`~/.config/manicode/credentials.json` وجود داشته باشد).

## ⚙️ نصب به‌عنوان سرویس
```bash
cp freebuff-guardian.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now freebuff-guardian
journalctl -u freebuff-guardian -f
```

---

## 🎛 رابط دکمه‌ای (inline)
`/menu` (یا `/start`) یک منوی دکمه‌ای باز می‌کند و همهٔ کارها — وضعیت،
تنظیمات، انتخاب مدل، مود، تبلیغات، سشن‌ها، سرور و instance — بدون تایپ
دستور انجام می‌شوند. لیست سشن‌ها دکمهٔ سوییچ و حذف (با تأیید) دارد.

## 📋 دستورات ربات
| دستور | توضیح |
|---|---|
| `/menu` | منوی دکمه‌ای |
| `/status` | وضعیت سرور، مدل، مود، تبلیغات، سشن فعال |
| `/settings` | نمایش تنظیمات فری‌باف |
| `/mode M` | تغییر مود (DEFAULT/AGENT/PLAN/PRINT) |
| `/model [m]` | دیدن/تغییر مدل (سشن رایگان را سوییچ می‌کند) |
| `/models` | لیست مدل‌های رایگان |
| `/ads on\|off` | تبلیغات |
| `/new نام` | سشن چت جدید |
| `/sessions` | لیست سشن‌ها |
| `/switch نام` | سوییچ سشن |
| `/del نام` | حذف سشن |
| `/clear` | پاک‌کردن تاریخچه سشن فعال |
| `/ps` | پروسه‌های پرحافظه سرور |
| `/restart svc` | ری‌استارت سرویس systemd |
| `/freebuff restart\|stop\|start` | کنترل CLI فری‌باف در tmux |
| `/instances` | وضعیت قفل و instance فری‌باف |
| `/unlock` | آزادسازی قفل ربات |
| متن ساده | چت با فری‌باف |

---

## 🧠 نکات فنی (reverse-engineering)

### رفع خطای takeover
> Another freebuff instance took over this account.

این خطا وقتی رخ می‌دهد که دو نمونهٔ CLI/کلاینت با یک اکانت admission بزنند.
ربات پیش از هر چت سشن فعال را از `GET /api/v1/freebuff/session` می‌خواند و از
همان `instanceId` استفاده می‌کند؛ اگر سشنی نبود، خودش admission می‌زند.

### رفع خطای مود رایگان
> Free mode is only available through the freebuff CLI.

سرور مود رایگان را تنها وقتی می‌پذیرد که پیام `system` با این جمله شروع شود:
`You are Buffy, the coding agent behind Codebuff.`
`chat.mjs` این پیشوند را خودکار اضافه می‌کند و دستورهای فارسی بعد از آن می‌آیند.

### سوییچ مدل
سشن رایگان هم‌زمان فقط روی یک مدل قفل می‌شود. برای تغییر مدل، `/model`
سشن فعلی را می‌بندد و با مدل جدید admission می‌زند. اگر سرور مدل را
«در دسترس نبودن» برگرداند، همان دلیل به کاربر نشان داده می‌شود.

---

## 🏗 معماری
```
src/
├── index.mjs      نقطهٔ ورود
├── config.mjs     بارگذاری .env + credentials فری‌باف + نگاشت مدل→agent
├── state.mjs      ذخیرهٔ سشن‌ها و تاریخچه
├── settings.mjs   خواندن/نوشتن settings.json فری‌باف
├── instance.mjs   قفل‌ها و مدیریت instance (رفع takeover)
├── chat.mjs       موتور چت (session + agent-runs + chat/completions)
└── bot.mjs        رابط تلگرام، دکمه‌ها و دستورات
```

---

## 📦 انتشار نسخه (Release)
برای هر تغییر، نسخه را با اسکریپت زیر منتشر کن (کامیت + برچسب نسخه + push + GitHub Release):
```bash
./release.sh patch "توضیح قابلیت‌های جدید"
./release.sh minor "قابلیت بزرگ جدید"
./release.sh 1.2.3 "نسخهٔ خاص"
```
اسکریپت نسخهٔ `package.json` و `CHANGELOG.md` را به‌روزرسانی، تگ `vX.Y.Z`
می‌سازد و Release گیت‌هاب را با همین توضیحات ایجاد می‌کند.

## مجوز
MIT
