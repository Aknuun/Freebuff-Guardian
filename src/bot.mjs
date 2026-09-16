// bot.mjs — رابط تلگرام نگهبان فری‌باف
//
// دستورات:
//   /start /help        راهنما
//   /status             وضعیت سرور، فری‌باف و instanceها
//   /settings           نمایش تنظیمات
//   /mode [m]           تغییر نوع پاسخ (DEFAULT|LITE|MAX|PLAN)
//   /model [m]          دیدن/تغییر مدل
//   /ads on|off         تبلیغات
//   /new [نام]          جلسه چت جدید
//   /sessions           لیست جلسه‌ها
//   /switch <نام>       سوییچ جلسه
//   /del <نام>          حذف جلسه
//   /clear              پاک‌کردن تاریخچه جلسه فعال
//   /restart [svc]      ری‌استارت سرویس systemd
//   /ps                 پروسه‌های کلیدی سرور
//   /freebuff restart|stop|start  کنترل CLI فری‌باف
//   متن ساده            چت با فری‌باف

import TelegramBot from 'node-telegram-bot-api';
import { makeLogger } from './logger.mjs';
import { freeAgentForModel, freeModels } from './config.mjs';
import { FreebuffSettings } from './settings.mjs';
import { FreebuffChat, abortError } from './chat.mjs';
import { AccountStore } from './accounts.mjs';
import { AccountBackup } from './backup.mjs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execp = promisify(exec);
const log = makeLogger('bot');

// دکمه‌های ثابت پایین تلگرام (Reply Keyboard)
const REPLY_ACTIONS = {
  '📊 وضعیت': 'status', '📊 Status': 'status',
  '🤖 مدل': 'model', '🤖 Model': 'model',
};

// دستورهای خطرناک که قبل از اجرا باید تأیید کاربر را بگیرند
const DANGEROUS_CMD = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  />\s*\/dev\/[sh]d/i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\biptables\s+-F\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b/i,
  /\bkill\s+-9\s+-1\b/i,
  /\bmv\s+\/(\s|$)/i,
  /\b:\(\)\s*\{/,
  /\btruncate\s+-s\s*0\b/i,
  /\buserdel\b/i,
  />>?\s*\/etc\/(passwd|shadow)\b/i,
];

function isDangerousCommand(cmd) {
  return DANGEROUS_CMD.some((re) => re.test(cmd));
}

// قیمت تقریبی مدل‌ها (باک/ساعت) برای تخمین‌ها وقتی سهمیه‌ای کش نشده است
const FREE_PRICES = {
  'z-ai/glm-5.3-flash': 5,
  'z-ai/glm-5.2': 5,
  'z-ai/glm-5.1': 5,
  'z-ai/glm-5': 5,
  'crof/kimi-k3-eco': 5,
  'minimax/minimax-m3': 10,
  'mimo/mimo-v2.5': 10,
  'upstage/solar-pro4': 10,
  'deepseek/deepseek-v4-flash': 15,
  'deepseek/deepseek-v4-pro': 15,
  'openai/gpt-5.6-luna': 20,
  'openai/gpt-5.6-luna-es': 20,
  'anthropic/claude-fable-5': 20,
  'google/gemini-3.8-flash': 50,
};

/** ساخت دکمه با رنگ اختیاری (style: primary=آبی، success=سبز، danger=قرمز) */
function btn(text, callback_data, style) {
  const b = { text, callback_data };
  if (style) b.style = style;
  return b;
}

