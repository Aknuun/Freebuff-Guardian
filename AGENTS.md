# Freebuff Guardian — دستورالعمل پروژه

## انتشار نسخه (مهم)
- بعد از **هر تغییر** در کد، نسخه را با اسکریپت زیر منتشر کن:
  `./release.sh <patch|minor|major|x.y.z> "خلاصهٔ قابلیت‌ها/تغییرات"`
- این اسکریپت نسخهٔ `package.json` و `CHANGELOG.md` را به‌روزرسانی، کامیت، تگ
  `vX.Y.Z` می‌سازد و push و GitHub Release ایجاد می‌کند.
- نسخه‌گذاری: `patch` برای باگ‌فیکس، `minor` برای قابلیت جدید، `major` برای تغییر ناسازگار.
- در پایان هر کار، خلاصهٔ تغییر + شمارهٔ نسخهٔ منتشرشده را گزارش کن.

## امنیت
- هرگز فایل `.env`، `state.json`، `node_modules` یا توکن‌ها را کامیت نکن (در `.gitignore` هستند).

## نکات فنی حیاتی
- مود رایگان: پیام `system` باید با «You are Buffy, the coding agent behind Codebuff.» شروع شود.
- `freebuff_instance_id` باید همان `instanceId` سشن admitted باشد؛ وگرنه خطای ۴۰۹.
- `agent` باید با مدل هماهنگ باشد (`config.mjs` → `FREE_AGENT_BY_MODEL`).
