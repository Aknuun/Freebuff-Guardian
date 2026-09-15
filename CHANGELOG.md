# Changelog

همهٔ تغییرات مهم این پروژه اینجا ثبت می‌شود. قالب بر اساس [Keep a Changelog](https://keepachangelog.com/fa/1.1.0/)
و نسخه‌گذاری بر اساس [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-09-15

### Changed
- تایمر سشن: نمایش زندهٔ زمان باقی‌مانده، هشدار خودکار ۵ دقیقه قبل، تمدید خودکار هنگام انقضا، دستور/دکمهٔ /renew و نمایش سهمیهٔ سشن و Freebucks

## [1.1.0] - 2026-09-15

### Changed
- نصب‌کنندهٔ تعاملی install.sh (دریافت توکن BotFather و آیدی عددی، چک پیش‌نیاز فری‌باف) + README با آدرس پروژهٔ اصلی https://freebuff.com

## [1.0.0] - 2026-09-15

### Added
- ربات تلگرامی نگهبان فری‌باف: چت، سشن‌ها، مدل، مود، تبلیغات، کنترل سرور و instance.
- رابط دکمه‌ای (inline) کامل با `/menu`.
- سوییچ واقعی مدل‌های رایگان (بستن سشن و admission مجدد).
- رفع خطاهای `free_mode_invalid_agent_model`، `free_mode_cli_required` و ۴۰۹ تداخل سشن.
- اسکریپت انتشار `release.sh` برای کامیت، تگ نسخه و GitHub Release.