/** نام اکانت را از اطلاعات کاربر می‌سازد (ASCII و امن برای نام فایل) */
function accountSlug(user) {
  const base = String(user?.email || user?.name || '').toLowerCase();
  return base.split('@')[0].replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** خطوط سهمیه (استفاده‌شده/مانده) از پاسخ جلسه */
function quotaLines(q, lang = 'fa') {
  const en = lang === 'en';
  const lines = [];
  const w = q?.freeWindows;
  if (w) {
    lines.push(en
      ? `🎟 Session-count cap (separate from Bucks) — today: ${w.dayUsed}/${w.dayLimit} | 7d: ${w.weekUsed}/${w.weekLimit} | month: ${w.monthUsed}/${w.monthLimit}`
      : `🎟 سقف تعداد جلسه (جدا از باک) — امروز: ${w.dayUsed}/${w.dayLimit} | ۷روزه: ${w.weekUsed}/${w.weekLimit} | ماهانه: ${w.monthUsed}/${w.monthLimit}`);
  }
  const d = q?.freebucks?.daily;
  if (d) {
    const used = d.spent ?? Math.max(0, (d.limit ?? 0) - (d.remaining ?? 0));
    lines.push(en
      ? `💵 Bucks — left: ${d.remaining}/${d.limit} | used: ${used}`
      : `💵 باک — مانده: ${d.remaining}/${d.limit} | استفاده‌شده: ${used}`);
  }
  return lines;
}

/** نمایش خوانای مدت‌زمان میلی‌ثانیه‌ای */
function humanMs(ms, lang = 'fa') {
  if (ms == null) return '—';
  const total = Math.max(0, Math.round(ms / 60000));
  if (lang === 'en') {
    if (total < 1) return 'less than 1 min';
    if (total < 60) return `${total} min`;
    return `${Math.floor(total / 60)}h ${total % 60}m`;
  }
  if (total < 1) return 'کمتر از ۱ دقیقه';
  if (total < 60) return `${total} دقیقه`;
  return `${Math.floor(total / 60)} ساعت و ${total % 60} دقیقه`;
}

export class GuardianBot {
  constructor(cfg, state, instances) {
    this.cfg = cfg;
    this.state = state;
    this.instances = instances;
    this.settings = new FreebuffSettings();
    this.accounts = new AccountStore({
      dir: cfg.accountsDir,
      defaults: {
        authToken: cfg.fbAuthToken,
        fingerprintId: cfg.fbFingerprintId,
        userId: cfg.fbUser?.id ?? null,
        email: cfg.fbUser?.email ?? null,
        label: cfg.fbDefaultLabel,
        proxy: cfg.fbProxy ?? null,
      },
    });
    this.backups = new AccountBackup({
      accountsDir: cfg.accountsDir,
      credPath: cfg.fbCredPath,
      backupDir: cfg.backupDir,
    });
    this.pendingName = new Map(); // userId → منتظر نام دلخواه اکانت هستیم
    this.pendingLogin = new Map(); // userId → ورود وب در جریان { name, fingerprintId, fingerprintHash, expiresAt, timer }
    this.pendingChat = new Map(); // userId → پیامی که منتظر تأیید ساخت جلسه است { chatId, text, name }
    this.pendingSh = new Set(); // userId → منتظر دستور شل هستیم
    this.pendingConfirm = new Map(); // id → resolve برای تأیید دستور خطرناک
    this.pendingRestore = new Set(); // userId → منتظر فایل بکاپ برای ریستور
    this.pendingSwitch = new Map(); // userId → سوییچ اکانت در انتظار تأیید/انصراف
    this.pendingProxy = new Set(); // userId → منتظر آدرس پروکسی
    this.chat = new FreebuffChat({
      authToken: cfg.fbAuthToken,
      websiteUrl: cfg.websiteUrl,
      agent: cfg.fbAgent,
      instanceManager: instances,
      httpTimeoutMs: (cfg.httpTimeoutSec || 180) * 1000,
    });
    this.applyActiveAccount();
    this.busy = new Set(); // userId هایی که درخواست پردازشی در جریان دارند
    this.aborters = new Map(); // userId → AbortController برای توقف پروسهٔ در حال اجرا
    this.menuMsg = new Map(); // chatId → id آخرین منوی دکمه‌دار (برای پاک‌سازی خودکار)
    this.replyShown = new Set(); // chatId هایی که کیبورد ثابت برایشان فرستاده شده
    this.sessionWarned = false;
    this.lastProbe = 0;
    this.tgFloodUntil = 0; // تا این زمان به‌خاطر 429 تلگرام درخواست نمی‌فرستیم
    this.goneMessages = new Set(); // پیام‌هایی که حذف شده‌اند و دیگر ویرایش نمی‌شوند
    this.pendingBusy = new Map(); // userId → پیامی که هنگام busy ماند و بعد از توقف اجرا می‌شود
    this.renewTimer = null; // تایمر تمدید خودکار جلسه
    this.autoRenewOn = state.getMeta('autoRenew') === true;

    // دقیقهٔ هشدار انقضا: از state خوانده می‌شود و از طریق تنظیمات قابل تغییر است
    const fromState = state.getMeta('sessionWarnMin');
    this.warnMin = parseInt(fromState ?? process.env.SESSION_WARN_MIN ?? '5', 10) || 0;

    // هشدار پیش از انقضای جلسه (هر دقیقه بررسی؛ فقط یک‌بار در هر جلسه)
    this.warnTimer = setInterval(() => this.checkSessionWarn().catch((e) => log.warn('sessionWarn:', e.message)), 60000);
    this.warnTimer.unref?.();

    this.bot = new TelegramBot(cfg.telegramToken, { polling: true });
    this.bot.on('message', (msg) => this.onMessage(msg).catch((e) => log.error('onMessage:', e)));
    this.bot.on('callback_query', (q) => this.onCallback(q).catch((e) => log.error('onCallback:', e)));
    this.bot.on('polling_error', (e) => log.warn('polling:', e.message));

    // بکاپ خودکار روزانه (روزی یک‌بار فایل بکاپ برای کاربران فرستاده می‌شود)
    this.backupTimer = setInterval(() => this.maybeDailyBackup().catch((e) => log.warn('backup:', e.message)), 30 * 60000);
    this.backupTimer.unref?.();
    const backupBoot = setTimeout(() => this.maybeDailyBackup().catch(() => {}), 60000);
    backupBoot.unref?.();

    log.info('ربات نگهبان فری‌باف آماده است');
  }

  allowed(id) { return this.cfg.allowedUserIds.includes(id); }

  // ---------- زبان (سراسری برای ربات) ----------
  lang() { return this.state.getMeta('lang') === 'en' ? 'en' : 'fa'; }
  tr(fa, en) { return this.lang() === 'en' ? en : fa; }
  toggleLang() { return this.state.setMeta('lang', this.lang() === 'fa' ? 'en' : 'fa'); }

  // ---------- کیبورد ثابت پایین ----------
  replyKeyboardMarkup() {
    return {
      reply_markup: {
        keyboard: [[
          { text: this.tr('📊 وضعیت', '📊 Status'), style: 'primary' },
          { text: '/start', style: 'success' },
          { text: this.tr('🤖 مدل', '🤖 Model'), style: 'primary' },
        ]],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: 'پیام بفرست یا از دکمه‌ها استفاده کن',
      },
    };
  }

  showReplyKeyboard(chatId) {
    if (this.replyShown.has(chatId)) return null; // فقط یک‌بار؛ بعداً منو کافی است
    this.replyShown.add(chatId);
    return this.send(chatId, this.tr('⌨️ دکمه‌های ثابت پایین فعال شد.', '⌨️ Bottom keyboard enabled.'), this.replyKeyboardMarkup());
  }

  /** دکمه‌های ثابت پایین */
  async handleReplyButton(chatId, userId, action) {
    const u = this.state.user(userId);
    u.chatId = chatId;
    switch (action) {
      case 'status':
        return this.send(chatId, await this.statusText(userId), { reply_markup: { inline_keyboard: this.statusKeyboard() } });
      case 'model':
        await this.chat.activeSession().catch(() => {});
        return this.send(chatId, this.modelText(), { reply_markup: { inline_keyboard: this.modelKeyboard() } });
      default:
        return;
    }
  }

  // ---------- اکانت‌ها ----------
  activeAccountName() { return this.state.getMeta('activeAccount') || 'default'; }

  activeAccount() { return this.accounts.get(this.activeAccountName()) || this.accounts.get('default'); }

  /** پروکسی مؤثر اکانت default (از state یا env) */
  defaultProxy() {
    return this.state.getMeta('defaultProxy') ?? this.cfg.fbProxy ?? null;
  }

  /** اکانت با پروکسی مؤثر (default از state/env می‌گیرد) */
  effectiveAccount(acc) {
    if (!acc) return acc;
    const proxy = acc.name === 'default' ? this.defaultProxy() : (acc.proxy ?? null);
    return proxy === (acc.proxy ?? null) ? acc : { ...acc, proxy };
  }

  /** اکانت فعال را روی موتور چت اعمال می‌کند */
  applyActiveAccount(force = false) {
    const acc = this.effectiveAccount(this.activeAccount());
    if (acc) this.chat.useAccount(acc, force);
    return acc;
  }

  /** تعیین/حذف پروکسی اکانت فعال؛ آدرس مؤثر را برمی‌گرداند */
  setActiveProxy(value) {
    const a = this.activeAccount();
    if (!a) throw new Error(this.tr('اول یک اکانت وصل کن.', 'Connect an account first.'));
    const v = String(value || '').trim();
    const proxy = v && v !== 'off' && v !== 'none' ? v : null;
    if (proxy && !/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) {
      throw new Error(this.tr('آدرس پروکسی باید با http:// یا https:// شروع شود', 'Proxy URL must start with http:// or https://'));
    }
    if (a.name === 'default') this.state.setMeta('defaultProxy', proxy);
    else this.accounts.setProxy(a.name, proxy);
    this.applyActiveAccount(true);
    return proxy;
  }

  /** آیا هیچ اکانتی (پیش‌فرض یا فایلی) وصل نیست؟ */
  hasNoAccount() {
    return this.accounts.list().length === 0;
  }

  noAccountText() {
    return this.tr(
      '🔌 *هنوز هیچ اکانتی وصل نیست*\n\nبرای استفاده از نگهبان باید یک اکانت فری‌باف وصل کنی:\n۱) دکمهٔ «➕ افزودن اکانت» را بزن.\n۲) «🌐 ورود با وب» را انتخاب کن و در سایت فری‌باف لاگین کن.\n\nتا وقتی اکانت وصل نشود، چت و ساخت جلسه کار نمی‌کند.\nاگر قبلاً بکاپ گرفته‌ای، با «♻️ ریستور از فایل» برگردان.',
      '🔌 *No account connected yet*\n\nTo use the guardian you must connect a Freebuff account:\n1) Tap "➕ Add account".\n2) Choose "🌐 Web login" and sign in on the Freebuff site.\n\nUntil an account is connected, chat and sessions will not work.\nIf you backed up before, restore it with "♻️ Restore from file".',
    );
  }

  noAccountKeyboard() {
    return [
      [btn(this.tr('➕ افزودن اکانت', '➕ Add account'), 'acc:add', 'success')],
      [btn(this.tr('♻️ ریستور از فایل', '♻️ Restore from file'), 'acc:restore', 'primary')],
      [btn(this.tr('❓ راهنما', '❓ Help'), 'menu:help', 'primary')],
    ];
  }

  /**
   * خطوط سهمیهٔ یک اکانت. سهمیهٔ پاسخ سرور فقط وقتی جلسه فعال است معتبر است؛
   * برای اکانت بدون جلسه، آخرین مقدار ثبت‌شده نشان داده می‌شود (نه عدد تازهٔ
   * پیش‌فرض که گمراه‌کننده است).
   */
  quotaLinesForAccount(a, q) {
    const en = this.lang() === 'en';
    const active = q?.status === 'active';
    const cached = active ? null : this.chat.cachedQuota?.(a.name);
    const src = active ? q : cached;
    const out = [];
    if (active && q.remainingMs != null) {
      out.push(this.tr(`   ⏳ جلسه فعال — ${humanMs(q.remainingMs)} مانده`, `   ⏳ Active session — ${humanMs(q.remainingMs, 'en')} left`));
    }
    const daily = src?.freebucks?.daily;
    const w = src?.freeWindows;
    const price = src?.freebucks?.prices?.[this.settings.getModel()];
    if (!daily && !w) {
      out.push(this.tr('   💵 سهمیه: — (بدون جلسه فعال)', '   💵 quota: — (no active session)'));
      return out;
    }
    if (cached) out.push(this.tr('   ♻️ آخرین مقدار ثبت‌شده:', '   ♻️ last recorded:'));
    if (daily) {
      const left = Math.max(0, daily.remaining ?? 0);
      const used = daily.spent ?? Math.max(0, (daily.limit ?? 0) - left);
      out.push(this.tr(`   💵 مانده: *${left}* از ${daily.limit} باک · استفاده‌شده: ${used}`, `   💵 Left: *${left}* of ${daily.limit} Bucks · used: ${used}`));
      if (price) {
        const remainSessions = w
          ? Math.max(0, Math.min(w.dayLimit - w.dayUsed, w.weekLimit - w.weekUsed, w.monthLimit - w.monthUsed))
          : null;
        const bucksHours = Math.floor(left / price);
        const hours = remainSessions == null ? bucksHours : Math.min(bucksHours, remainSessions);
        const capNote = remainSessions != null && remainSessions <= bucksHours
          ? this.tr(` (محدود به ${remainSessions} جلسهٔ باقی‌مانده)`, ` (capped by ${remainSessions} sessions left)`)
          : '';
        out.push(this.tr(`   ⏱ حدود ${hours} ساعت با ${this.settings.getModel()}${capNote}`, `   ⏱ ~${hours}h with ${this.settings.getModel()}${capNote}`));
      }
    } else {
      out.push(this.tr('   💵 سهمیه: —', '   💵 quota: —'));
    }
    if (w) out.push(this.tr(
      `   🎟 سقف تعداد جلسه — امروز ${w.dayUsed}/${w.dayLimit} · ۷روزه ${w.weekUsed}/${w.weekLimit} · ماهانه ${w.monthUsed}/${w.monthLimit}`,
      `   🎟 Session-count cap — today ${w.dayUsed}/${w.dayLimit} · 7d ${w.weekUsed}/${w.weekLimit} · month ${w.monthUsed}/${w.monthLimit}`,
    ));
    return out;
  }

  /** تخمین تعداد اکانت لازم برای پوشش کامل بر اساس مدل و سقف‌ها */
  coverageAccounts(q) {
    const model = this.settings.getModel();
    const lq = this.chat.lastQuota;
    const w = q?.freeWindows ?? lq?.freeWindows;
    const price = q?.freebucks?.prices?.[model] ?? lq?.freebucks?.prices?.[model] ?? FREE_PRICES[model] ?? null;
    const dailyBucks = q?.freebucks?.daily?.limit ?? lq?.freebucks?.daily?.limit ?? 70;
    const dayLimit = w?.dayLimit ?? 5;
    const weekLimit = w?.weekLimit ?? 14;
    const monthLimit = w?.monthLimit ?? 40;
    const per = (cap, days) => (price ? Math.min(cap, Math.floor((dailyBucks * days) / price)) : cap);
    const dayH = per(dayLimit, 1);
    const weekH = per(weekLimit, 7);
    const monthH = per(monthLimit, 30);
    const need = (total, h) => (h > 0 ? Math.ceil(total / h) : null);
    return { day: need(24, dayH), week: need(168, weekH), month: need(720, monthH), dayH, weekH, monthH, model };
  }

  freeCoverageNote() {
    const c = this.coverageAccounts();
    return this.tr(
      `🧮 *پوشش کامل ۲۴/۷ با ${c.model}* (با سقف هر اکانت: روز ${c.dayH}h · هفته ${c.weekH}h · ماه ${c.monthH}h)\n• یک شبانه‌روز کامل: *${c.day}* اکانت\n• یک هفته کامل: *${c.week}* اکانت\n• یک ماه کامل: *${c.month}* اکانت`,
      `🧮 *Full 24/7 coverage with ${c.model}* (per-account caps: day ${c.dayH}h · week ${c.weekH}h · month ${c.monthH}h)\n• One full day: *${c.day}* accounts\n• One full week: *${c.week}* accounts\n• One full month: *${c.month}* accounts`,
    );
  }

  /** متن صفحهٔ اکانت‌ها: فقط اطلاعات اکانت فعال (نه بقیه) */
  async accountText() {
    const a = this.effectiveAccount(this.activeAccount());
    if (!a) return this.noAccountText();
    const q = await this.chat.accountQuota(a).catch(() => null);
    const actor = a.label || a.name;
    const out = [
      this.tr('👤 *اکانت‌های فری‌باف*', '👤 *Freebuff accounts*'),
      this.tr(`اکانت فعال: *${actor}* (\`${a.name}\`)`, `Active account: *${actor}* (\`${a.name}\`)`),
    ];
    if (a.email) out.push(this.tr(`ایمیل: ${a.email}`, `Email: ${a.email}`));
    out.push(this.tr(`🌐 پروکسی: ${a.proxy ? `\`${a.proxy}\`` : '—'}`, `🌐 Proxy: ${a.proxy ? `\`${a.proxy}\`` : '—'}`));
    out.push(...this.quotaLinesForAccount(a, q));
    out.push('');
    const c = this.coverageAccounts(q);
    if (c.month) out.push(this.tr(`🧮 برای ۲۴/۷ِ یک ماه کامل حدود *${c.month}* اکانت لازم است (جزئیات در ❓ راهنما).`, `🧮 A full month of 24/7 needs about *${c.month}* accounts (see ❓ Help).`));
    out.push(this.tr('برای دیدن/تعویض اکانت روی دکمه‌اش بزن.', 'Tap an account button to view/switch.'));
    return out.join('\n');
  }

  /** انتخاب نام نهایی اکانت (اگر نام دلخواه داده نشده باشد از اطلاعات کاربر) */
  nextAccountName(preferred, user) {
    let name = (preferred && String(preferred).trim()) || accountSlug(user) || 'account';
    name = String(name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'account';
    if (name === 'default' || this.accounts.has(name)) name = `${name}-${Date.now().toString(36).slice(-4)}`;
    return name;
  }

  /** شروع ورود وب برای افزودن اکانت (همان مکانیزم CLI login) */
  async startWebLogin(chatId, userId, name) {
    const valid = !!name && /^[\w.-]{1,40}$/.test(name) && name !== 'default';
    if (name && !valid) {
      return this.send(chatId, this.tr('❌ نام اکانت نامعتبر است (حروف/عدد/.-_ و نه default).', '❌ Invalid account name (letters/digits/.-_, not default).'));
    }
    const fingerprintId = valid
      ? `freebuff-guardian-${name}-${Date.now().toString(36)}`
      : `freebuff-guardian-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let code;
    try {
      code = await this.chat.startCliLogin(fingerprintId);
    } catch (e) {
      return this.send(chatId, `❌ ${e.message}`);
    }

    const prev = this.pendingLogin.get(userId);
    if (prev?.timer) clearInterval(prev.timer);

    const deadline = Math.min(Date.now() + 30 * 60000, code.expiresAt || 0) || Date.now() + 30 * 60000;
    const st = { name: valid ? name : null, fingerprintId: code.fingerprintId || fingerprintId, fingerprintHash: code.fingerprintHash, expiresAt: code.expiresAt };
    st.timer = setInterval(() => this.checkWebLogin(chatId, userId, deadline).catch((e) => log.warn('checkWebLogin:', e.message)), 5000);
    st.timer.unref?.();
    this.pendingLogin.set(userId, st);

    const kb = {
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: this.tr('🔗 باز کردن صفحهٔ ورود', '🔗 Open login page'), url: code.loginUrl, style: 'success' },
            { text: this.tr('📋 کپی آدرس لاگین', '📋 Copy login link'), copy_text: { text: code.loginUrl }, style: 'primary' },
          ],
          [
            btn(this.tr('🔄 بررسی تأیید', '🔄 Check now'), 'accwebcheck', 'primary'),
            btn(this.tr('🔗 ساخت لینک جدید', '🔗 New link'), `accwebnew:${st.name || ''}`, 'primary'),
          ],
          [btn(this.tr('❌ لغو', '❌ Cancel'), 'accwebcancel', 'danger')],
        ],
      },
    };
    const title = st.name ? `«${st.name}»` : this.tr('جدید', 'new');
    return this.send(chatId, this.tr(
      `🌐 *افزودن اکانت ${title}*\n\n۱) دکمهٔ «🔗 باز کردن صفحهٔ ورود» را بزن.\n۲) در سایت فری‌باف لاگین کن و تأیید کن.\n\n📋 اگر لازم شد، «کپی آدرس لاگین» لینک را کپی می‌کند.\n⚠️ اگر سایت گفت «This login link was already used»، دکمهٔ «🔗 ساخت لینک جدید» را بزن.\n\n⏳ منتظر تأیید هستم…`,
      `🌐 *Add account ${title}*\n\n1) Tap "🔗 Open login page".\n2) Sign in on the Freebuff site and confirm.\n\n📋 If needed, "Copy login link" copies the URL.\n⚠️ If the site says "This login link was already used", tap "🔗 New link".\n\n⏳ Waiting for confirmation…`,
    ), kb);
  }

  /** بررسی دوره‌ای ورود وب */
  async checkWebLogin(chatId, userId, deadline) {
    const st = this.pendingLogin.get(userId);
    if (!st) return;
    if (Date.now() > deadline || (st.expiresAt && Date.now() > st.expiresAt)) {
      clearInterval(st.timer);
      this.pendingLogin.delete(userId);
      return this.send(chatId, `⌛ زمان ورود اکانت ${st.name ? `«${st.name}»` : ''} تمام شد. دوباره «➕ افزودن اکانت» را بزن.`);
    }
    let r;
    try { r = await this.chat.pollCliLogin(st); } catch (e) { log.warn('poll login:', e.message); return; }
    if (!r?.ok) {
      if (r && r.pending === false) log.warn('وضعیت غیرمنتظرهٔ ورود:', JSON.stringify(r));
      return;
    }
    clearInterval(st.timer);
    this.pendingLogin.delete(userId);
    try {
      const finalName = st.name || this.nextAccountName(null, r.user);
      const acc = this.accounts.add(finalName, {
        default: {
          id: r.user.id,
          name: r.user.name,
          email: r.user.email,
          authToken: r.user.authToken,
          fingerprintId: r.user.fingerprintId || st.fingerprintId,
          fingerprintHash: r.user.fingerprintHash || st.fingerprintHash,
        },
      });
      return this.send(chatId, this.tr(`✅ اکانت \`${acc.name}\` ${acc.email ? `(${acc.email}) ` : ''}اضافه شد. برای فعال‌کردن روی آن بزن.`, `✅ Account \`${acc.name}\` ${acc.email ? `(${acc.email}) ` : ''}added. Tap it to activate.`), { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    } catch (e) {
      return this.send(chatId, `❌ ${e.message}`);
    }
  }

  /** انتخاب روش افزودن اکانت (نام اختیاری) */
  accountMethodKeyboard(name = '') {
    const suffix = `:${name}`;
    return [
      [btn(this.tr('🌐 ورود با وب', '🌐 Web login'), `accweb${suffix}`, 'success')],
      [btn(this.tr('✏️ با نام دلخواه', '✏️ Custom name'), 'accnamed')],
      [btn(this.tr('↩️ اکانت‌ها', '↩️ Accounts'), 'menu:account')],
    ];
  }

  accountKeyboard() {
    const active = this.activeAccountName();
    const rows = this.accounts.list().map((a) => {
      const label = a.label && a.label !== a.name ? `${a.name} — ${a.label}` : a.name;
      return [btn(`${a.name === active ? '✅ ' : ''}${label}`, `acc:${a.name}`, a.name === active ? 'success' : 'primary')];
    });
    rows.push([btn(this.tr('▶️ شروع جلسه', '▶️ Start session'), 'accstart', 'success')]);
    rows.push([
      btn(this.tr('➕ افزودن اکانت', '➕ Add account'), 'acc:add', 'success'),
      btn(this.tr('🗑 حذف اکانت', '🗑 Delete account'), 'accdel', 'danger'),
    ]);
    rows.push([btn(this.tr('🌐 پروکسی اکانت (ضد بن با تشخیص IP فری‌باف)', '🌐 Account proxy (anti-ban by Freebuff IP detection)'), 'acc:proxy', 'primary')]);
    rows.push([btn(this.tr('🧪 تست پروکسی', '🧪 Test proxy'), 'acctest', 'primary')]);
    rows.push([
      btn(this.tr('💾 بکاپ اکانت‌ها', '💾 Backup accounts'), 'acc:backup', 'primary'),
      btn(this.tr('♻️ ریستور از فایل', '♻️ Restore from file'), 'acc:restore', 'primary'),
    ]);
    rows.push([btn(this.tr('↩️ تنظیمات', '↩️ Settings'), 'menu:settings'), btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')]);
    return rows;
  }

  // ---------- بکاپ / ریستور اکانت‌ها ----------
  /** ارسال فایل بکاپ به یک چت */
  async sendBackup(chatId, file, count) {
    const caption = this.tr(
      `💾 *بکاپ اکانت‌های فری‌باف*\n${count} اکانت — برای ریستور، همین فایل را از «👤 اکانت‌ها → ♻️ ریستور از فایل» بفرست.`,
      `💾 *Freebuff accounts backup*\n${count} accounts — to restore, send this file via "👤 Accounts → ♻️ Restore from file".`,
    );
    try {
      await this.bot.sendDocument(chatId, file, { caption, parse_mode: 'Markdown' });
      return true;
    } catch (e) {
      log.warn('ارسال بکاپ ناموفق:', e.message);
      await this.send(chatId, this.tr(`❌ ارسال فایل بکاپ ناموفق بود: ${e.message}`, `❌ Failed to send backup file: ${e.message}`)).catch(() => {});
      return false;
    }
  }

  /** یک‌بار در روز بکاپ می‌سازد و برای کاربران می‌فرستد */
  async maybeDailyBackup() {
    if (this.hasNoAccount()) return;
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.getMeta('lastBackupDate') === today) return;
    const info = this.backups.create();
    const total = info.count + (info.hasDefault ? 1 : 0);
    this.state.setMeta('lastBackupDate', today);
    this.state.setMeta('lastBackupFile', info.name);
    for (const id of this.cfg.allowedUserIds) {
      const chatId = this.state.user(id).chatId;
      if (chatId) await this.sendBackup(chatId, info.file, total);
    }
    log.info(`بکاپ روزانه ساخته شد: ${info.name} (${total} اکانت)`);
  }

  /** ریستور از محتوای فایل بکاپ */
  async onDocument(msg, chatId, userId) {
    if (!this.pendingRestore.has(userId)) {
      return this.send(chatId, this.tr(
        'برای ریستور، اول از «👤 اکانت‌ها → ♻️ ریستور از فایل» استفاده کن.',
        'To restore, first use "👤 Accounts → ♻️ Restore from file".',
      ));
    }
    const doc = msg.document || {};
    if (!/\.json$/i.test(doc.file_name || '') && !/json/i.test(doc.mime_type || '')) {
      return this.send(chatId, this.tr('❌ فایل باید JSON بکاپ باشد.', '❌ The file must be a JSON backup.'));
    }
    this.pendingRestore.delete(userId);
    try {
      const link = await this.bot.getFileLink(doc.file_id);
      const res = await fetch(link);
      if (!res.ok) throw new Error(`دانلود فایل ناموفق (${res.status})`);
      const text = await res.text();
      const r = this.backups.restore(text);
      if (r.defaultCreds) {
        this.accounts.setDefault(r.defaultCreds);
        this.applyActiveAccount(true);
      } else {
        this.applyActiveAccount();
      }
      return this.send(chatId, this.tr(
        `✅ ریستور انجام شد.\n• افزوده: ${r.added}\n• به‌روزرسانی: ${r.updated}\n• اکانت default: ${r.defaultCreds ? 'بازیابی شد' : 'در بکاپ نبود'}`,
        `✅ Restore done.\n• Added: ${r.added}\n• Updated: ${r.updated}\n• Default account: ${r.defaultCreds ? 'restored' : 'not in backup'}`,
      ), { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    } catch (e) {
      return this.send(chatId, `❌ ${e.message}`, { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    }
  }

  /** حذف آخرین منوی دکمه‌دار این چت تا چت شلوغ نشود */
  async clearMenu(chatId) {
    const id = this.menuMsg.get(chatId);
    if (!id) return;
    this.menuMsg.delete(chatId);
    await this.bot.deleteMessage(chatId, id).catch(() => {});
  }

  /** آیا الان در محدودیت flood تلگرام هستیم؟ */
  tgFlooded() { return Date.now() < this.tgFloodUntil; }

  /** ثبت خطای 429 تلگرام و تنظیم مدت انتظار؛ true اگر خطای flood بود */
  noteTgError(e) {
    const retry = e?.response?.body?.parameters?.retry_after
      ?? Number((String(e?.message || '').match(/retry after (\d+)/i) || [])[1])
      ?? 0;
    if (e?.response?.statusCode === 429 || retry) {
      this.tgFloodUntil = Date.now() + (retry || 5) * 1000 + 1000;
      log.warn(`محدودیت تلگرام (429)؛ ${retry || 5} ثانیه صبر می‌کنیم`);
      return true;
    }
    return false;
  }

  /** ویرایش پیام با رعایت محدودیت flood (در زمان flood نادیده گرفته می‌شود) */
  async editText(chatId, messageId, text, extra = {}) {
    if (this.tgFlooded() || this.goneMessages.has(messageId)) return false;
    try {
      await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...extra });
      return true;
    } catch (e) {
      const desc = String(e?.response?.body?.description || e?.message || '');
      // محتوای پیام تغییری نکرده؛ خطا نیست
      if (/message is not modified/i.test(desc)) return true;
      if (/message to edit not found|message can't be edited/i.test(desc)) {
        // پیام حذف شده؛ دیگر تلاش نکن
        this.goneMessages.add(messageId);
        return false;
      }
      if (!this.noteTgError(e)) log.warn('ویرایش پیام ناموفق:', e.message);
      return false;
    }
  }

  /** حذف دکمه‌های پیام با رعایت محدودیت flood */
  async clearMarkup(chatId, messageId) {
    if (this.tgFlooded()) return false;
    try {
      await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      return true;
    } catch (e) {
      if (!this.noteTgError(e)) log.warn('حذف دکمه ناموفق:', e.message);
      return false;
    }
  }

  async send(chatId, text, extra = {}) {
    const { keep, ...opts } = extra;
    // اگر در flood هستیم، برای پیام‌های مهم تا پایان انتظار صبر کن (حداکثر ۶۰ ثانیه)
    if (this.tgFlooded()) {
      const wait = Math.min(60000, this.tgFloodUntil - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    let sent;
    try {
      sent = await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
    } catch (e) {
      // خطای flood را دوباره بدون Markdown تکرار نکن (فقط بدتر می‌شود)
      if (this.noteTgError(e)) throw e;
      // Markdown شکسته نباشد
      sent = await this.bot.sendMessage(chatId, text.replace(/[*_`]/g, ''), opts);
    }
    // پیام‌های منو (دکمهٔ درون‌خطی) جایگزین منوی قبلی می‌شوند
    if (!keep && opts.reply_markup?.inline_keyboard) {
      const prev = this.menuMsg.get(chatId);
      if (prev && prev !== sent.message_id) this.bot.deleteMessage(chatId, prev).catch(() => {});
      this.menuMsg.set(chatId, sent.message_id);
    }
    return sent;
  }

  async onMessage(msg) {
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    if (!chatId || !userId || !this.allowed(userId)) return; // سکوت برای غریبه‌ها

    if (msg.document) return this.onDocument(msg, chatId, userId);

    const text = (msg.text || '').trim();
    if (!text) return;

    if (REPLY_ACTIONS[text]) return this.handleReplyButton(chatId, userId, REPLY_ACTIONS[text]);
    if (text.startsWith('/')) return this.onCommand(msg, chatId, userId, text);
    return this.onChat(msg, chatId, userId, text);
  }

  // ---------- دستورات ----------
  async onCommand(msg, chatId, userId, text) {
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();
    const arg = rest.join(' ').trim();
    const u = this.state.user(userId);
    u.chatId = chatId;

    switch (cmd) {
      case '/start':
      case '/menu':
        await this.showReplyKeyboard(chatId);
        if (this.hasNoAccount()) {
          return this.send(chatId, this.noAccountText(), { reply_markup: { inline_keyboard: this.noAccountKeyboard() } });
        }
        return this.render(chatId, null, this.homeText(u), this.homeKeyboard(u));

      case '/help':
        return this.send(chatId, this.helpText(), { reply_markup: { inline_keyboard: this.helpKeyboard() } });

      case '/status':
        return this.send(chatId, await this.statusText(userId), { reply_markup: { inline_keyboard: this.statusKeyboard() } });

      case '/renew':
        return this.doRenew(chatId, null, userId);

      case '/settings':
        return this.send(chatId, this.settingsText(), { reply_markup: { inline_keyboard: this.settingsKeyboard() } });

      case '/mode': {
        if (!arg) return this.send(chatId, `نوع پاسخ فعلی: ${this.modeLabel(this.settings.getMode())}\nاستفاده: /mode DEFAULT|LITE|MAX|PLAN`);
        try {
          this.settings.setMode(arg.toUpperCase());
          return this.send(chatId, `✅ نوع پاسخ روی ${this.modeLabel(arg.toUpperCase())} تنظیم شد`);
        } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
      }

      case '/model': {
        if (!arg) {
          const model = this.settings.getModel();
          const agent = freeAgentForModel(model);
          return this.send(chatId, agent
            ? this.tr(`مدل فعلی: \`${model}\`\nایجنت رایگان: \`${agent}\`\nاستفاده: /model provider/model\nلیست: /models`, `Current model: \`${model}\`\nFree agent: \`${agent}\`\nUsage: /model provider/model\nList: /models`)
            : this.tr(`مدل فعلی: \`${model}\`\nاستفاده: /model provider/model\nلیست: /models`, `Current model: \`${model}\`\nUsage: /model provider/model\nList: /models`));
        }
        try {
          this.settings.validateModel(arg);
        } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
        await this.send(chatId, `⏳ در حال سوییچ به \`${arg}\`…`);
        try {
          // جلسه رایگان سمت سرور به مدل قفل است؛ برای تغییر، جلسه فعلی بسته و
          // جلسه جدید با مدل خواسته‌شده ساخته می‌شود.
          const session = await this.chat.switchSessionModel(arg);
          this.settings.setModel(arg);
          const agent = freeAgentForModel(arg);
          const left = session.remainingMs ? `\n⏳ باقیمانده جلسه: ${Math.round(session.remainingMs / 60000)} دقیقه` : '';
          return this.send(chatId, `✅ مدل روی \`${arg}\` تنظیم شد${agent ? `\nایجنت رایگان: \`${agent}\`` : ''}${left}`);
        } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
      }

      case '/account': {
        const [sub, name] = arg.split(/\s+/);
        if (!arg) {
          if (this.hasNoAccount()) return this.send(chatId, this.noAccountText(), { reply_markup: { inline_keyboard: this.noAccountKeyboard() } });
          return this.send(chatId, await this.accountText(), { reply_markup: { inline_keyboard: this.accountKeyboard() } });
        }
        if (sub === 'use') {
          if (!this.accounts.has(name)) return this.send(chatId, this.tr('❌ اکانت پیدا نشد.', '❌ Account not found.'));
          this.state.setMeta('activeAccount', name);
          this.applyActiveAccount();
          return this.send(chatId, this.tr(`✅ اکانت فعال: \`${name}\`\n${await this.statusText(userId)}`, `✅ Active account: \`${name}\`\n${await this.statusText(userId)}`), { reply_markup: { inline_keyboard: this.statusKeyboard() } });
        }
        if (sub === 'add') {
          const msg = name
            ? this.tr(`افزودن اکانت «${name}» — روش را انتخاب کن:`, `Add account "${name}" — choose a method:`)
            : this.tr('➕ *افزودن اکانت*\nروش را انتخاب کن (نام خودکار از ایمیل ساخته می‌شود):', '➕ *Add account*\nChoose a method (name auto-derived from email):');
          return this.send(chatId, msg, { reply_markup: { inline_keyboard: this.accountMethodKeyboard(name) } });
        }
        if (sub === 'del') {
          try { this.accounts.remove(name); } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
          if (this.activeAccountName() === name) { this.state.setMeta('activeAccount', 'default'); this.applyActiveAccount(); }
          return this.send(chatId, this.tr(`🗑 اکانت \`${name}\` حذف شد.`, `🗑 Account \`${name}\` deleted.`), { reply_markup: { inline_keyboard: this.accountKeyboard() } });
        }
        return this.send(chatId, this.tr('استفاده: /account | /account use <n> | /account add <n> | /account del <n>', 'Usage: /account | /account use <n> | /account add <n> | /account del <n>'));
      }

      case '/proxy': {
        const a = this.effectiveAccount(this.activeAccount());
        if (!a) return this.send(chatId, this.noAccountText(), { reply_markup: { inline_keyboard: this.noAccountKeyboard() } });
        if (!arg) {
          return this.send(chatId, this.tr(
            `🌐 پروکسی اکانت «${a.name}»: ${a.proxy ? `\`${a.proxy}\`` : '— (بدون پروکسی)'}\nفقط HTTP/HTTPS؛ تنظیم: \`/proxy http://user:pass@host:port\` · حذف: \`/proxy off\`\n❌ لینک \`t.me/proxy\` (MTProto) کار نمی‌کند.`,
            `🌐 Proxy for "${a.name}": ${a.proxy ? `\`${a.proxy}\`` : '— (none)'}\nHTTP/HTTPS only; set: \`/proxy http://user:pass@host:port\` · remove: \`/proxy off\`\n❌ \`t.me/proxy\` (MTProto) won't work.`,
          ), { reply_markup: { inline_keyboard: [[btn(this.tr('🌐 تنظیم پروکسی (ضد بن با تشخیص IP فری‌باف)', '🌐 Set proxy (anti-ban by Freebuff IP detection)'), 'acc:proxy', 'primary')]] } });
        }
        try {
          const cur = this.setActiveProxy(arg);
          return this.send(chatId, this.tr(
            cur ? `✅ پروکسی اکانت «${a.name}» تنظیم شد: \`${cur}\`` : `✅ پروکسی اکانت «${a.name}» حذف شد.`,
            cur ? `✅ Proxy for "${a.name}" set: \`${cur}\`` : `✅ Proxy for "${a.name}" removed.`,
          ));
        } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
      }

      case '/models': {
        await this.chat.activeSession().catch(() => {});
        const note = this.quotaExhaustedNote();
        return this.send(chatId, [
          this.tr('🤖 *مدل‌های رایگان قابل انتخاب*', '🤖 *Available free models*'),
          ...freeModels().map((m) => m === this.settings.getModel() ? `👉 \`${m}\`` : `• \`${m}\``),
          '',
          this.tr('با /model provider/model سوییچ کن.', 'Switch with /model provider/model.'),
          this.tr('⚠️ سرور ممکن است بعضی مدل‌ها را موقتاً «در دسترس نبودن» برگرداند.', '⚠️ The server may temporarily report some models as unavailable.'),
          ...(note ? ['', note] : []),
        ].join('\n'));
      }

      case '/ads': {
        if (arg !== 'on' && arg !== 'off') return this.send(chatId, 'استفاده: /ads on|off');
        this.settings.setAds(arg === 'on');
        return this.send(chatId, `✅ تبلیغات ${arg === 'on' ? 'روشن' : 'خاموش'} شد`);
      }

      case '/new': {
        const name = arg || `chat-${Object.keys(u.sessions).length + 1}`;
        this.state.ensureSession(userId, name);
        return this.send(chatId, this.tr(`✅ جلسه \`${name}\` ساخته شد و فعال شد`, `✅ Chat \`${name}\` created and activated`));
      }

      case '/sessions': {
        const names = this.state.listSessions(userId);
        if (!names.length) return this.send(chatId, this.tr('هیچ جلسهی نیست. /new بزن.', 'No chats yet. Send /new.'));
        return this.send(chatId, names.map((n) => `${n === u.activeSession ? '👉' : '•'} ${n} (${this.state.getSession(userId, n).messages.length} پیام)`).join('\n'));
      }

      case '/switch': {
        if (!arg || !this.state.getSession(userId, arg)) return this.send(chatId, this.tr('جلسه پیدا نشد. /sessions را ببین.', 'Chat not found. See /sessions.'));
        u.activeSession = arg;
        this.state.save();
        return this.send(chatId, this.tr(`✅ سوییچ شد به \`${arg}\``, `✅ Switched to \`${arg}\``));
      }

      case '/del': {
        if (!arg || !this.state.getSession(userId, arg)) return this.send(chatId, this.tr('جلسه پیدا نشد.', 'Chat not found.'));
        this.state.deleteSession(userId, arg);
        return this.send(chatId, this.tr(`🗑 جلسه \`${arg}\` حذف شد`, `🗑 Chat \`${arg}\` deleted`));
      }

      case '/clear': {
        if (!u.activeSession) return this.send(chatId, 'جلسه فعالی نیست.');
        this.state.clearMessages(userId, u.activeSession);
        return this.send(chatId, this.tr('🧹 تاریخچه جلسه فعال پاک شد', '🧹 Active chat history cleared'));
      }

      case '/sh':
        if (!arg) return this.send(chatId, this.tr('استفاده: `/sh <دستور>`\nمثال: `/sh ls -la /`', 'Usage: `/sh <command>`\ne.g. `/sh ls -la /`'));
        return this.runShell(chatId, arg);

      case '/ps': {
        try {
          const { stdout } = await execp('ps aux --sort=-%mem | head -12');
          return this.send(chatId, '```\n' + stdout.slice(0, 3000) + '\n```', { parse_mode: 'Markdown' });
        } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
      }

      case '/restart': {
        const svc = arg || 'negahban-opencode.service';
        if (!/^[\w.@-]+$/.test(svc)) return this.send(chatId, '❌ نام سرویس نامعتبر');
        await this.send(chatId, `♻️ در حال ری‌استارت ${svc}…`);
        try {
          const { stderr } = await execp(`systemctl restart ${svc}`);
          return this.send(chatId, `✅ ${svc} ری‌استارت شد${stderr ? `\n${stderr.slice(0, 300)}` : ''}`);
        } catch (e) { return this.send(chatId, `❌ ${e.message.slice(0, 300)}`); }
      }

      case '/freebuff': {
        const sub = arg.split(/\s+/)[0];
        if (!['restart', 'stop', 'start'].includes(sub)) {
          return this.send(chatId, 'استفاده: /freebuff restart|stop|start\n⚠️ اگر CLI تعاملی داخل tmux باز است، stop آن را می‌بندد!');
        }
        if (sub === 'stop') {
          const cli = this.instances.activeCli();
          if (!cli) return this.send(chatId, 'CLI تعاملی فعالی نیست.');
          await this.send(chatId, `⏳ بستن CLI تعاملی (pid ${cli.pid})…`);
          try { process.kill(cli.pid, 'SIGTERM'); } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
          return this.send(chatId, '✅ سیگنال SIGTERM ارسال شد. با /instances وضعیت را چک کن.');
        }
        // start/restart در tmux جدید
        try {
          await execp(`tmux kill-session -t freebuff 2>/dev/null; tmux new-session -d -s freebuff 'freebuff'`);
          return this.send(chatId, '✅ freebuff در tmux session «freebuff» اجرا شد');
        } catch (e) { return this.send(chatId, `❌ ${e.message.slice(0, 300)}`); }
      }

      case '/instances':
        return this.send(chatId, this.instances.statusText());

      case '/unlock': {
        try {
          const cur = JSON.parse(fs.readFileSync(this.instances.botLockFile, 'utf8'));
          if (cur.pid !== process.pid) {
            fs.unlinkSync(this.instances.botLockFile);
          }
        } catch { /* قفلی نیست */ }
        return this.send(chatId, '🔓 قفل ربات آزاد شد (در صورت وجود)');
      }

      default:
        return this.send(chatId, `دستور ناشناخته: ${cmd}\n${'`'} /help ${'`'} را ببین`);
    }
  }

  // ---------- رابط دکمه‌ای (inline) ----------
  /** ارسال/ویرایش پیام با دکمه‌ها */
  async render(chatId, messageId, text, keyboard) {
    const markup = { reply_markup: { inline_keyboard: keyboard } };
    if (messageId) {
      // پیام ویرایش‌شده همان منوی جاری است؛ اگر منوی دیگری باز است پاکش کن
      const prev = this.menuMsg.get(chatId);
      if (prev && prev !== messageId) this.bot.deleteMessage(chatId, prev).catch(() => {});
      this.menuMsg.set(chatId, messageId);
      try {
        return await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', ...markup });
      } catch (e) {
        if (!/not modified/i.test(e.message)) log.warn('edit ناموفق:', e.message);
        return null;
      }
    }
    return this.send(chatId, text, markup);
  }

  /** متن دکمهٔ ثابت تایمر در پایین منو */
  timerButtonText() {
    const left = this.chat.remainingMs();
    if (left == null) return this.tr('⏳ جلسه بسته — /start', '⏳ Session closed — /start');
    return this.tr(`⏳ جلسه: ${humanMs(left)} مانده`, `⏳ Session: ${humanMs(left, 'en')} left`);
  }

  /** روشن/خاموش‌کردن تمدید خودکار جلسه (تایمر در انتظار لغو می‌شود) */
  setAutoRenew(on) {
    this.autoRenewOn = !!on;
    this.state.setMeta('autoRenew', this.autoRenewOn);
    // تمدید خودکار به هشدار قبل از انقضا وابسته است؛ اگر خاموش بود روی ۵ دقیقه بگذار
    if (this.autoRenewOn && this.warnMin <= 0) {
      this.warnMin = 5;
      this.state.setMeta('sessionWarnMin', 5);
    }
    if (!this.autoRenewOn) this.cancelAutoRenew();
  }

  cancelAutoRenew() {
    if (this.renewTimer) { clearTimeout(this.renewTimer); this.renewTimer = null; }
  }

  homeKeyboard(u) {
    const langLabel = this.lang() === 'fa' ? '🌐 EN' : '🌐 فا';
    return [
      [
        btn(this.tr(`💬 جلسه‌ها (${u.activeSession ?? '—'})`, `💬 Chats (${u.activeSession ?? '—'})`), 'menu:sessions', 'primary'),
        btn(this.tr('⚙️ تنظیمات', '⚙️ Settings'), 'menu:settings', 'primary'),
        btn(this.tr('👤 اکانت‌ها', '👤 Accounts'), 'menu:account', 'primary'),
      ],
      [btn(this.tr('➕ جلسه جدید', '➕ New chat'), 'menu:new', 'success'), btn(this.tr('🧹 پاک‌کردن تاریخچه', '🧹 Clear history'), 'menu:clear', 'danger')],
      [
        btn(this.tr('🖥 سرور', '🖥 Server'), 'menu:server', 'primary'),
        btn(langLabel, 'menu:lang'),
        btn(this.tr('❓ راهنما', '❓ Help'), 'menu:help', 'primary'),
      ],
      [btn(this.timerButtonText(), 'menu:timer', 'success')],
    ];
  }

  helpKeyboard() {
    return [
      [btn(this.tr('💵 سهمیه و باک', '💵 Quota & Bucks'), 'help:quota', 'primary')],
      [btn(this.tr('⏳ جلسه و تایمر', '⏳ Session & timer'), 'help:session', 'primary')],
      [btn(this.tr('🤖 مدل‌ها', '🤖 Models'), 'help:model', 'primary')],
      [btn(this.tr('👤 اکانت‌ها', '👤 Accounts'), 'help:account', 'primary')],
      [btn(this.tr('💬 چت و جلسه‌ها', '💬 Chat & sessions'), 'help:chat', 'primary')],
      [btn(this.tr('🖥 سرور', '🖥 Server'), 'help:server', 'primary')],
      [btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
    ];
  }

  helpText() {
    return this.tr('❓ *راهنما*\nیک بخش را انتخاب کن تا توضیحش همین‌جا بیاید.', '❓ *Help*\nPick a section to show its explanation here.');
  }

  helpSectionText(section) {
    const fa = {
      quota: [
        '💵 *سهمیه و باک*',
        '',
        'فری‌باف هر روز یک بودجهٔ «باک» می‌دهد که بین همهٔ مدل‌ها مشترک است.',
        '• هر جلسه، هنگام شروع، معادل قیمت ساعتی مدل از باک کم می‌کند (یک‌بار، نه هر پیام).',
        '• قیمت‌ها (باک برای هر ساعت): GLM=۵ · Kimi=۵ · MiMo=۱۰ · Solar=۱۰ · DeepSeek V4 Flash=۱۵ · Luna=۲۰ · Gemini=۵۰',
        '• «🎟 سقف تعداد جلسه» جداست (امروز ۵ · ۷روزه ۱۴ · ماهانه ۴۰) و هر جلسه فقط ۱ ساعت است.',
        '• پس برای GLM کم‌هزینه، سقف جلسه زودتر تمام می‌شود تا باک: هر اکانت روزی ~۵ ساعت (نه ۱۴).',
        '• بودجه هر روز نیمه‌شب Pacific پر می‌شود و منتقل نمی‌شود.',
        '• بعضی مدل‌ها «پریمیوم»‌اند و سقف روزانهٔ جدا هم دارند.',
        '',
        '📊 استفاده‌شده و مانده در «وضعیت» و «👤 اکانت‌ها» نوشته می‌شود.',
      ].join('\n'),
      session: [
        '⏳ *جلسه و تایمر*',
        '',
        'هر جلسه رایگان دقیقاً ۱ ساعت عمر می‌کند و چت‌کردن تمدیدش نمی‌کند.',
        '• دکمهٔ «⏳ جلسه» زمان باقی‌مانده را نشان می‌دهد.',
        '• ۵ دقیقه قبل از انقضا هشدار می‌آید (در تنظیمات قابل تغییر).',
        '• «🔄 تمدید جلسه» تایمر را از نو می‌کند؛ «/start» منوی اصلی را باز می‌کند.',
        '• پیام بعدی هم خودکار جلسه تازه می‌سازد؛ پس وقفه‌ای حس نمی‌کنی.',
      ].join('\n'),
      model: [
        '🤖 *مدل‌ها*',
        '',
        'از «🤖 مدل» مدل را عوض کن؛ agent هماهنگ خودکار انتخاب می‌شود.',
        'کنار هر مدل قیمت (باک/ساعت) و سهمیهٔ ساعتی امروز با آن مدل نوشته شده.',
        '• ارزان‌ترین: GLM 5.3 Flash · Kimi (۵ FB/ساعت)',
        '• متوسط: MiMo 2.5 · Solar Pro 4 (۱۰)',
        '• گران‌تر: DeepSeek V4 Flash (۱۵) · Luna (۲۰) · Gemini (۵۰)',
      ].join('\n'),
      account: [
        '👤 *اکانت‌ها*',
        '',
        'برای استفادهٔ شریکی؛ هرکس اکانت خودش.',
        '«➕ افزودن اکانت» را بزن و یکی را انتخاب کن:',
        '• «🌐 ورود با وب» — لینک لاگین می‌دهد (با دکمهٔ کپی آدرس)؛ در سایت فری‌باف لاگین کن.',
        '• «✏️ با نام دلخواه» — قبلش اسم بده.',
        '',
        'هر اکانت جلسه و باک مستقل دارد؛ روی دکمهٔ هر اکانت بزن تا فعال شود و اطلاعاتش همان‌جا نشان داده شود.',
        '• «▶️ شروع جلسه» برای اکانت فعال جلسه می‌سازد.',
        '• «🗑 حذف اکانت» اکانت فعال را حذف می‌کند (default حذف نمی‌شود).',
        '• «🌐 پروکسی اکانت (ضد بن با تشخیص IP فری‌باف)» برای تغییر IP هر اکانت و رفع ip_capped.',
        '  فقط پروکسی HTTP/HTTPS (مثل `http://1.2.3.4:8080`). لینک t.me/proxy (MTProto) کار نمی‌کند.',
        '• «💾 بکاپ اکانت‌ها» فایل پشتیبان می‌سازد و «♻️ ریستور از فایل» آن را برمی‌گرداند.',
      ].join('\n'),
      chat: [
        '💬 *چت و جلسه‌ها*',
        '',
        'یک پیام معمولی بفرست تا با مدل فعال چت کنی.',
        '• «➕ جلسه جدید» یک گفتگوی جدا می‌سازد.',
        '• «💬 جلسه‌ها» برای سوییچ/حذف (حذف با تأیید).',
        '• «🧹 پاک‌کردن تاریخچه» پیام‌های جلسه فعال را پاک می‌کند.',
      ].join('\n'),
      server: [
        '🖥 *سرور*',
        '',
        '• «📈 پروسه‌ها» — پروسه‌های پرحافظه',
        '• «⌨️ اجرای دستور» — یک دستور شل روی سرور اجرا می‌کند (معادل /sh)',
        '• «♻️ ری‌استارت freebuff» و «⏹ توقف CLI»',
        '• «🔐 وضعیت instance» و «🔓 آزادسازی قفل»',
      ].join('\n'),
      settings: [
        '⚙️ *تنظیمات*',
        '',
        '• «🎛 نوع پاسخ» — 🧩 پیش‌فرض · ⚡ سریع (Lite) · 🛠 ساخت کامل (Build/MAX) · 🗺 برنامه‌ریزی (Plan)',
        '• «📢 تبلیغات» — روشن/خاموش',
        '• «🤖 مدل» — مدل فعال',
        '• «⏰ هشدار انقضا» — چند دقیقه قبل هشدار بدهد',
        '• «🔁 تمدید خودکار» — ۵ دقیقه قبل هشدار می‌دهد و سر موعد جلسه را خودکار تازه می‌کند (با دکمهٔ لغو)',
        '• «🌐» بین دو دکمهٔ سرور و راهنما زبان را عوض می‌کند',
      ].join('\n'),
    };
    const en = {
      quota: [
        '💵 *Quota & Bucks*',
        '',
        'Freebuff gives a daily Bucks budget shared across all models.',
        '• Starting a session charges the model\'s hourly price once (not per message).',
        '• Prices (Bucks/hour): GLM=5 · Kimi=5 · MiMo=10 · Solar=10 · DeepSeek V4 Flash=15 · Luna=20 · Gemini=50',
        '• "🎟 Session-count cap" is separate (today 5 · 7d 14 · month 40) and each session is only 1 hour.',
        '• So for cheap GLM the session cap runs out before Bucks: each account gets ~5h/day (not 14).',
        '• The budget refills at midnight Pacific and does not carry over.',
        '• Some models are "premium" and also have a separate daily cap.',
        '',
        '📊 Used/left is shown in *Status* and *Accounts*.',
      ].join('\n'),
      session: [
        '⏳ *Session & timer*',
        '',
        'Each free session lasts exactly 1 hour and chatting does NOT extend it.',
        '• The "⏳" button shows the remaining time.',
        '• You get a warning 5 min before expiry (configurable).',
        '• "🔄 Renew session" resets the timer; "/start" opens the home menu.',
        '• Your next message auto-starts a fresh session, so no interruption.',
      ].join('\n'),
      model: [
        '🤖 *Models*',
        '',
        'Switch model from "🤖 Model"; the matching agent is picked automatically.',
        'Each model shows its price (Bucks/hour) and today\'s hours left with it.',
        '• Cheapest: GLM 5.3 Flash · Kimi (5 FB/h)',
        '• Mid: MiMo 2.5 · Solar Pro 4 (10)',
        '• Pricier: DeepSeek V4 Flash (15) · Luna (20) · Gemini (50)',
      ].join('\n'),
      account: [
        '👤 *Accounts*',
        '',
        'For shared use; each person uses their own account.',
        'Tap "➕ Add account" and choose:',
        '• "🌐 Web login" — gives a login link (with a copy-link button); sign in on the Freebuff site.',
        '• "✏️ Custom name" — set a name first.',
        '',
        'Each account has its own session and Bucks; tap an account button to activate it and see its details right here.',
        '• "▶️ Start session" starts a session for the active account.',
        '• "🗑 Delete account" deletes the active account (default cannot be deleted).',
        '• "🌐 Account proxy (anti-ban by Freebuff IP detection)" gives each account its own IP (fixes ip_capped).',
        '  HTTP/HTTPS only (e.g. `http://1.2.3.4:8080`). A t.me/proxy (MTProto) link will NOT work.',
        '• "💾 Backup accounts" creates a backup file and "♻️ Restore from file" brings it back.',
      ].join('\n'),
      chat: [
        '💬 *Chat & sessions*',
        '',
        'Send a normal message to chat with the active model.',
        '• "➕ New chat" starts a separate conversation.',
        '• "💬 Chats" to switch/delete (delete asks for confirmation).',
        '• "🧹 Clear history" clears the active chat.',
      ].join('\n'),
      server: [
        '🖥 *Server*',
        '',
        '• "📈 Processes" — top memory processes',
        '• "⌨️ Run command" — run a shell command on the server (same as /sh)',
        '• "♻️ Restart freebuff" and "⏹ Stop CLI"',
        '• "🔐 Instance status" and "🔓 Release lock"',
      ].join('\n'),
      settings: [
        '⚙️ *Settings*',
        '',
        '• "🎛 Response mode" — 🧩 Default · ⚡ Fast (Lite) · 🛠 Build (MAX) · 🗺 Plan',
        '• "📢 Ads" — on/off',
        '• "🤖 Model" — active model',
        '• "⏰ Expiry warning" — minutes before expiry',
        '• "🔁 Auto-renew" — warns 5 min before and renews the session automatically (with a cancel button)',
        '• "🌐" between Server and Help switches the language',
      ].join('\n'),
    };
    const sections = this.lang() === 'en' ? en : fa;
    const base = sections[section] || this.helpText();
    if (section === 'account') return `${base}\n\n${this.freeCoverageNote()}`;
    return base;
  }

  settingsText() {
    const warn = this.warnMin > 0
      ? this.tr(`${this.warnMin} دقیقه قبل از انقضا`, `${this.warnMin} min before expiry`)
      : this.tr('خاموش', 'off');
    const auto = this.autoRenewOn
      ? this.tr(`روشن (${this.warnMin} دقیقه قبل هشدار می‌دهد)`, `on (warns ${this.warnMin} min before)`)
      : this.tr('خاموش', 'off');
    return [
      this.tr('⚙️ *تنظیمات*', '⚙️ *Settings*'),
      this.tr(`🎛 نوع پاسخ: ${this.modeLabel(this.settings.getMode())}`, `🎛 Response mode: ${this.modeLabel(this.settings.getMode())}`),
      this.tr(`📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`, `📢 Ads: ${this.settings.getAds() ? 'on' : 'off'}`),
      this.tr(`🤖 مدل: \`${this.settings.getModel()}\``, `🤖 Model: \`${this.settings.getModel()}\``),
      this.tr(`👤 اکانت فعال: \`${this.activeAccountName()}\``, `👤 Active account: \`${this.activeAccountName()}\``),
      this.tr(`⏰ هشدار انقضای جلسه: ${warn}`, `⏰ Session expiry warning: ${warn}`),
      this.tr(`🔁 تمدید خودکار جلسه: ${auto}`, `🔁 Auto-renew session: ${auto}`),
    ].join('\n');
  }

  settingsKeyboard() {
    const warn = this.warnMin;
    const mark = (n) => (warn === n ? '✅ ' : '');
    const warnBtn = (n, label) => btn(`${mark(n)}${label}`, `warn:${n}`, warn === n ? 'success' : undefined);
    return [
      [
        btn(this.tr(`🎛 نوع پاسخ: ${this.modeLabel(this.settings.getMode())}`, `🎛 Mode: ${this.modeLabel(this.settings.getMode())}`), 'menu:mode', 'primary'),
        btn(this.tr(`📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`, `📢 Ads: ${this.settings.getAds() ? 'on' : 'off'}`), 'menu:ads', this.settings.getAds() ? 'success' : 'danger'),
      ],
      [btn(this.tr(`🤖 مدل: ${this.settings.getModel()}`, `🤖 Model: ${this.settings.getModel()}`), 'menu:model', 'primary')],
      [btn(this.tr(`👤 اکانت: ${this.activeAccountName()}`, `👤 Account: ${this.activeAccountName()}`), 'menu:account', 'primary')],
      [warnBtn(0, this.tr('خاموش', 'off')), warnBtn(2, '2m'), warnBtn(5, '5m'), warnBtn(10, '10m')],
      [btn(this.tr(`🔁 تمدید خودکار: ${this.autoRenewOn ? 'روشن' : 'خاموش'}`, `🔁 Auto-renew: ${this.autoRenewOn ? 'on' : 'off'}`), 'menu:autorenew', this.autoRenewOn ? 'success' : 'danger')],
      [btn(this.tr('🔄 تمدید جلسه', '🔄 Renew session'), 'menu:renew', 'success')],
      [btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
    ];
  }

  homeText(u) {
    const left = this.chat.remainingMs();
    const fa = `🛡️ *نگهبان فری‌باف*\n\nمدل: \`${this.settings.getModel()}\`\nجلسه فعال: \`${u.activeSession ?? '—'}\`${left == null ? '' : `\n⏳ جلسه فری‌باف: ${humanMs(left)} دیگر`}\n\nاز دکمه‌ها استفاده کن یا پیام بفرست تا چت کند.`;
    const en = `🛡️ *Freebuff Guardian*\n\nModel: \`${this.settings.getModel()}\`\nActive chat: \`${u.activeSession ?? '—'}\`${left == null ? '' : `\n⏳ Freebuff session: ${humanMs(left, 'en')} left`}\n\nUse the buttons or just send a message to chat.`;
    return this.tr(fa, en);
  }

  /** هشدار اتمام سهمیه (اگر باک امروز صفر باشد) */
  quotaExhaustedNote() {
    const daily = this.chat.lastQuota?.freebucks?.daily;
    if (!daily || daily.remaining > 0) return '';
    const ms = daily.resetAt ? Date.parse(daily.resetAt) - Date.now() : null;
    const resetFa = ms > 0 ? `؛ ریست تا ${humanMs(ms, 'fa')} دیگر` : '';
    const resetEn = ms > 0 ? `; resets in ${humanMs(ms, 'en')}` : '';
    return this.tr(
      `🚫 سهمیهٔ باک امروز تمام شده${resetFa}.\nمی‌توانی پلن را ارتقا بدهی: https://freebuff.com/plans`,
      `🚫 Daily Bucks are used up${resetEn}.\nYou can upgrade: https://freebuff.com/plans`,
    );
  }

  modelText() {
    const cur = this.settings.getModel();
    const base = this.tr(
      `🤖 *مدل‌های رایگان*\nفعلی: \`${cur}\`\nجلو هر مدل مصرفش (باک/ساعت · سهمیهٔ ساعتی امروز) نوشته شده.\n🟩 فعلی · 🟦 قابل انتخاب · ⬜ غیرفعال (فعلاً در دسترس نیست)`,
      `🤖 *Free models*\nCurrent: \`${cur}\`\nEach model shows its cost (Bucks/hour · today's hours left).\n🟩 current · 🟦 selectable · ⬜ disabled (unavailable)`,
    );
    // هشدار سهمیه در پایین متن (نه بالا)
    const note = this.quotaExhaustedNote();
    return note ? `${base}\n\n${note}` : base;
  }

  modelKeyboard() {
    const cur = this.settings.getModel();
    const fb = this.chat.lastQuota?.freebucks;
    const remaining = fb?.daily?.remaining;
    const prices = fb?.prices ?? {};
    const limits = this.chat.lastQuota?.rateLimitsByModel ?? {};
    const rows = freeModels().map((m) => {
      const p = prices[m];
      const cap = limits[m];
      const capped = cap && cap.recentCount >= cap.limit;
      const available = p != null && !capped;
      const hours = (available && remaining != null) ? Math.floor(remaining / p) : null;
      const info = p != null ? ` · ${p}FB${hours != null ? ` · ${hours}h` : ''}` : '';
      if (!available) {
        const label = `${m}${info}${this.tr(' — غیرفعال', ' — disabled')}`;
        return [{ text: label, callback_data: `noop:${m}`, disabled: true }];
      }
      return [btn(`${m === cur ? '✅ ' : ''}${m}${info}`, `model:${m}`, m === cur ? 'success' : 'primary')];
    });
    rows.push([btn(this.tr('↩️ تنظیمات', '↩️ Settings'), 'menu:settings'), btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')]);
    return rows;
  }

  modeLabel(id) {
    return {
      DEFAULT: this.tr('🧩 پیش‌فرض', '🧩 Default'),
      LITE: this.tr('⚡ سریع (Lite)', '⚡ Fast (Lite)'),
      MAX: this.tr('🛠 ساخت کامل (Build)', '🛠 Build (MAX)'),
      PLAN: this.tr('🗺 برنامه‌ریزی (Plan)', '🗺 Plan'),
    }[id] || id;
  }

  modeKeyboard() {
    const cur = this.settings.getMode();
    const ids = ['DEFAULT', 'LITE', 'MAX', 'PLAN'];
    const rows = [];
    for (let i = 0; i < ids.length; i += 2) {
      rows.push(ids.slice(i, i + 2).map((id) => btn(`${id === cur ? '✅ ' : ''}${this.modeLabel(id)}`, `mode:${id}`, id === cur ? 'success' : 'primary')));
    }
    rows.push([btn(this.tr('↩️ تنظیمات', '↩️ Settings'), 'menu:settings'), btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')]);
    return rows;
  }

  adsKeyboard() {
    const on = this.settings.getAds();
    return [
      [btn(`${on ? '✅ ' : ''}${this.tr('روشن', 'On')}`, 'ads:on', 'success'), btn(`${!on ? '✅ ' : ''}${this.tr('خاموش', 'Off')}`, 'ads:off', 'danger')],
      [btn(this.tr('↩️ تنظیمات', '↩️ Settings'), 'menu:settings'), btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
    ];
  }

  sessionsKeyboard(userId) {
    const u = this.state.user(userId);
    const rows = this.state.listSessions(userId).map((n) => [
      btn(`${n === u.activeSession ? '✅ ' : ''}${n}`, `ses:${encodeURIComponent(n)}`, n === u.activeSession ? 'success' : 'primary'),
      btn('🗑', `delq:${encodeURIComponent(n)}`, 'danger'),
    ]);
    rows.push([btn(this.tr('➕ جلسه جدید', '➕ New chat'), 'menu:new', 'success')]);
    rows.push([btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')]);
    return rows;
  }

  sessionsText(userId) {
    const names = this.state.listSessions(userId);
    if (!names.length) return this.tr('هیچ جلسهی نیست. ➕ را بزن.', 'No chats yet. Tap ➕.');
    const u = this.state.user(userId);
    const list = names
      .map((n) => `${n === u.activeSession ? '👉' : '•'} \`${n}\` (${this.state.getSession(userId, n).messages.length} ${this.tr('پیام', 'msgs')})`)
      .join('\n');
    return `${this.tr('💬 *جلسه‌ها*', '💬 *Chats*')}\n${list}`;
  }

  serverKeyboard() {
    return [
      [btn(this.tr('🔄 تمدید جلسه', '🔄 Renew session'), 'menu:renew', 'success')],
      [btn(this.tr('📈 پروسه‌ها', '📈 Processes'), 'svc:ps', 'primary')],
      [btn(this.tr('⌨️ اجرای دستور (/sh)', '⌨️ Run command (/sh)'), 'svc:sh', 'primary')],
      [btn(this.tr('♻️ ری‌استارت freebuff', '♻️ Restart freebuff'), 'fb:restart', 'success'), btn(this.tr('⏹ توقف CLI', '⏹ Stop CLI'), 'fb:stop', 'danger')],
      [btn(this.tr('🔐 وضعیت instance', '🔐 Instance status'), 'menu:instances', 'primary'), btn(this.tr('🔓 آزادسازی قفل', '🔓 Release lock'), 'svc:unlock', 'danger')],
      [btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
    ];
  }

  statusKeyboard() {
    return [
      [btn(this.tr('🔄 تمدید جلسه', '🔄 Renew session'), 'menu:renew', 'success'), btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
    ];
  }

  async statusText(userId) {
    this.applyActiveAccount();
    const os = await import('node:os');
    const load = os.loadavg().map((n) => n.toFixed(2)).join(' / ');
    const sess = await this.chat.activeSession().catch(() => null);
    const left = this.chat.remainingMs();
    const lang = this.lang();
    const en = lang === 'en';
    const mem = en
      ? `RAM: ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB bot / ${(os.totalmem() - os.freemem()) / 1e9 | 0}GB/${os.totalmem() / 1e9 | 0}GB server`
      : `RAM: ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB پروسه / ${(os.totalmem() - os.freemem()) / 1e9 | 0}GB/${os.totalmem() / 1e9 | 0}GB سرور`;
    const up = en ? `Bot uptime: ${(process.uptime() / 3600).toFixed(1)}h` : `Uptime ربات: ${(process.uptime() / 3600).toFixed(1)}h`;
    const fbSession = this.instances.isInteractiveActive()
      ? (en ? 'Interactive CLI active ⚠️' : 'CLI تعاملی فعال است ⚠️')
      : (en ? 'Interactive CLI inactive' : 'CLI تعاملی غیرفعال');
    const lines = [
      this.tr('📊 *وضعیت*', '📊 *Status*'),
      `🖥 Load: ${load} | ${mem}`,
      `⏱ ${up}`,
      this.tr(`🤖 مدل: \`${this.settings.getModel()}\``, `🤖 Model: \`${this.settings.getModel()}\``),
      sess
        ? this.tr(`🔓 جلسه سرور: \`${sess.model}\` — ⏳ ${humanMs(left)} دیگر`, `🔓 Server session: \`${sess.model}\` — ⏳ ${humanMs(left, 'en')} left`)
        : this.tr('🔓 جلسه سرور: — (پیام بعدی جلسه تازه می‌سازد)', '🔓 Server session: — (next message starts a fresh one)'),
      this.tr(`🎛 نوع پاسخ: ${this.modeLabel(this.settings.getMode())}`, `🎛 Response mode: ${this.modeLabel(this.settings.getMode())}`),
      this.tr(`📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`, `📢 Ads: ${this.settings.getAds() ? 'on' : 'off'}`),
      `🔐 ${fbSession}`,
      this.tr(`💬 جلسه فعال: ${this.state.user(userId).activeSession ?? '—'}`, `💬 Active chat: ${this.state.user(userId).activeSession ?? '—'}`),
    ];
    const quota = sess ?? this.chat.lastQuota;
    if (!sess && quota) lines.push(this.tr('♻️ سهمیهٔ زیر آخرین مقدار ثبت‌شده است', '♻️ Quota below is the last recorded value'));
    lines.push(...quotaLines(quota, lang));
    return lines.join('\n');
  }

  /** بستن جلسه فعلی و ساخت جلسه تازه (ریست تایمر ۱ ساعته) */
  async doRenew(chatId, messageId, userId) {
    this.cancelAutoRenew(); // تمدید دستی جای تایمر خودکار را می‌گیرد
    this.applyActiveAccount();
    const sess = await this.chat.activeSession().catch(() => null);
    const model = sess?.model || this.settings.getModel();
    try {
      await this.chat.renewSession(model);
      return this.render(chatId, messageId, this.tr(`✅ جلسه \`${model}\` تمدید شد — ⏳ ${humanMs(this.chat.remainingMs())} دیگر`, `✅ Session \`${model}\` renewed — ⏳ ${humanMs(this.chat.remainingMs(), 'en')} left`), this.statusKeyboard());
    } catch (e) {
      // سهمیهٔ این اکانت تمام شده؟ خودکار روی اکانت بعدی سوییچ و تمدید کن.
      if (this.isQuotaError(e)) {
        const switched = await this.tryFailover(chatId, model, userId);
        if (switched) {
          try {
            await this.chat.renewSession(model);
            return this.render(chatId, messageId, this.tr(`✅ جلسه روی اکانت «${switched}» تمدید شد — ⏳ ${humanMs(this.chat.remainingMs())} دیگر`, `✅ Session renewed on account "${switched}" — ⏳ ${humanMs(this.chat.remainingMs(), 'en')} left`), this.statusKeyboard());
          } catch { /* پایین خطا نشان بده */ }
        }
      }
      const kb = this.isQuotaError(e) ? this.quotaErrorButtons() : this.statusKeyboard();
      return this.render(chatId, messageId, `❌ ${this.chatErrorHint(e)}`, kb);
    }
  }

  /** ارسال پیام به همهٔ کاربران مجاز */
  async messageAll(text, extra = {}) {
    for (const id of this.cfg.allowedUserIds) {
      const chatId = this.state.user(id).chatId;
      if (chatId) await this.send(chatId, text, extra).catch(() => {});
    }
  }

  /** اولین chatId موجود (برای اطلاع‌رسانی در تمدید خودکار) */
  firstChatId() {
    for (const id of this.cfg.allowedUserIds) {
      const chatId = this.state.user(id).chatId;
      if (chatId) return chatId;
    }
    return null;
  }

  /** هشدار یک‌باره پیش از انقضای جلسه (و زمان‌بندی تمدید خودکار) */
  async checkSessionWarn() {
    if (this.warnMin <= 0) { this.sessionWarned = false; return; }
    this.applyActiveAccount();
    const warnMin = this.warnMin;
    const left = this.chat.remainingMs();
    if (left == null) {
      // جلسهی شناخته‌شده نیست؛ هر ۵ دقیقه یک‌بار سرور را بررسی کن
      if (Date.now() - (this.lastProbe || 0) > 5 * 60000) {
        this.lastProbe = Date.now();
        await this.chat.activeSession().catch(() => {});
      }
      this.sessionWarned = false;
      return;
    }
    if (left > warnMin * 60000) { this.sessionWarned = false; return; }
    if (this.sessionWarned) return;
    this.sessionWarned = true;

    if (this.autoRenewOn) {
      await this.messageAll(
        this.tr(
          `⏳ جلسه فری‌باف ${humanMs(left)} دیگر بسته می‌شود.\n🔁 تمدید خودکار روشن است و سر موعد جلسه را تازه می‌کنم. اگر نمی‌خواهی «🛑 لغو تمدید خودکار» را بزن.`,
          `⏳ Freebuff session closes in ${humanMs(left, 'en')}.\n🔁 Auto-renew is on; I'll start a fresh session when it expires. If you don't want it, tap "🛑 Cancel auto-renew".`,
        ),
        { reply_markup: { inline_keyboard: [[
          btn(this.tr('🔁 تمدید الان', '🔁 Renew now'), 'menu:renew', 'success'),
          btn(this.tr('🛑 لغو تمدید خودکار', '🛑 Cancel auto-renew'), 'menu:autorenewoff', 'danger'),
        ]] } },
      );
      this.cancelAutoRenew();
      this.renewTimer = setTimeout(() => this.doAutoRenew().catch((e) => log.warn('autoRenew:', e.message)), left + 3000);
      this.renewTimer.unref?.();
      return;
    }

    await this.messageAll(
      this.tr(
        `⏳ جلسه فری‌باف ${humanMs(left)} دیگر بسته می‌شود.\nبرای تمدید /renew بزن، یا پیام بعدی خودکار جلسه تازه می‌سازد.`,
        `⏳ Freebuff session closes in ${humanMs(left, 'en')}.\nTap Renew or just send your next message to start a fresh session.`,
      ),
      { reply_markup: { inline_keyboard: [[{ text: this.tr('🔄 تمدید جلسه', '🔄 Renew session'), callback_data: 'menu:renew' }]] } },
    );
  }

  /** تمدید خودکار جلسه سر موعد (اگر کاربر لغو نکرده باشد) */
  async doAutoRenew() {
    this.renewTimer = null;
    if (!this.autoRenewOn) return;
    this.applyActiveAccount();
    const sess = await this.chat.activeSession().catch(() => null);
    const model = sess?.model || this.settings.getModel();
    let account = this.activeAccountName();
    try {
      await this.chat.renewSession(model);
    } catch (e) {
      if (!this.isQuotaError(e)) {
        await this.messageAll(this.tr(`❌ تمدید خودکار ناموفق بود: ${this.chatErrorHint(e)}`, `❌ Auto-renew failed: ${this.chatErrorHint(e)}`));
        return;
      }
      const switched = await this.tryFailover(this.firstChatId(), model).catch(() => null);
      if (!switched) {
        await this.messageAll(this.tr('❌ تمدید خودکار ناموفق بود؛ سهمیهٔ همهٔ اکانت‌ها تمام شده.', '❌ Auto-renew failed; all accounts are out of quota.'));
        return;
      }
      account = switched;
    }
    this.sessionWarned = false;
    await this.messageAll(
      this.tr(
        `🔁 جلسه خودکار تمدید شد (اکانت \`${account}\`) — ⏳ ${humanMs(this.chat.remainingMs())} مانده`,
        `🔁 Session auto-renewed (account \`${account}\`) — ⏳ ${humanMs(this.chat.remainingMs(), 'en')} left`,
      ),
      { reply_markup: { inline_keyboard: [[btn(this.tr('⚙️ تنظیمات', '⚙️ Settings'), 'menu:settings', 'primary')]] } },
    );
  }

  // ---------- روتر دکمه‌ها ----------
  async onCallback(q) {
    const chatId = q.message?.chat?.id;
    const userId = q.from?.id;
    const messageId = q.message?.message_id;
    const answer = (text) => this.bot.answerCallbackQuery(q.id, text ? { text: text.slice(0, 200) } : {}).catch(() => {});
    if (!chatId || !userId || !this.allowed(userId)) return answer();
    const u = this.state.user(userId);
    u.chatId = chatId;

    const [action, ...rest] = (q.data || '').split(':');
    const value = rest.join(':');
    const home = () => (this.hasNoAccount()
      ? this.render(chatId, messageId, this.noAccountText(), this.noAccountKeyboard())
      : this.render(chatId, messageId, this.homeText(u), this.homeKeyboard(u)));

    switch (action) {
      case 'menu':
        switch (value) {
          case 'home': return home();
          case 'status':
          case 'timer': return this.render(chatId, messageId, await this.statusText(userId), this.statusKeyboard());
          case 'renew': return this.doRenew(chatId, messageId, userId);
          case 'settings': return this.render(chatId, messageId, this.settingsText(), this.settingsKeyboard());
          case 'autorenew': {
            this.setAutoRenew(!this.autoRenewOn);
            await answer(this.autoRenewOn
              ? this.tr(`تمدید خودکار روشن شد (هشدار ${this.warnMin} دقیقه قبل)`, `Auto-renew on (warning ${this.warnMin} min before)`)
              : this.tr('تمدید خودکار خاموش شد', 'Auto-renew off'));
            return this.render(chatId, messageId, this.settingsText(), this.settingsKeyboard());
          }
          case 'autorenewoff': {
            this.setAutoRenew(false);
            await answer(this.tr('تمدید خودکار لغو شد', 'Auto-renew cancelled'));
            return this.render(chatId, messageId, this.tr('🛑 تمدید خودکار لغو شد. جلسه در موعدش بسته می‌شود.', '🛑 Auto-renew cancelled. The session will close at its expiry.'), [[btn(this.tr('⚙️ تنظیمات', '⚙️ Settings'), 'menu:settings', 'primary')]]);
          }
          case 'account':
            if (this.hasNoAccount()) return this.render(chatId, messageId, this.noAccountText(), this.noAccountKeyboard());
            return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());

          case 'start': {
            const sess = await this.chat.activeSession().catch(() => null);
            if (!sess) {
              await answer('⏳ ساخت جلسه…');
              try { await this.chat.renewSession(this.settings.getModel()); }
              catch (e) { await answer(e.message); }
            } else {
              await answer(this.tr('جلسه فعال است', 'Session is active'));
            }
            return this.render(chatId, messageId, await this.statusText(userId), this.statusKeyboard());
          }
          case 'model':
            await this.chat.activeSession().catch(() => {});
            return this.render(chatId, messageId, this.modelText(), this.modelKeyboard());
          case 'lang':
            this.toggleLang();
            await answer(this.tr('زبان: English', 'Language: فارسی'));
            return this.render(chatId, messageId, this.homeText(u), this.homeKeyboard(u));
          case 'mode': return this.render(chatId, messageId, `🎛 *نوع پاسخ* (فعلی: ${this.modeLabel(this.settings.getMode())})`, this.modeKeyboard());
          case 'ads': return this.render(chatId, messageId, this.tr('📢 *تبلیغات*', '📢 *Ads*'), this.adsKeyboard());
          case 'sessions': return this.render(chatId, messageId, this.sessionsText(userId), this.sessionsKeyboard(userId));
          case 'new': {
            const name = `chat-${Object.keys(u.sessions).length + 1}`;
            this.state.ensureSession(userId, name);
            await answer(`جلسه ${name} ساخته شد`);
            return this.render(chatId, messageId, this.sessionsText(userId), this.sessionsKeyboard(userId));
          }
          case 'clear': {
            if (!u.activeSession) { await answer('جلسه فعالی نیست'); return home(); }
            this.state.clearMessages(userId, u.activeSession);
            await answer(this.tr('تاریخچه پاک شد', 'History cleared'));
            return home();
          }
          case 'instances': return this.render(chatId, messageId, this.instances.statusText(), [[{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]]);
          case 'server': return this.render(chatId, messageId, this.tr('🖥 *مدیریت سرور*', '🖥 *Server*'), this.serverKeyboard());
          case 'help': return this.render(chatId, messageId, this.helpText(), this.helpKeyboard());
          default: return home();
        }

      case 'model': {
        await answer('⏳ در حال سوییچ…');
        try {
          const session = await this.chat.switchSessionModel(value);
          this.settings.setModel(value);
          const left = session.remainingMs ? this.tr(` — ${Math.round(session.remainingMs / 60000)} دقیقه`, ` — ${Math.round(session.remainingMs / 60000)} min`) : '';
          await this.render(chatId, messageId, this.tr(`✅ مدل روی \`${value}\` تنظیم شد${left}`, `✅ Model set to \`${value}\`${left}`), this.modelKeyboard());
        } catch (e) {
          await this.render(chatId, messageId, this.tr(`❌ ${e.message}\n\nمدل فعلی: \`${this.settings.getModel()}\``, `❌ ${e.message}\n\nCurrent model: \`${this.settings.getModel()}\``), this.modelKeyboard());
        }
        return;
      }

      case 'mode': {
        try { this.settings.setMode(value); await answer(`نوع پاسخ روی ${this.modeLabel(value)} تنظیم شد`); }
        catch (e) { await answer(e.message); }
        return this.render(chatId, messageId, `🎛 *نوع پاسخ* (فعلی: ${this.modeLabel(this.settings.getMode())})`, this.modeKeyboard());
      }

      case 'ads': {
        this.settings.setAds(value === 'on');
        await answer(`تبلیغات ${value === 'on' ? 'روشن' : 'خاموش'} شد`);
        return this.render(chatId, messageId, this.tr('📢 *تبلیغات*', '📢 *Ads*'), this.adsKeyboard());
      }

      case 'toolok':
      case 'toolno': {
        const resolve = this.pendingConfirm.get(value);
        if (resolve) { this.pendingConfirm.delete(value); resolve(String(q.data).startsWith('toolok')); }
        // پیام تأیید دستور خطرناک، در هر دو حالت (اجرا یا لغو) حذف شود.
        await this.bot.deleteMessage(chatId, messageId).catch(() => {});
        await answer(String(q.data).startsWith('toolok') ? this.tr('در حال اجرا…', 'Running…') : this.tr('لغو شد', 'Cancelled'));
        return;
      }

      case 'runstop': {
        await this.clearMarkup(chatId, messageId);
        const ac = this.aborters.get(userId);
        if (!ac) { await answer(this.tr('چیزی در حال اجرا نیست', 'Nothing is running')); return; }
        ac.abort();
        await answer(this.tr('⏹ متوقف شد', '⏹ Stopped'));
        // پیام جدیدی که مانده بود، بعد از توقف خودکار اجرا می‌شود
        return;
      }
      case 'runcont': {
        this.pendingBusy.delete(userId);
        await this.clearMarkup(chatId, messageId);
        await answer(this.tr('▶️ ادامه می‌دهد…', '▶️ Continuing…'));
        await this.send(chatId, this.tr(
          '✅ اجرای فعلی ادامه پیدا می‌کند؛ پیام جدید نادیده گرفته شد. بعد از تمام‌شدن پاسخ، دوباره بفرست.',
          '✅ The current run continues; your new message was ignored. Resend it after the answer finishes.',
        )).catch(() => {});
        return;
      }

      case 'chatNew': {
        const pend = this.pendingChat.get(userId);
        this.pendingChat.delete(userId);
        if (value === 'cancel' || !pend) {
          await answer(this.tr('لغو شد', 'Cancelled'));
          return home();
        }
        // دکمه‌های تأیید دیگر لازم نیستند
        if (this.menuMsg.get(chatId) === messageId) this.menuMsg.delete(chatId);
        this.bot.deleteMessage(chatId, messageId).catch(() => {});
        if (this.busy.has(userId)) {
          await answer(this.tr('یک اجرا در جریان است', 'A run is in progress'));
          return;
        }
        this.applyActiveAccount();
        try {
          await this.chat.renewSession(this.settings.getModel());
        } catch (e) {
          // سهمیهٔ این اکانت تمام؟ خودکار برو روی اکانت بعدی
          const switched = this.isQuotaError(e) ? await this.tryFailover(chatId, this.settings.getModel(), userId) : null;
          if (!switched) {
            const kb = this.isQuotaError(e) ? this.quotaErrorButtons() : this.homeKeyboard(u);
            return this.send(chatId, `❌ ${this.chatErrorHint(e)}`, { reply_markup: { inline_keyboard: kb } });
          }
        }
        const session = this.state.getSession(userId, pend.name) || this.state.ensureSession(userId, pend.name);
        await answer(this.tr('جلسه ساخته شد، در حال ارسال…', 'Session started, sending…'));
        return this.runChat(chatId, userId, pend.name, session, pend.text);
      }

      case 'switch': {
        const st = this.pendingSwitch.get(userId);
        if (!st) { await answer(this.tr('درخواست سوییچی نیست', 'No pending switch')); return; }
        clearTimeout(st.timer);
        this.pendingSwitch.delete(userId);
        this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        if (value === 'go') {
          await answer(this.tr('در حال سوییچ…', 'Switching…'));
          st.resolve(true);
        } else {
          await answer(this.tr('لغو شد', 'Cancelled'));
          await this.bot.editMessageText(this.tr('❌ سوییچ اکانت لغو شد.', '❌ Account switch cancelled.'), { chat_id: chatId, message_id: messageId }).catch(() => {});
          st.resolve(false);
        }
        return;
      }

      case 'acc': {
        if (value === 'add') {
          return this.render(chatId, messageId, this.tr('➕ *افزودن اکانت*\nروش را انتخاب کن (نام خودکار از ایمیل ساخته می‌شود):', '➕ *Add account*\nChoose a method (name auto-derived from email):'), this.accountMethodKeyboard());
        }
        if (value === 'backup') {
          const info = this.backups.create();
          this.state.setMeta('lastBackupFile', info.name);
          await this.sendBackup(chatId, info.file, info.count + (info.hasDefault ? 1 : 0));
          await answer(this.tr('بکاپ گرفته شد', 'Backup created'));
          if (this.hasNoAccount()) return home();
          return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());
        }
        if (value === 'restore') {
          this.pendingRestore.add(userId);
          return this.render(chatId, messageId, this.tr(
            '♻️ *ریستور اکانت‌ها*\nفایل بکاپ (JSON) را همین‌جا در چت بفرست تا ریستور کنم.\n⚠️ اکانت‌های هم‌نام جایگزین می‌شوند.',
            '♻️ *Restore accounts*\nSend the JSON backup file right here in the chat and I will restore it.\n⚠️ Same-named accounts will be overwritten.',
          ), [
            [btn(this.tr('❌ انصراف', '❌ Cancel'), 'acc:restorecancel', 'danger')],
            [btn(this.tr('↩️ اکانت‌ها', '↩️ Accounts'), 'menu:account')],
          ]);
        }
        if (value === 'restorecancel') {
          this.pendingRestore.delete(userId);
          await answer(this.tr('لغو شد', 'Cancelled'));
          return home();
        }
        if (value === 'proxy') {
          const a = this.effectiveAccount(this.activeAccount());
          if (!a) { await answer(this.tr('اکانتی نیست', 'No account')); return home(); }
          this.pendingProxy.add(userId);
          return this.render(chatId, messageId, this.tr(
            `🌐 *پروکسی اکانت «${a.name}»* (ضد بن با تشخیص IP فری‌باف)\nپروکسی فعلی: ${a.proxy ? `\`${a.proxy}\`` : '—'}\n\nفقط پروکسی *HTTP/HTTPS* کار می‌کند؛ آدرسش را بفرست، مثلاً:\n\`http://1.2.3.4:8080\`\n\`http://user:pass@1.2.3.4:8080\`\n\n❌ لینک‌های \`t.me/proxy?...\` (MTProto) فقط برای خود تلگرام‌اند و کار نمی‌کنند.\n❌ SOCKS به‌تنهایی کار نمی‌کند؛ اگر کلاینتت SOCKS دارد، یک inbound HTTP هم روشن کن (مثلاً xray/v2ray روی \`127.0.0.1:8080\`) و همان را بده.\n\nبرای حذف پروکسی بنویس \`off\`. بعد از تنظیم، «🧪 تست پروکسی» را بزن.`,
            `🌐 *Proxy for account "${a.name}"* (anti-ban by Freebuff IP detection)\nCurrent: ${a.proxy ? `\`${a.proxy}\`` : '—'}\n\nOnly *HTTP/HTTPS* proxies work; send its URL, e.g.:\n\`http://1.2.3.4:8080\`\n\`http://user:pass@1.2.3.4:8080\`\n\n❌ \`t.me/proxy?...\` links (MTProto) are Telegram-only and won't work.\n❌ Plain SOCKS won't work; if your client only has SOCKS, enable an HTTP inbound too (e.g. xray/v2ray on \`127.0.0.1:8080\`) and use that.\n\nSend \`off\` to remove the proxy. Afterwards tap "🧪 Test proxy".`,
          ), [
            [btn(this.tr('❌ انصراف', '❌ Cancel'), 'menu:account')],
          ]);
        }
        if (!this.accounts.has(value)) {
          await answer(this.tr('اکانت پیدا نشد', 'Account not found'));
          return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());
        }
        this.state.setMeta('activeAccount', value);
        this.applyActiveAccount();
        await answer(this.tr(`اکانت فعال: ${value}`, `Active account: ${value}`));
        return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());
      }

      case 'accstart': {
        this.applyActiveAccount();
        const sess = await this.chat.activeSession().catch(() => null);
        if (sess) {
          await answer(this.tr('جلسه فعال است', 'Session is active'));
        } else {
          await answer(this.tr('ساخت جلسه…', 'Starting session…'));
          try {
            await this.chat.renewSession(this.settings.getModel());
          } catch (e) {
            await answer(this.chatErrorHint(e).slice(0, 200));
          }
        }
        return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());
      }

      case 'acctest': {
        const a = this.effectiveAccount(this.activeAccount());
        if (!a) { await answer(this.tr('اکانتی نیست', 'No account')); return home(); }
        await this.bot.editMessageText(this.tr('🧪 در حال تست پروکسی…', '🧪 Testing proxy…'), { chat_id: chatId, message_id: messageId }).catch(() => {});
        const direct = await this.chat.exitIp(null).catch((e) => this.tr(`خطا: ${e.message}`, `error: ${e.message}`));
        let proxied = null;
        if (a.proxy) proxied = await this.chat.exitIp(a.proxy).catch((e) => this.tr(`خطا: ${e.message}`, `error: ${e.message}`));
        const ok = a.proxy && proxied && !/^(خطا|error)/.test(String(proxied)) && proxied !== direct;
        const lines = [
          this.tr('🧪 *تست پروکسی*', '🧪 *Proxy test*'),
          this.tr(`اکانت: \`${a.name}\``, `Account: \`${a.name}\``),
          this.tr(`IP مستقیم (بدون پروکسی): \`${direct}\``, `Direct IP (no proxy): \`${direct}\``),
        ];
        if (!a.proxy) {
          lines.push(this.tr('🌐 پروکسی تنظیم نشده.', '🌐 No proxy configured.'));
        } else {
          lines.push(this.tr(`🌐 IP از طریق پروکسی: \`${proxied}\``, `🌐 IP via proxy: \`${proxied}\``));
          lines.push(ok
            ? this.tr('✅ پروکسی کار می‌کند و IP عوض شده.', '✅ The proxy works and the IP changed.')
            : this.tr('⚠️ پروکسی کار نکرد یا IP عوض نشد.', '⚠️ The proxy failed or the IP did not change.'));
        }
        return this.render(chatId, messageId, lines.join('\n'), this.accountKeyboard());
      }

      case 'accdel': {
        const a = this.activeAccount();
        if (!a) { await answer(this.tr('اکانتی نیست', 'No account')); return home(); }
        if (a.name === 'default') {
          await answer(this.tr('اکانت default قابل حذف نیست', 'The default account cannot be deleted'));
          return;
        }
        return this.render(chatId, messageId, this.tr(
          `🗑 اکانت «${a.name}» حذف شود؟`,
          `🗑 Delete account "${a.name}"?`,
        ), [
          [btn(this.tr('🗑 بله، حذف کن', '🗑 Yes, delete'), 'accdelc', 'danger')],
          [btn(this.tr('↩️ انصراف', '↩️ Cancel'), 'menu:account')],
        ]);
      }

      case 'accdelc': {
        const a = this.activeAccount();
        if (!a || a.name === 'default') { await answer(this.tr('قابل حذف نیست', 'Cannot delete')); return home(); }
        try { this.accounts.remove(a.name); } catch (e) { await answer(e.message); }
        const remaining = this.accounts.list();
        const next = remaining.find((x) => x.name === 'default')?.name || remaining[0]?.name || 'default';
        this.state.setMeta('activeAccount', next);
        this.applyActiveAccount();
        await answer(this.tr(`اکانت «${a.name}» حذف شد`, `Account "${a.name}" deleted`));
        if (this.hasNoAccount()) return home();
        return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());
      }

      case 'accnamed':
        this.pendingName.set(userId, true);
        return this.render(chatId, messageId, '✏️ نام اکانت را بفرست (حروف/عدد/`.-_`)…', [[{ text: '↩️ اکانت‌ها', callback_data: 'menu:account' }]]);

      case 'accweb':
        return this.startWebLogin(chatId, userId, value);

      case 'accwebcheck': {
        const st = this.pendingLogin.get(userId);
        if (!st) { await answer(this.tr('ورود فعالی نیست', 'No active login')); return home(); }
        const r = await this.chat.pollCliLogin(st).catch(() => null);
        if (r?.ok) return this.checkWebLogin(chatId, userId, st.expiresAt || Date.now() + 60000);
        await answer(this.tr('هنوز تأیید نشده؛ بعد از لاگین دوباره بزن.', 'Not confirmed yet; tap again after login.'));
        return;
      }

      case 'accwebnew': {
        const st = this.pendingLogin.get(userId);
        if (st?.timer) clearInterval(st.timer);
        this.pendingLogin.delete(userId);
        await answer(this.tr('ساخت لینک جدید…', 'Creating a new link…'));
        return this.startWebLogin(chatId, userId, value || '');
      }

      case 'accwebcancel': {
        const st = this.pendingLogin.get(userId);
        if (st?.timer) clearInterval(st.timer);
        this.pendingLogin.delete(userId);
        await answer('لغو شد');
        return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());
      }

      case 'help': {
        const kb = [[btn('↩️ راهنما', 'menu:help'), btn('🏠 منوی اصلی', 'menu:home')]];
        return this.render(chatId, messageId, this.helpSectionText(value), kb);
      }

      case 'warn': {
        this.warnMin = parseInt(value, 10) || 0;
        this.state.setMeta('sessionWarnMin', this.warnMin);
        if (this.warnMin <= 0 && this.autoRenewOn) this.setAutoRenew(false);
        this.sessionWarned = false;
        await answer(this.warnMin > 0 ? `هشدار روی ${this.warnMin} دقیقه تنظیم شد` : 'هشدار خاموش شد');
        return this.render(chatId, messageId, this.settingsText(), this.settingsKeyboard());
      }

      case 'ses': {
        const name = decodeURIComponent(value);
        if (!this.state.getSession(userId, name)) { await answer(this.tr('جلسه پیدا نشد', 'Chat not found')); return home(); }
        u.activeSession = name;
        this.state.save();
        await answer(`سوییچ به ${name}`);
        return this.render(chatId, messageId, this.sessionsText(userId), this.sessionsKeyboard(userId));
      }

      case 'delq': {
        const name = decodeURIComponent(value);
        const kb = [
          [btn('🗑 بله، حذف کن', `delc:${encodeURIComponent(name)}`, 'danger'), btn('↩️ انصراف', 'menu:sessions')],
        ];
        return this.render(chatId, messageId, `مطمئنی جلسه \`${name}\` حذف شود؟`, kb);
      }

      case 'delc': {
        const name = decodeURIComponent(value);
        this.state.deleteSession(userId, name);
        await answer(this.tr('حذف شد', 'Deleted'));
        return this.render(chatId, messageId, this.sessionsText(userId), this.sessionsKeyboard(userId));
      }

      case 'svc':
        switch (value) {
          case 'ps': {
            try {
              const { stdout } = await execp('ps aux --sort=-%mem | head -12');
              return this.render(chatId, messageId, '```\n' + stdout.slice(0, 3000) + '\n```', this.serverKeyboard());
            } catch (e) { return this.render(chatId, messageId, `❌ ${e.message}`, this.serverKeyboard()); }
          }
          case 'sh': {
            this.pendingSh.add(userId);
            return this.render(chatId, messageId, this.tr('⌨️ دستور شل را بفرست تا اجرا کنم (مثل `/sh`).\n⚠️ با احتیاط؛ دستور روی همین سرور اجرا می‌شود.', '⌨️ Send the shell command to run (like `/sh`).\n⚠️ Careful: it runs on this server.'), this.serverKeyboard());
          }
          case 'unlock': {
            try {
              const cur = JSON.parse(fs.readFileSync(this.instances.botLockFile, 'utf8'));
              if (cur.pid !== process.pid) fs.unlinkSync(this.instances.botLockFile);
            } catch { /* قفلی نیست */ }
            return this.render(chatId, messageId, '🔓 قفل ربات آزاد شد (در صورت وجود)', this.serverKeyboard());
          }
          default:
            return this.render(chatId, messageId, this.tr('🖥 *مدیریت سرور*', '🖥 *Server*'), this.serverKeyboard());
        }

      case 'fb': {
        const sub = value.split(':')[0];
        if (sub === 'stop') {
          const cli = this.instances.activeCli();
          if (!cli) { await answer('CLI فعالی نیست'); return this.render(chatId, messageId, 'CLI تعاملی فعالی نیست.', this.serverKeyboard()); }
          try { process.kill(cli.pid, 'SIGTERM'); } catch (e) { await answer(e.message); }
          return this.render(chatId, messageId, `✅ SIGTERM به pid ${cli.pid} ارسال شد.`, this.serverKeyboard());
        }
        try {
          await execp(`tmux kill-session -t freebuff 2>/dev/null; tmux new-session -d -s freebuff 'freebuff'`);
          return this.render(chatId, messageId, '✅ freebuff در tmux session «freebuff» اجرا شد', this.serverKeyboard());
        } catch (e) { return this.render(chatId, messageId, `❌ ${e.message.slice(0, 300)}`, this.serverKeyboard()); }
      }

      default:
        return answer();
    }
  }

  /** دریافت نام دلخواه اکانت */
  async handleNameInput(chatId, userId, text) {
    this.pendingName.delete(userId);
    const name = text.trim();
    if (!/^[\w.-]{1,40}$/.test(name) || name === 'default') {
      return this.send(chatId, '❌ نام نامعتبر. فقط حروف/عدد/`.-_` (و نه default). دوباره «➕ افزودن اکانت» را بزن.');
    }
    return this.send(chatId, this.tr(`افزودن اکانت «${name}» — روش را انتخاب کن:`, `Add account "${name}" — choose a method:`), { reply_markup: { inline_keyboard: this.accountMethodKeyboard(name) } });
  }

  /** دریافت آدرس پروکسی برای اکانت فعال */
  async handleProxyInput(chatId, userId, text) {
    this.pendingProxy.delete(userId);
    try {
      const cur = this.setActiveProxy(text);
      return this.send(chatId, this.tr(
        cur ? `✅ پروکسی تنظیم شد: \`${cur}\`` : '✅ پروکسی حذف شد.',
        cur ? `✅ Proxy set: \`${cur}\`` : '✅ Proxy removed.',
      ), { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    } catch (e) {
      return this.send(chatId, `❌ ${e.message}`, { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    }
  }

  // ---------- چت ----------
  /** ترجمهٔ خطاهای بک‌اند به پیام قابل‌فهم */
  chatErrorHint(e) {
    const status = e.status;
    const code = e.code;
    const body = String(e.body || e.message || '').toLowerCase();
    if (e?.name === 'TimeoutError' || /timeout|بی‌پاسخ ماند/.test(e?.message || '')) {
      return this.tr(
        '⏱ سرور فری‌باف دیر پاسخ داد و درخواست لغو شد.\nعلت احتمالی: کندی سرور، پروکسی، یا درخواست سنگین. دوباره بفرست؛ اگر تکرار شد پروکسی/شبکه را بررسی کن.',
        '⏱ The Freebuff server responded too late and the request was cancelled.\nLikely cause: slow server, proxy, or a heavy request. Resend; if it repeats, check the proxy/network.',
      );
    }
    if (code === 'rate_limited' || code === 'spend_limited' || code === 'ip_capped') {
      const ms = e.data?.retryAfterMs;
      const when = ms ? humanMs(ms, this.lang()) : '';
      return this.tr(
        [
          `🚫 سهمیهٔ باک امروز تمام شده${when ? `؛ ریست تا ${when} دیگر` : ''}.`,
          '',
          '⚠️ افزودن اکانت جدید ریسک دارد و می‌تواند نقض قوانین فری‌باف باشد (احتمال بن‌شدن اکانت).',
          '🛒 یا پلن پولی بگیر: https://freebuff.com/plans',
          '• Starter — ۸ دلار/ماه (ماه اول ۵ دلار) · ۱۵۰ باک روزانه · ۳ جلسه/روز · ۳۰/ماه',
          '• Plus — ۲۵ دلار/ماه (ماه اول ۱۹) · ۷ جلسه/روز · ۱۰۰/ماه',
          '• Pro — ۶۰ دلار/ماه (ماه اول ۴۵) · ۱۱ جلسه/روز · ۲۱۰/ماه',
        ].join('\n'),
        [
          `🚫 Your daily Bucks are used up${when ? `; resets in ${when}` : ''}.`,
          '',
          '⚠️ Adding another account is risky and may violate Freebuff rules (account ban possible).',
          '🛒 Or get a paid plan: https://freebuff.com/plans',
          '• Starter — $8/mo (first $5) · 150 Bucks/day · 3 sessions/day · 30/mo',
          '• Plus — $25/mo (first $19) · 7 sessions/day · 100/mo',
          '• Pro — $60/mo (first $45) · 11 sessions/day · 210/mo',
        ].join('\n'),
      );
    }
    if (body.includes('waiting_room_required') || status === 428) {
      return this.tr('جلسه فری‌باف تمام شده بود. دوباره پیام بفرست یا «➕ ایجاد جلسه جدید» را بزن.', 'Your free session had ended. Send again or tap "➕ Start session".');
    }
    if (body.includes('free_mode_invalid_agent_model')) {
      return this.tr('این ترکیب مدل و agent مجاز نیست؛ از منوی «مدل» یک مدل دیگر انتخاب کن.', 'This model/agent combination is not allowed; pick another model from the Model menu.');
    }
    if (body.includes('free_mode_cli_required')) {
      return this.tr('مود رایگان فعلاً فقط از طریق CLI فعال است.', 'Free mode is currently CLI-only.');
    }
    if (body.includes('session_superseded') || status === 409) {
      return this.tr('تداخل جلسه (۴۰۹): یک نمونهٔ دیگر جلسه را گرفت. کمی بعد دوباره فرست کن.', 'Session conflict (409): another instance took the session. Try again shortly.');
    }
    if (body.includes('spend_limited') || body.includes('rate_limited') || body.includes('ip_capped') || status === 429) {
      return this.tr('سهمیه/محدودیت امروز تمام شده. تا ریست بعدی صبر کن یا پلن را ارتقا بده.', 'Daily quota/rate limit reached. Wait for the reset or upgrade your plan.');
    }
    if (body.includes('model_unavailable')) {
      return this.tr('این مدل موقتاً در دسترس نیست؛ مدل دیگری انتخاب کن.', 'This model is temporarily unavailable; pick another.');
    }
    return e.message;
  }

  async onChat(msg, chatId, userId, text) {
    // تا شروع گفتگو منوی دکمه‌دار قبلی پاک شود (فقط متن چت می‌ماند)
    await this.clearMenu(chatId);
    if (this.pendingSh.has(userId)) {
      this.pendingSh.delete(userId);
      return this.runShell(chatId, text);
    }
    if (this.pendingName.has(userId)) return this.handleNameInput(chatId, userId, text);
    if (this.pendingProxy.has(userId)) return this.handleProxyInput(chatId, userId, text);
    if (this.busy.has(userId)) {
      this.pendingBusy.set(userId, { chatId, text });
      return this.send(chatId, this.tr(
        '⏳ یک پاسخ هنوز در حال اجراست.\nمی‌خواهی متوقفش کنم یا ادامه بدهم؟',
        '⏳ A previous answer is still running.\nShould I stop it or continue?',
      ), {
        reply_markup: { inline_keyboard: [[
          btn(this.tr('⏹ متوقف کن', '⏹ Stop'), 'runstop', 'danger'),
          btn(this.tr('▶️ ادامه بده', '▶️ Continue'), 'runcont', 'success'),
        ]] },
      });
    }
    // رزرو فوری قفل تا پیام‌های هم‌زمان نتوانند دو اجرا راه بیندازند
    this.busy.add(userId);
    const releaseBusy = () => this.busy.delete(userId);
    this.applyActiveAccount();
    if (this.hasNoAccount()) {
      releaseBusy();
      return this.send(chatId, this.noAccountText(), { reply_markup: { inline_keyboard: this.noAccountKeyboard() } });
    }
    if (!this.activeAccount()?.authToken) {
      releaseBusy();
      return this.send(chatId, this.tr('❌ credentials فری‌باف پیدا نشد. اول در سرور freebuff login کن.', '❌ Freebuff credentials not found. Run freebuff login first.'));
    }

    const u = this.state.user(userId);
    const name = u.activeSession || (this.state.ensureSession(userId, 'chat-1'), 'chat-1');
    const session = this.state.getSession(userId, name);

    // برای جلوگیری از اسراف: اگر جلسه‌ی باز نیست، قبل از ساخت جلسه اجازه بگیر.
    const active = await this.chat.activeSession().catch(() => null);
    if (!active) {
      releaseBusy();
      this.pendingChat.set(userId, { chatId, text, name });
      return this.send(chatId, this.tr(
        '🚫 فعلاً هیچ جلسه فری‌بافی باز نیست.\nاگر بفرستی، یک جلسه تازه ساخته می‌شود و از باک امروزت کم می‌کند.',
        '🚫 No freebuff session is currently open.\nIf you continue, a new session will start and use your daily Bucks.',
      ), {
        reply_markup: {
          inline_keyboard: [
            [btn(this.tr('➕ ایجاد جلسه جدید و ارسال', '➕ Start session & send'), 'chatNew:go', 'success')],
            [btn(this.tr('❌ انصراف', '❌ Cancel'), 'chatNew:cancel', 'danger')],
          ],
        },
      });
    }

    return this.runChat(chatId, userId, name, session, text);
  }

  /** اجرای یک دستور شل روی سرور و برگرداندن خروجی */
  async runShell(chatId, command) {
    const cmd = String(command || '').trim();
    if (!cmd) return;
    try {
      const { stdout, stderr } = await execp(cmd, { timeout: (this.cfg.cmdTimeoutSec || 60) * 1000, maxBuffer: 1e6 });
      const out = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() || this.tr('(بدون خروجی)', '(no output)');
      return this.send(chatId, '```\n' + out.slice(0, 3500) + '\n```', { parse_mode: 'Markdown' });
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message;
      return this.send(chatId, '```\n' + out.slice(0, 3500) + '\n```', { parse_mode: 'Markdown' });
    }
  }

  // ---------- ابزار اجرای دستور روی سرور (tool-calling) ----------
  /** تعریف ابزارهای در دسترس مدل (شبیه CLI فری‌باف) */
  serverTools() {
    const fn = (name, description, properties, required) => ({
      type: 'function',
      function: { name, description, parameters: { type: 'object', properties, required } },
    });
    return [
      fn('run_terminal_command', 'Run a shell command on THIS server (the machine hosting the bot) and return stdout+stderr. Use it to inspect files, processes, services, logs, disk, etc.', {
        command: { type: 'string', description: 'Shell command, e.g. "ls -la /root" or "df -h".' },
        cwd: { type: 'string', description: 'Working directory (optional).' },
        timeoutSec: { type: 'integer', description: 'Timeout in seconds (default 60).' },
      }, ['command']),
      fn('read_file', 'Read a text file from the server.', {
        path: { type: 'string', description: 'Absolute or relative file path.' },
      }, ['path']),
      fn('list_directory', 'List entries of a directory on the server.', {
        path: { type: 'string', description: 'Directory path (default current workdir).' },
      }, []),
      fn('write_file', 'Create or overwrite a text file with the given content.', {
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'Full file content.' },
      }, ['path', 'content']),
    ];
  }

  /** تأیید دستور خطرناک با دکمه */
  confirmTool(chatId, userId, command, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      this.pendingConfirm.set(id, resolve);
      if (signal?.addEventListener) {
        signal.addEventListener('abort', () => { if (this.pendingConfirm.delete(id)) resolve(false); }, { once: true });
      }
      const kb = { keep: true, reply_markup: { inline_keyboard: [[
        btn(this.tr('✅ اجرا کن', '✅ Run'), `toolok:${id}`, 'success'),
        btn(this.tr('❌ لغو', '❌ Cancel'), `toolno:${id}`, 'danger'),
      ]] } };
      this.send(chatId, this.tr(
        `⚠️ *دستور خطرناک*\n\`${command.slice(0, 300)}\`\n\nاجرا شود؟`,
        `⚠️ *Dangerous command*\n\`${command.slice(0, 300)}\`\n\nRun it?`,
      ), kb).catch(() => {});
      const t = setTimeout(() => { if (this.pendingConfirm.delete(id)) resolve(false); }, 120000);
      t.unref?.();
    });
  }

  /** اجرای ابزار درخواستی مدل و برگرداندن نتیجه به‌صورت متن */
  async executeTool(chatId, userId, call, signal) {
    if (signal?.aborted) throw abortError();
    const name = call?.function?.name;
    let args = {};
    try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { /* args نامعتبر */ }
    const wd = this.cfg.workdir || process.cwd();
    const abs = (p) => path.resolve(wd, String(p || '.'));

    switch (name) {
      case 'run_terminal_command': {
        const cmd = String(args.command || '').trim();
        if (!cmd) return 'error: empty command';
        if (isDangerousCommand(cmd)) {
          const ok = await this.confirmTool(chatId, userId, cmd, signal);
          if (!ok) return 'The user declined to run this command. Ask before retrying.';
        }
        const timeout = (Number(args.timeoutSec) || this.cfg.cmdTimeoutSec || 60) * 1000;
        try {
          const { stdout, stderr } = await execp(cmd, { timeout, maxBuffer: 2e6, cwd: abs(args.cwd), ...(signal ? { signal } : {}) });
          return (`${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ''}`.trim() || '(no output)').slice(0, 6000);
        } catch (e) {
          const out = `${e.stdout || ''}${e.stderr ? `\nSTDERR:\n${e.stderr}` : ''}`.trim();
          return `Command failed (exit ${e.code ?? '?'}): ${out || e.message}`.slice(0, 6000);
        }
      }
      case 'read_file': {
        if (!args.path) return 'error: path required';
        try {
          const content = fs.readFileSync(abs(args.path), 'utf8');
          const max = 20000;
          return content.length > max ? `${content.slice(0, max)}\n...(truncated, total ${content.length} chars)` : content;
        } catch (e) { return `error: ${e.message}`; }
      }
      case 'list_directory': {
        try {
          const entries = fs.readdirSync(abs(args.path || '.'), { withFileTypes: true });
          if (!entries.length) return '(empty)';
          return entries.slice(0, 500).map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n');
        } catch (e) { return `error: ${e.message}`; }
      }
      case 'write_file': {
        if (!args.path) return 'error: path required';
        try {
          const file = abs(args.path);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const content = String(args.content ?? '');
          fs.writeFileSync(file, content);
          return `wrote ${file} (${content.length} chars)`;
        } catch (e) { return `error: ${e.message}`; }
      }
      default:
        return `error: unknown tool ${name}`;
    }
  }

  /** حلقهٔ ابزار: مدل فکر و دستور می‌خواهد، ما اجرا می‌کنیم و نتیجه را برمی‌گردانیم */
  async agentLoop(chatId, userId, messages, onStep, signal) {
    const model = this.settings.getModel();
    const tools = this.serverTools();
    const MAX_STEPS = Math.max(1, parseInt(process.env.FREEBUFF_MAX_STEPS || '40', 10) || 40);
    let thoughts = '';
    const toolLog = [];
    let emptyRetried = false;
    const callCounts = new Map(); // امضای فراخوانی ابزار → تعداد تکرار
    const MAX_REPEAT = Math.max(1, parseInt(process.env.FREEBUFF_MAX_TOOL_REPEAT || '2', 10) || 2);
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw abortError();
      const { message } = await this.chat.rawComplete({ model, messages, tools, signal });
      const reasoning = String(message?.reasoning_content || message?.reasoning || '').trim();
      if (reasoning) thoughts += (thoughts ? '\n\n' : '') + reasoning;
      // تفکرات تازه را همان لحظه نشان بده (حتی وقتی ابزاری صدا نمی‌شود)
      if (reasoning && onStep) await onStep({ thoughts, toolLog }).catch(() => {});
      const calls = message?.tool_calls;
      if (Array.isArray(calls) && calls.length) {
        messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls });
        let repeated = false;
        for (const call of calls) {
          if (signal?.aborted) throw abortError();
          let desc = call?.function?.name || 'tool';
          try {
            const a = JSON.parse(call?.function?.arguments || '{}');
            desc = call.function.name === 'run_terminal_command' ? `$ ${a.command}` : `${call.function.name} ${a.path || ''}`.trim();
          } catch { /* ignore */ }
          const sig = `${call?.function?.name || ''}:${call?.function?.arguments || ''}`;
          const n = (callCounts.get(sig) || 0) + 1;
          callCounts.set(sig, n);
          if (n > MAX_REPEAT) {
            // مدل در حلقهٔ تکراری افتاده؛ ابزار را اجرا نکن و برو سراغ پاسخ نهایی
            toolLog.push(this.tr(`↩️ تکرار «${desc}» اجرا نشد`, `↩️ repeated "${desc}" skipped`));
            messages.push({ role: 'tool', tool_call_id: call.id, name: call?.function?.name, content: 'error: identical tool call repeated; do not call it again. Use the information you already have and write the final answer.' });
            repeated = true;
            continue;
          }
          toolLog.push(desc);
          if (onStep) await onStep({ thoughts, toolLog }).catch(() => {});
          const result = await this.executeTool(chatId, userId, call, signal);
          messages.push({ role: 'tool', tool_call_id: call.id, name: call?.function?.name, content: String(result) });
        }
        if (onStep) await onStep({ thoughts, toolLog }).catch(() => {});
        if (repeated) break; // حلقهٔ تکراری → پاسخ نهایی
        continue;
      }
      let content = (message?.content || '').toString().trim();
      if (!content && !emptyRetried) {
        // مدل بدون ابزار و بدون متن تمام کرد (اغلب توکن‌ها صرف reasoning شده)؛
        // یک بار دیگر فقط برای گرفتن پاسخ نهایی امتحان کن.
        emptyRetried = true;
        messages.push({ role: 'assistant', content: '' });
        messages.push({ role: 'user', content: this.tr('حالا فقط پاسخ نهایی را بنویس؛ ابزار دیگری لازم نیست.', 'Now output only the final answer; no more tools.') });
        continue;
      }
      // اگر متن نهایی خالی بود ولی reasoning داشتیم، از reasoning استفاده کن تا کاربر پیام خالی نگیرد.
      if (!content && reasoning) content = reasoning;
      return { answer: content, thoughts, toolLog };
    }
    // به سقف گام‌ها رسیدیم: یک بار دیگر بدون ابزار پاسخ نهایی را بگیر تا کاربر
    // به‌جای پیام «سقف گام» جواب واقعی بگیرد.
    try {
      const { message } = await this.chat.rawComplete({
        model,
        signal,
        messages: [
          ...messages,
          { role: 'user', content: this.tr('به سقف تعداد گام‌های ابزار رسیدی. همین حالا فقط با اطلاعاتی که تا الان جمع کرده‌ای، پاسخ نهایی و کامل را بنویس؛ دیگر از هیچ ابزاری استفاده نکن.', 'You reached the tool-step limit. Now write the final, complete answer using only the information gathered so far; do not use any more tools.') },
        ],
      });
      const content = String(message?.content || '').trim()
        || String(message?.reasoning_content || message?.reasoning || '').trim();
      if (content) return { answer: content, thoughts, toolLog };
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      log.warn('گرفتن پاسخ نهایی بعد از سقف گام ناموفق بود:', e.message);
    }
    return { answer: this.tr('(به سقف تعداد گام‌های ابزار رسیدم)', '(reached the tool step limit)'), thoughts, toolLog };
  }

  /** اجرای واقعی چت روی جلسه موجود */
  /** متن وضعیت: مدل + زمان مانده + سهمیه (برای پیام بالایی) */
  statusBlock() {
    const model = this.settings.getModel();
    const left = this.chat.remainingMs();
    const daily = this.chat.lastQuota?.freebucks?.daily;
    const lines = [this.tr(`🤖 مدل: \`${model}\``, `🤖 Model: \`${model}\``)];
    if (left != null) lines.push(this.tr(`⏳ جلسه: ${humanMs(left)} مانده`, `⏳ Session: ${humanMs(left, 'en')} left`));
    if (daily) {
      const l = Math.max(0, daily.remaining ?? 0);
      const used = daily.spent ?? Math.max(0, (daily.limit ?? 0) - l);
      lines.push(this.tr(`💵 سهمیه: مانده ${l} از ${daily.limit} · استفاده‌شده ${used}`, `💵 Quota: ${l} left of ${daily.limit} · used ${used}`));
    }
    return lines.join('\n');
  }

  /** آیا خطا مربوط به تمام‌شدن سهمیه است؟ */
  isQuotaError(e) {
    return ['rate_limited', 'spend_limited', 'ip_capped'].includes(e?.code);
  }

  /** دکمه‌های زیر پیام اتمام سهمیه: افزودن اکانت + خرید اشتراک */
  quotaErrorButtons() {
    return [
      [
        btn(this.tr('➕ افزودن اکانت', '➕ Add account'), 'acc:add', 'success'),
        btn(this.tr('🔄 تغییر اکانت', '🔄 Switch account'), 'menu:account', 'primary'),
      ],
      [{ text: this.tr('🛒 خرید اشتراک پولی', '🛒 Buy a paid plan'), url: 'https://freebuff.com/plans', style: 'primary' }],
    ];
  }

  /** ترتیب اکانت‌های بعدی برای failover (round-robin از اکانت فعلی) */
  failoverOrder(cur) {
    const list = this.accounts.list().map((a) => a.name);
    const idx = Math.max(0, list.indexOf(cur));
    const out = [];
    for (let k = 1; k < list.length; k++) {
      const name = list[(idx + k) % list.length];
      if (name !== cur && !out.includes(name)) out.push(name);
    }
    return out;
  }

  /**
   * وقتی سهمیه تمام شد: اگر userId بدهی، اول با دکمه از کاربر می‌پرسد و در
   * صورت بی‌جوابی تا ۱ دقیقه خودکار می‌رود؛ بدون userId (تمدید خودکار) مستقیم.
   * نام اکانت جدید را برمی‌گرداند یا null.
   */
  async tryFailover(chatId, model, userId) {
    const cur = this.activeAccountName();
    const order = this.failoverOrder(cur);
    if (!order.length) return null;
    if (!userId || !chatId) return this.performFailover(chatId, model, order, false);
    const go = await this.promptSwitch(chatId, userId, cur, order[0]);
    if (!go) return null;
    return this.performFailover(chatId, model, order, true);
  }

  /** پیام «سهمیه تمام شده» با دکمهٔ رفتن/انصراف و تایم‌اوت ۱ دقیقه‌ای */
  promptSwitch(chatId, userId, from, to) {
    const prev = this.pendingSwitch.get(userId);
    if (prev) {
      clearTimeout(prev.timer);
      this.pendingSwitch.delete(userId);
      prev.resolve(false);
    }
    return new Promise((resolve) => {
      const st = { chatId, to, resolve, timer: null };
      st.timer = setTimeout(() => {
        if (this.pendingSwitch.get(userId) !== st) return;
        this.pendingSwitch.delete(userId);
        this.send(chatId, this.tr(
          `⏱ جوابی نیامد؛ خودکار می‌رویم روی اکانت «${to}».`,
          `⏱ No answer; switching automatically to "${to}".`,
        )).catch(() => {});
        resolve(true);
      }, 60000);
      st.timer.unref?.();
      this.pendingSwitch.set(userId, st);
      this.send(chatId, this.tr(
        `♻️ سهمیهٔ اکانت «${from}» تمام شده؛ می‌رویم روی اکانت «${to}».\nاگر تا ۱ دقیقه دکمه‌ای نزنی، خودکار می‌روم و جلسه قطع نمی‌شود.`,
        `♻️ Account "${from}" quota is used up; switching to "${to}".\nIf you don't tap within 1 minute I'll switch automatically and the session won't be cut.`,
      ), {
        reply_markup: { inline_keyboard: [
          [btn(this.tr(`➡️ برو به اکانت «${to}»`, `➡️ Switch to "${to}"`), 'switch:go', 'success')],
          [btn(this.tr('❌ انصراف', '❌ Cancel'), 'switch:no', 'danger')],
        ] },
      }).catch(() => {});
    });
  }

  /** سوییچ واقعی روی اولین اکانت موجود از ترتیب داده‌شده */
  async performFailover(chatId, model, order, silent = false) {
    const cur = this.activeAccountName();
    for (const name of order) {
      if (name === cur) continue;
      this.state.setMeta('activeAccount', name);
      this.applyActiveAccount();
      try {
        await this.chat.renewSession(model);
        if (chatId && !silent) {
          await this.send(chatId, this.tr(
            `♻️ اکانت فعال شد: «${name}» — جلسه بدون وقفه ادامه پیدا کرد.`,
            `♻️ Active account: "${name}" — the session continued without interruption.`,
          )).catch(() => {});
        }
        return name;
      } catch { /* این اکانت هم ندارد؛ بعدی */ }
    }
    // هیچ اکانتی جا نداشت → برگرد به اکانت قبلی
    this.state.setMeta('activeAccount', cur);
    this.applyActiveAccount();
    return null;
  }

  /** اگر کمتر از مقدار هشدار تا انقضا مانده، یک پیام جدا با دکمهٔ تمدید بفرست */
  async maybeSendRenew(chatId) {
    if (this.autoRenewOn) return; // تمدید خودکار خودش هشدار و تمدید را انجام می‌دهد
    if (!this.warnMin || this.warnMin <= 0) return;
    const left = this.chat.remainingMs();
    if (left == null || left > this.warnMin * 60000) return;
    await this.send(chatId, this.tr(`⏳ ${humanMs(left)} تا پایان جلسه`, `⏳ ${humanMs(left, 'en')} until the session ends`), {
      reply_markup: { inline_keyboard: [[btn(this.tr('🔄 تمدید جلسه', '🔄 Renew session'), 'menu:renew', 'success')]] },
    }).catch(() => {});
  }

  async runChat(chatId, userId, name, session, text, attempt = 0) {
    if (process.env.DEBUG_CALLER === '1') log.info('RUNCHAT-CALLER', JSON.stringify({busy: this.busy.has(userId), pend: this.pendingBusy.has(userId), text: String(text).slice(0,40), stack: new Error().stack.split('\n').slice(2,7).map(x=>x.trim()).join(' << ')}));
    this.busy.add(userId);
    const controller = new AbortController();
    this.aborters.set(userId, controller);
    const signal = controller.signal;
    const status = await this.send(chatId, this.tr('⏱ ۰ ثانیه · 🧠 در حال فکر کردن…', '⏱ 0s · 🧠 Thinking…'), {
      keep: true, // پیام وضعیت نباید مثل منو با پیام بعدی پاک شود
      reply_markup: { inline_keyboard: [[btn(this.tr('⏹ توقف', '⏹ Stop'), 'runstop', 'danger')]] },
    });
    const statusId = status.message_id;
    const startedAt = Date.now();
    let lastThoughts = '';
    let lastToolLog = [];
    let rendering = false;
    let timedOut = false;
    let lastStepAt = Date.now(); // آخرین باری که از سرور خبری رسید
    const renderProgress = async () => {
      if (rendering || this.tgFlooded()) return;
      if (this.goneMessages.has(statusId)) { clearInterval(tick); return; }
      rendering = true;
      try {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        let body = this.tr(`⏱ ${secs} ثانیه · 🧠 در حال فکر کردن…`, `⏱ ${secs}s · 🧠 Thinking…`);
        // اگر مدت زیادی از سرور خبری نرسیده، علت را شفاف بگو
        const idle = Math.floor((Date.now() - lastStepAt) / 1000);
        if (idle >= 90) {
          body += '\n' + this.tr(
            `⚠️ ${idle} ثانیه است منتظر پاسخ سرور فری‌باف هستم (کندی سرور/پروکسی). اگر خیلی طول کشید «⏹ توقف» را بزن.`,
            `⚠️ Waiting ${idle}s for the Freebuff server (slow server/proxy). Tap "⏹ Stop" if it takes too long.`,
          );
        }
        if (lastThoughts) {
          // فقط ۴۰ کلمهٔ آخر تفکرات نمایش داده شود؛ کلمات جدید جای قبلی‌ها را می‌گیرند
          const words = lastThoughts.split(/\s+/).filter(Boolean);
          const tail = words.slice(-40).join(' ');
          if (tail) body += '\n\n' + tail.slice(-600);
        }
        if (lastToolLog.length) {
          // فقط ۲ دستور آخر و هرکدام کوتاه، تا پیام وضعیت بلند نشود
          const recent = lastToolLog.slice(-2).map((t) => (t.length > 90 ? t.slice(0, 90) + '…' : t));
          body += '\n\n' + this.tr('🔧 در حال اجرا:', '🔧 Running:') + '\n' + recent.map((t) => '• ' + t).join('\n');
        }
        await this.editText(chatId, statusId, body.slice(0, 3900));
        if (this.goneMessages.has(statusId)) clearInterval(tick);
      } finally {
        rendering = false;
      }
    };
    const tick = setInterval(() => { renderProgress(); }, 4000);
    tick.unref?.();
    // نگهبان کل اجرا: اگر اجرا از مهلت تعیین‌شده گذشت، متوقف کن و علت را بگو
    const runTimeoutSec = this.cfg.runTimeoutSec || 300;
    const watchdog = setTimeout(() => {
      timedOut = true;
      log.warn(`اجرا از مهلت ${runTimeoutSec} ثانیه گذشت؛ متوقف می‌شود`);
      controller.abort();
    }, runTimeoutSec * 1000);
    watchdog.unref?.();
    try {
      const history = session.messages.slice(-16);
      const sys = this.cfg.serverTools
        ? this.tr('تو نگهبان فری‌باف هستی؛ دستیار فنی روی همین سرور. ابزارهای run_terminal_command، read_file، list_directory و write_file داری و می‌توانی هر کاری روی سرور انجام دهی. کوتاه، دقیق و فارسی جواب بده. همهٔ افکار و استدلال‌هایت را هم قدم‌به‌قدم و به فارسی بنویس.', 'You are Freebuff Guardian, a technical assistant on THIS server. You have run_terminal_command, read_file, list_directory and write_file tools and can do anything on the server. Be concise.')
        : this.tr('تو نگهبان فری‌باف هستی؛ دستیار فنی کاربر روی سرور خودش. کوتاه، دقیق و فارسی جواب بده. همهٔ افکار و استدلال‌هایت را هم قدم‌به‌قدم و به فارسی بنویس.', 'You are Freebuff Guardian, a technical assistant. Be concise.');
      const messages = [
        { role: 'system', content: sys },
        ...history,
        { role: 'user', content: text },
      ];

      let answer;
      if (this.cfg.serverTools) {
        const res = await this.agentLoop(chatId, userId, messages, ({ thoughts, toolLog }) => {
          lastStepAt = Date.now();
          lastThoughts = thoughts || '';
          lastToolLog = toolLog || [];
          return renderProgress();
        }, signal);
        answer = res.answer;
      } else {
        answer = await this.chat.complete({ model: this.settings.getModel(), messages, signal });
      }

      // دکمهٔ توقف دیگر لازم نیست
      await this.clearMarkup(chatId, statusId);

      this.state.pushMessage(userId, name, { role: 'user', content: text });
      this.state.pushMessage(userId, name, { role: 'assistant', content: answer });

      // پیام بالایی = وضعیت (مدل/زمان مانده/سهمیه) به‌جای تفکرات
      const statusText = this.statusBlock();
      const edited = await this.editText(chatId, statusId, statusText, { parse_mode: 'Markdown' });
      if (!edited && !this.tgFlooded()) {
        await this.editText(chatId, statusId, statusText.replace(/[*_`]/g, ''));
      }

      const out = answer.length > this.cfg.maxAnswerChars
        ? answer.slice(0, this.cfg.maxAnswerChars) + '\n…' + this.tr('(بریده شد)', '(truncated)')
        : answer || this.tr('(پاسخ خالی)', '(empty answer)');
      // جواب چت باید دست‌نخورده بماند؛ دکمهٔ تمدید در پیام جدا می‌آید
      await this.send(chatId, out);
      await this.maybeSendRenew(chatId);
    } catch (e) {
      // نگهبان اجرا: از مهلت گذشت و خودمان متوقف کردیم
      if (timedOut) {
        log.warn('اجرا به‌خاطر مهلت کل متوقف شد');
        await this.clearMarkup(chatId, statusId);
        await this.editText(chatId, statusId, this.tr(
          `⏱ اجرا بیش از ${runTimeoutSec} ثانیه طول کشید و متوقف شد.\nعلت: پاسخ مدل/سرور فری‌باف کند بود یا در حلقهٔ ابزار گیر کرده بود. دوباره بفرست.`,
          `⏱ The run exceeded ${runTimeoutSec}s and was stopped.\nCause: slow Freebuff model/server or a tool loop. Please resend.`,
        ));
        return;
      }
      // توقف دستی توسط کاربر (دکمهٔ «⏹ توقف»)
      if (e?.name === 'AbortError' || e?.code === 'aborted' || signal.aborted) {
        log.info('چت توسط کاربر متوقف شد');
        await this.clearMarkup(chatId, statusId);
        await this.editText(chatId, statusId, this.tr('⏹ اجرا متوقف شد.', '⏹ Run stopped.'));
        return;
      }
      log.error('چت ناموفق:', e);
      // سهمیهٔ این اکانت تمام شده؟ خودکار روی اکانت بعدی برو و یک‌بار دیگر امتحان کن.
      if (this.isQuotaError(e) && attempt === 0) {
        await this.bot.deleteMessage(chatId, statusId).catch(() => {});
        const switched = await this.tryFailover(chatId, this.settings.getModel(), userId);
        if (switched) return this.runChat(chatId, userId, name, session, text, 1);
      }
      const hint = this.chatErrorHint(e);
      await this.bot.deleteMessage(chatId, statusId).catch(() => {});
      const extra = this.isQuotaError(e)
        ? { reply_markup: { inline_keyboard: this.quotaErrorButtons() } }
        : {};
      await this.send(chatId, `❌ ${hint.slice(0, 900)}`, extra).catch(() => {});
      if (!this.isQuotaError(e)) await this.maybeSendRenew(chatId);
    } finally {
      clearInterval(tick);
      clearTimeout(watchdog);
      this.aborters.delete(userId);
      this.busy.delete(userId);
      // اگر هنگام busy پیامی مانده بود (و کاربر «توقف» را زد)، بعد از آزادشدن قفل اجرا کن
      const queued = this.pendingBusy.get(userId);
      if (queued) {
        this.pendingBusy.delete(userId);
        setTimeout(() => {
          if (this.busy.has(userId)) return;
          this.onChat({ chat: { id: queued.chatId }, from: { id: userId } }, queued.chatId, userId, queued.text)
            .catch((err) => log.error('queuedChat:', err));
        }, 150);
      }
    }
  }
}
