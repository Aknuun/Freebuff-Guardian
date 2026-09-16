// bot.mjs — رابط تلگرام نگهبان فری‌باف
//
// دستورات:
//   /start /help        راهنما
//   /status             وضعیت سرور، فری‌باف و instanceها
//   /settings           نمایش تنظیمات
//   /mode [m]           تغییر نوع پاسخ (DEFAULT|LITE|MAX|PLAN)
//   /model [m]          دیدن/تغییر مدل
//   /ads on|off         تبلیغات
//   /new [نام]          سشن چت جدید
//   /sessions           لیست سشن‌ها
//   /switch <نام>       سوییچ سشن
//   /del <نام>          حذف سشن
//   /clear              پاک‌کردن تاریخچه سشن فعال
//   /restart [svc]      ری‌استارت سرویس systemd
//   /ps                 پروسه‌های کلیدی سرور
//   /freebuff restart|stop|start  کنترل CLI فری‌باف
//   متن ساده            چت با فری‌باف

import TelegramBot from 'node-telegram-bot-api';
import { makeLogger } from './logger.mjs';
import { freeAgentForModel, freeModels } from './config.mjs';
import { FreebuffSettings } from './settings.mjs';
import { FreebuffChat } from './chat.mjs';
import { AccountStore } from './accounts.mjs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execp = promisify(exec);
const log = makeLogger('bot');

// دکمه‌های ثابت پایین تلگرام (Reply Keyboard)
const REPLY_ACTIONS = {
  '📊 وضعیت': 'status', '📊 Status': 'status',
  '🤖 مدل': 'model', '🤖 Model': 'model',
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

/** خطوط سهمیه (استفاده‌شده/مانده) از پاسخ سشن */
function quotaLines(q, lang = 'fa') {
  const en = lang === 'en';
  const lines = [];
  const w = q?.freeWindows;
  if (w) {
    lines.push(en
      ? `🎟 Sessions — today: ${w.dayUsed}/${w.dayLimit} (${Math.max(0, w.dayLimit - w.dayUsed)} left) | week: ${w.weekUsed}/${w.weekLimit} | month: ${w.monthUsed}/${w.monthLimit}`
      : `🎟 سشن — امروز: ${w.dayUsed}/${w.dayLimit} (${Math.max(0, w.dayLimit - w.dayUsed)} مانده) | هفته: ${w.weekUsed}/${w.weekLimit} | ماه: ${w.monthUsed}/${w.monthLimit}`);
  }
  const d = q?.freebucks?.daily;
  if (d) {
    const used = d.spent ?? Math.max(0, (d.limit ?? 0) - (d.remaining ?? 0));
    lines.push(en
      ? `💵 Freebucks — left: ${d.remaining}/${d.limit} | used: ${used}`
      : `💵 Freebucks — مانده: ${d.remaining}/${d.limit} | استفاده‌شده: ${used}`);
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
      },
    });
    this.pendingAdd = new Map(); // userId → نام اکانتی که منتظر JSON آن هستیم
    this.pendingName = new Map(); // userId → منتظر نام دلخواه اکانت هستیم
    this.pendingLogin = new Map(); // userId → ورود وب در جریان { name, fingerprintId, fingerprintHash, expiresAt, timer }
    this.pendingChat = new Map(); // userId → پیامی که منتظر تأیید ساخت سشن است { chatId, text, name }
    this.chat = new FreebuffChat({
      authToken: cfg.fbAuthToken,
      websiteUrl: cfg.websiteUrl,
      agent: cfg.fbAgent,
      instanceManager: instances,
    });
    this.applyActiveAccount();
    this.busy = new Set(); // userId هایی که درخواست پردازشی در جریان دارند
    this.sessionWarned = false;
    this.lastProbe = 0;

    // دقیقهٔ هشدار انقضا: از state خوانده می‌شود و از طریق تنظیمات قابل تغییر است
    const fromState = state.getMeta('sessionWarnMin');
    this.warnMin = parseInt(fromState ?? process.env.SESSION_WARN_MIN ?? '5', 10) || 0;

    // هشدار پیش از انقضای سشن (هر دقیقه بررسی؛ فقط یک‌بار در هر سشن)
    this.warnTimer = setInterval(() => this.checkSessionWarn().catch((e) => log.warn('sessionWarn:', e.message)), 60000);
    this.warnTimer.unref?.();

    this.bot = new TelegramBot(cfg.telegramToken, { polling: true });
    this.bot.on('message', (msg) => this.onMessage(msg).catch((e) => log.error('onMessage:', e)));
    this.bot.on('callback_query', (q) => this.onCallback(q).catch((e) => log.error('onCallback:', e)));
    this.bot.on('polling_error', (e) => log.warn('polling:', e.message));

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

  /** اکانت فعال را روی موتور چت اعمال می‌کند */
  applyActiveAccount() {
    const acc = this.activeAccount();
    if (acc) this.chat.useAccount(acc);
    return acc;
  }

  async accountText() {
    const list = this.accounts.list();
    const active = this.activeAccountName();
    const quotas = await Promise.all(list.map((a) => this.chat.accountQuota(a).catch(() => null)));
    const lang = this.lang();
    const lines = [
      this.tr('👤 *اکانت‌های فری‌باف*', '👤 *Freebuff accounts*'),
      this.tr(`فعال: \`${active}\``, `Active: \`${active}\``),
      this.tr(`${list.length} اکانت`, `${list.length} account(s)`),
      '',
    ];
    list.forEach((a, i) => {
      const q = quotas[i];
      const actor = a.label && a.label !== a.name ? `${a.name} — ${a.label}` : a.name;
      lines.push(`${a.name === active ? '✅' : '•'} ${actor}${q && q.status !== 'active' ? this.tr(' (بدون سشن)', ' (no session)') : ''}`);
      const ql = quotaLines(q, lang);
      if (ql.length) for (const l of ql) lines.push('   ' + l);
      else lines.push(this.tr('   سهمیه: —', '   quota: —'));
    });
    lines.push('', this.tr('برای تعویض، روی اکانت بزن.', 'Tap an account to switch.'));
    return lines.join('\n');
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

    const deadline = Math.min(Date.now() + 10 * 60000, code.expiresAt || 0) || Date.now() + 10 * 60000;
    const st = { name: valid ? name : null, fingerprintId: code.fingerprintId || fingerprintId, fingerprintHash: code.fingerprintHash, expiresAt: code.expiresAt };
    st.timer = setInterval(() => this.checkWebLogin(chatId, userId, deadline).catch(() => {}), 5000);
    st.timer.unref?.();
    this.pendingLogin.set(userId, st);

    const kb = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔗 باز کردن صفحهٔ ورود', url: code.loginUrl, style: 'success' }],
          [btn('❌ لغو', 'accwebcancel', 'danger')],
        ],
      },
    };
    const title = st.name ? `«${st.name}»` : 'جدید';
    return this.send(chatId, `🌐 *افزودن اکانت ${title}*\n\n۱) دکمهٔ «🔗 باز کردن صفحهٔ ورود» را بزن.\n۲) در سایت فری‌باف لاگین کن و تأیید کن.\n\n⏳ منتظر تأیید هستم…`, kb);
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
    try { r = await this.chat.pollCliLogin(st); } catch { return; }
    if (!r?.ok) return;
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
      [btn(this.tr('📋 پیست credentials.json', '📋 Paste credentials.json'), `accjson${suffix}`)],
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
    rows.push([btn(this.tr('➕ افزودن اکانت', '➕ Add account'), 'acc:add', 'success')]);
    rows.push([btn(this.tr('↩️ تنظیمات', '↩️ Settings'), 'menu:settings'), btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')]);
    return rows;
  }

  async send(chatId, text, extra = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
    } catch {
      // Markdown شکسته نباشد
      return this.bot.sendMessage(chatId, text.replace(/[*_`]/g, ''), extra);
    }
  }

  async onMessage(msg) {
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    if (!chatId || !userId || !this.allowed(userId)) return; // سکوت برای غریبه‌ها

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
        return this.render(chatId, null, this.homeText(u), this.homeKeyboard(u));

      case '/help':
        return this.send(chatId, this.helpText(), { reply_markup: { inline_keyboard: this.helpKeyboard() } });

      case '/status':
        return this.send(chatId, await this.statusText(userId), { reply_markup: { inline_keyboard: this.statusKeyboard() } });

      case '/renew':
        return this.doRenew(chatId, null);

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
          // سشن رایگان سمت سرور به مدل قفل است؛ برای تغییر، سشن فعلی بسته و
          // سشن جدید با مدل خواسته‌شده ساخته می‌شود.
          const session = await this.chat.switchSessionModel(arg);
          this.settings.setModel(arg);
          const agent = freeAgentForModel(arg);
          const left = session.remainingMs ? `\n⏳ باقیمانده سشن: ${Math.round(session.remainingMs / 60000)} دقیقه` : '';
          return this.send(chatId, `✅ مدل روی \`${arg}\` تنظیم شد${agent ? `\nایجنت رایگان: \`${agent}\`` : ''}${left}`);
        } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
      }

      case '/account': {
        const [sub, name] = arg.split(/\s+/);
        if (!arg) return this.send(chatId, await this.accountText(), { reply_markup: { inline_keyboard: this.accountKeyboard() } });
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
        return this.send(chatId, this.tr(`✅ سشن \`${name}\` ساخته شد و فعال شد`, `✅ Chat \`${name}\` created and activated`));
      }

      case '/sessions': {
        const names = this.state.listSessions(userId);
        if (!names.length) return this.send(chatId, this.tr('هیچ سشنی نیست. /new بزن.', 'No chats yet. Send /new.'));
        return this.send(chatId, names.map((n) => `${n === u.activeSession ? '👉' : '•'} ${n} (${this.state.getSession(userId, n).messages.length} پیام)`).join('\n'));
      }

      case '/switch': {
        if (!arg || !this.state.getSession(userId, arg)) return this.send(chatId, this.tr('سشن پیدا نشد. /sessions را ببین.', 'Chat not found. See /sessions.'));
        u.activeSession = arg;
        this.state.save();
        return this.send(chatId, this.tr(`✅ سوییچ شد به \`${arg}\``, `✅ Switched to \`${arg}\``));
      }

      case '/del': {
        if (!arg || !this.state.getSession(userId, arg)) return this.send(chatId, this.tr('سشن پیدا نشد.', 'Chat not found.'));
        this.state.deleteSession(userId, arg);
        return this.send(chatId, this.tr(`🗑 سشن \`${arg}\` حذف شد`, `🗑 Chat \`${arg}\` deleted`));
      }

      case '/clear': {
        if (!u.activeSession) return this.send(chatId, 'سشن فعالی نیست.');
        this.state.clearMessages(userId, u.activeSession);
        return this.send(chatId, this.tr('🧹 تاریخچه سشن فعال پاک شد', '🧹 Active chat history cleared'));
      }

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
    if (left == null) return this.tr('⏳ سشن بسته — /start', '⏳ Session closed — /start');
    return this.tr(`⏳ سشن: ${humanMs(left)}`, `⏳ Session: ${humanMs(left, 'en')}`);
  }

  homeKeyboard(u) {
    const langLabel = this.lang() === 'fa' ? '🌐 EN' : '🌐 فا';
    return [
      [
        btn(this.tr(`💬 سشن‌ها (${u.activeSession ?? '—'})`, `💬 Chats (${u.activeSession ?? '—'})`), 'menu:sessions', 'primary'),
        btn(this.tr('⚙️ تنظیمات', '⚙️ Settings'), 'menu:settings', 'primary'),
        btn(this.tr('👤 اکانت‌ها', '👤 Accounts'), 'menu:account', 'primary'),
      ],
      [btn(this.tr('➕ سشن جدید', '➕ New chat'), 'menu:new', 'success'), btn(this.tr('🧹 پاک‌کردن تاریخچه', '🧹 Clear history'), 'menu:clear', 'danger')],
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
      [btn(this.tr('💵 سهمیه و Freebucks', '💵 Quota & Freebucks'), 'help:quota', 'primary')],
      [btn(this.tr('⏳ سشن و تایمر', '⏳ Session & timer'), 'help:session', 'primary')],
      [btn(this.tr('🤖 مدل‌ها', '🤖 Models'), 'help:model', 'primary')],
      [btn(this.tr('👤 اکانت‌ها', '👤 Accounts'), 'help:account', 'primary')],
      [btn(this.tr('💬 چت و سشن‌ها', '💬 Chat & sessions'), 'help:chat', 'primary')],
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
        '💵 *سهمیه و Freebucks*',
        '',
        'فری‌باف هر روز یک بودجهٔ «Freebucks» می‌دهد که بین همهٔ مدل‌ها مشترک است.',
        '• هر سشن، هنگام شروع، معادل قیمت ساعتی مدل از Freebucks کم می‌کند (یک‌بار، نه هر پیام).',
        '• قیمت‌ها (Freebucks برای هر ساعت): GLM=۵ · Kimi=۵ · MiMo=۱۰ · Solar=۱۰ · DeepSeek V4 Flash=۱۵ · Luna=۲۰ · Gemini=۵۰',
        '• اگر همهٔ بودجه روی یک مدل خرج شود: GLM ≈ ۱۴ ساعت · DeepSeek ≈ ۴ ساعت · Luna ≈ ۳ ساعت.',
        '• بودجه هر روز نیمه‌شب Pacific پر می‌شود و منتقل نمی‌شود.',
        '• بعضی مدل‌ها «پریمیوم»‌اند و سقف روزانهٔ جدا (۵ بار) هم دارند.',
        '',
        '📊 استفاده‌شده و مانده در «وضعیت» و «👤 اکانت‌ها» نوشته می‌شود.',
      ].join('\n'),
      session: [
        '⏳ *سشن و تایمر*',
        '',
        'هر سشن رایگان دقیقاً ۱ ساعت عمر می‌کند و چت‌کردن تمدیدش نمی‌کند.',
        '• دکمهٔ «⏳ سشن» زمان باقی‌مانده را نشان می‌دهد.',
        '• ۵ دقیقه قبل از انقضا هشدار می‌آید (در تنظیمات قابل تغییر).',
        '• «🔄 تمدید سشن» تایمر را از نو می‌کند؛ «/start» منوی اصلی را باز می‌کند.',
        '• پیام بعدی هم خودکار سشن تازه می‌سازد؛ پس وقفه‌ای حس نمی‌کنی.',
      ].join('\n'),
      model: [
        '🤖 *مدل‌ها*',
        '',
        'از «🤖 مدل» مدل را عوض کن؛ agent هماهنگ خودکار انتخاب می‌شود.',
        'کنار هر مدل قیمت (Freebucks/ساعت) و سهمیهٔ ساعتی امروز با آن مدل نوشته شده.',
        '• ارزان‌ترین: GLM 5.3 Flash · Kimi (۵ FB/ساعت)',
        '• متوسط: MiMo 2.5 · Solar Pro 4 (۱۰)',
        '• گران‌تر: DeepSeek V4 Flash (۱۵) · Luna (۲۰) · Gemini (۵۰)',
      ].join('\n'),
      account: [
        '👤 *اکانت‌ها*',
        '',
        'برای استفادهٔ شریکی؛ هرکس اکانت خودش.',
        '«➕ افزودن اکانت» را بزن و یکی را انتخاب کن:',
        '• «🌐 ورود با وب» — لینک لاگین می‌دهد؛ در سایت فری‌باف لاگین کن.',
        '• «📋 پیست credentials.json» — اگر فایل را داری.',
        '• «✏️ با نام دلخواه» — قبلش اسم بده.',
        '',
        'هر اکانت سشن و Freebucks مستقل دارد؛ با زدن روی اکانت فعال می‌شود.',
      ].join('\n'),
      chat: [
        '💬 *چت و سشن‌ها*',
        '',
        'یک پیام معمولی بفرست تا با مدل فعال چت کنی.',
        '• «➕ سشن جدید» یک گفتگوی جدا می‌سازد.',
        '• «💬 سشن‌ها» برای سوییچ/حذف (حذف با تأیید).',
        '• «🧹 پاک‌کردن تاریخچه» پیام‌های سشن فعال را پاک می‌کند.',
      ].join('\n'),
      server: [
        '🖥 *سرور*',
        '',
        '• «📈 پروسه‌ها» — پروسه‌های پرحافظه',
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
        '• «🌐» بین دو دکمهٔ سرور و راهنما زبان را عوض می‌کند',
      ].join('\n'),
    };
    const en = {
      quota: [
        '💵 *Quota & Freebucks*',
        '',
        'Freebuff gives a daily Freebucks budget shared across all models.',
        '• Starting a session charges the model\'s hourly price once (not per message).',
        '• Prices (Freebucks/hour): GLM=5 · Kimi=5 · MiMo=10 · Solar=10 · DeepSeek V4 Flash=15 · Luna=20 · Gemini=50',
        '• Spending it all on one model: GLM ≈ 14h · DeepSeek ≈ 4h · Luna ≈ 3h.',
        '• The budget refills at midnight Pacific and does not carry over.',
        '• Some models are "premium" and also have a separate daily cap (5).',
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
        'Each model shows its price (Freebucks/hour) and today\'s hours left with it.',
        '• Cheapest: GLM 5.3 Flash · Kimi (5 FB/h)',
        '• Mid: MiMo 2.5 · Solar Pro 4 (10)',
        '• Pricier: DeepSeek V4 Flash (15) · Luna (20) · Gemini (50)',
      ].join('\n'),
      account: [
        '👤 *Accounts*',
        '',
        'For shared use; each person uses their own account.',
        'Tap "➕ Add account" and choose:',
        '• "🌐 Web login" — gives a login link; sign in on the Freebuff site.',
        '• "📋 Paste credentials.json" — if you have the file.',
        '• "✏️ Custom name" — set a name first.',
        '',
        'Each account has its own session and Freebucks; tap it to activate.',
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
        '• "🌐" between Server and Help switches the language',
      ].join('\n'),
    };
    const sections = this.lang() === 'en' ? en : fa;
    return sections[section] || this.helpText();
  }

  settingsText() {
    const warn = this.warnMin > 0
      ? this.tr(`${this.warnMin} دقیقه قبل از انقضا`, `${this.warnMin} min before expiry`)
      : this.tr('خاموش', 'off');
    return [
      this.tr('⚙️ *تنظیمات*', '⚙️ *Settings*'),
      this.tr(`🎛 نوع پاسخ: ${this.modeLabel(this.settings.getMode())}`, `🎛 Response mode: ${this.modeLabel(this.settings.getMode())}`),
      this.tr(`📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`, `📢 Ads: ${this.settings.getAds() ? 'on' : 'off'}`),
      this.tr(`🤖 مدل: \`${this.settings.getModel()}\``, `🤖 Model: \`${this.settings.getModel()}\``),
      this.tr(`👤 اکانت فعال: \`${this.activeAccountName()}\``, `👤 Active account: \`${this.activeAccountName()}\``),
      this.tr(`⏰ هشدار انقضای سشن: ${warn}`, `⏰ Session expiry warning: ${warn}`),
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
      [btn(this.tr('🔄 تمدید سشن', '🔄 Renew session'), 'menu:renew', 'success')],
      [btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
    ];
  }

  homeText(u) {
    const left = this.chat.remainingMs();
    const fa = `🛡️ *نگهبان فری‌باف*\n\nمدل: \`${this.settings.getModel()}\`\nسشن فعال: \`${u.activeSession ?? '—'}\`${left == null ? '' : `\n⏳ سشن فری‌باف: ${humanMs(left)} دیگر`}\n\nاز دکمه‌ها استفاده کن یا پیام بفرست تا چت کند.`;
    const en = `🛡️ *Freebuff Guardian*\n\nModel: \`${this.settings.getModel()}\`\nActive chat: \`${u.activeSession ?? '—'}\`${left == null ? '' : `\n⏳ Freebuff session: ${humanMs(left, 'en')} left`}\n\nUse the buttons or just send a message to chat.`;
    return this.tr(fa, en);
  }

  /** هشدار اتمام سهمیه (اگر Freebucks امروز صفر باشد) */
  quotaExhaustedNote() {
    const daily = this.chat.lastQuota?.freebucks?.daily;
    if (!daily || daily.remaining > 0) return '';
    const ms = daily.resetAt ? Date.parse(daily.resetAt) - Date.now() : null;
    const resetFa = ms > 0 ? `؛ ریست تا ${humanMs(ms, 'fa')} دیگر` : '';
    const resetEn = ms > 0 ? `; resets in ${humanMs(ms, 'en')}` : '';
    return this.tr(
      `🚫 سهمیهٔ Freebucks امروز تمام شده${resetFa}.\nمی‌توانی پلن را ارتقا بدهی: https://freebuff.com/plans`,
      `🚫 Daily Freebucks are used up${resetEn}.\nYou can upgrade: https://freebuff.com/plans`,
    );
  }

  modelText() {
    const cur = this.settings.getModel();
    const base = this.tr(
      `🤖 *مدل‌های رایگان*\nفعلی: \`${cur}\`\nکنار هر مدل قیمت (Freebucks/ساعت) و سهمیهٔ ساعتی امروز با آن مدل نوشته شده.`,
      `🤖 *Free models*\nCurrent: \`${cur}\`\nEach model shows its price (Freebucks/hour) and today's hours left with it.`,
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
    const rows = freeModels().map((m) => {
      const p = prices[m];
      let info = '';
      if (p != null) {
        const hours = remaining != null ? Math.floor(remaining / p) : null;
        info = hours != null ? ` · ${p}FB · ${hours}h` : ` · ${p}FB`;
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
    rows.push([btn(this.tr('➕ سشن جدید', '➕ New chat'), 'menu:new', 'success')]);
    rows.push([btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')]);
    return rows;
  }

  sessionsText(userId) {
    const names = this.state.listSessions(userId);
    if (!names.length) return this.tr('هیچ سشنی نیست. ➕ را بزن.', 'No chats yet. Tap ➕.');
    const u = this.state.user(userId);
    const list = names
      .map((n) => `${n === u.activeSession ? '👉' : '•'} \`${n}\` (${this.state.getSession(userId, n).messages.length} ${this.tr('پیام', 'msgs')})`)
      .join('\n');
    return `${this.tr('💬 *سشن‌ها*', '💬 *Chats*')}\n${list}`;
  }

  serverKeyboard() {
    return [
      [btn(this.tr('🔄 تمدید سشن', '🔄 Renew session'), 'menu:renew', 'success')],
      [btn(this.tr('📈 پروسه‌ها', '📈 Processes'), 'svc:ps', 'primary')],
      [btn(this.tr('♻️ ری‌استارت freebuff', '♻️ Restart freebuff'), 'fb:restart', 'success'), btn(this.tr('⏹ توقف CLI', '⏹ Stop CLI'), 'fb:stop', 'danger')],
      [btn(this.tr('🔐 وضعیت instance', '🔐 Instance status'), 'menu:instances', 'primary'), btn(this.tr('🔓 آزادسازی قفل', '🔓 Release lock'), 'svc:unlock', 'danger')],
      [btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
    ];
  }

  statusKeyboard() {
    return [
      [btn(this.tr('🔄 تمدید سشن', '🔄 Renew session'), 'menu:renew', 'success'), btn(this.tr('🏠 منوی اصلی', '🏠 Home'), 'menu:home')],
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
        ? this.tr(`🔓 سشن سرور: \`${sess.model}\` — ⏳ ${humanMs(left)} دیگر`, `🔓 Server session: \`${sess.model}\` — ⏳ ${humanMs(left, 'en')} left`)
        : this.tr('🔓 سشن سرور: — (پیام بعدی سشن تازه می‌سازد)', '🔓 Server session: — (next message starts a fresh one)'),
      this.tr(`🎛 نوع پاسخ: ${this.modeLabel(this.settings.getMode())}`, `🎛 Response mode: ${this.modeLabel(this.settings.getMode())}`),
      this.tr(`📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`, `📢 Ads: ${this.settings.getAds() ? 'on' : 'off'}`),
      `🔐 ${fbSession}`,
      this.tr(`💬 سشن فعال: ${this.state.user(userId).activeSession ?? '—'}`, `💬 Active chat: ${this.state.user(userId).activeSession ?? '—'}`),
    ];
    const quota = sess ?? this.chat.lastQuota;
    if (!sess && quota) lines.push(this.tr('♻️ سهمیهٔ زیر آخرین مقدار ثبت‌شده است', '♻️ Quota below is the last recorded value'));
    lines.push(...quotaLines(quota, lang));
    return lines.join('\n');
  }

  /** بستن سشن فعلی و ساخت سشن تازه (ریست تایمر ۱ ساعته) */
  async doRenew(chatId, messageId) {
    this.applyActiveAccount();
    const sess = await this.chat.activeSession().catch(() => null);
    const model = sess?.model || this.settings.getModel();
    try {
      await this.chat.renewSession(model);
      return this.render(chatId, messageId, this.tr(`✅ سشن \`${model}\` تمدید شد — ⏳ ${humanMs(this.chat.remainingMs())} دیگر`, `✅ Session \`${model}\` renewed — ⏳ ${humanMs(this.chat.remainingMs(), 'en')} left`), this.statusKeyboard());
    } catch (e) {
      return this.render(chatId, messageId, `❌ ${e.message}`, this.statusKeyboard());
    }
  }

  /** هشدار یک‌باره پیش از انقضای سشن */
  async checkSessionWarn() {
    if (this.warnMin <= 0) { this.sessionWarned = false; return; }
    this.applyActiveAccount();
    const warnMin = this.warnMin;
    const left = this.chat.remainingMs();
    if (left == null) {
      // سشنی شناخته‌شده نیست؛ هر ۵ دقیقه یک‌بار سرور را بررسی کن
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
    const text = this.tr(
      `⏳ سشن فری‌باف ${humanMs(left)} دیگر بسته می‌شود.\nبرای تمدید /renew بزن، یا پیام بعدی خودکار سشن تازه می‌سازد.`,
      `⏳ Freebuff session closes in ${humanMs(left, 'en')}.\nTap Renew or just send your next message to start a fresh session.`,
    );
    const kb = { reply_markup: { inline_keyboard: [[{ text: this.tr('🔄 تمدید سشن', '🔄 Renew session'), callback_data: 'menu:renew' }]] } };
    for (const id of this.cfg.allowedUserIds) {
      const chatId = this.state.user(id).chatId;
      if (chatId) await this.send(chatId, text, kb).catch(() => {});
    }
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
    const home = () => this.render(chatId, messageId, this.homeText(u), this.homeKeyboard(u));

    switch (action) {
      case 'menu':
        switch (value) {
          case 'home': return home();
          case 'status':
          case 'timer': return this.render(chatId, messageId, await this.statusText(userId), this.statusKeyboard());
          case 'renew': return this.doRenew(chatId, messageId);
          case 'settings': return this.render(chatId, messageId, this.settingsText(), this.settingsKeyboard());
          case 'account': return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());

          case 'start': {
            const sess = await this.chat.activeSession().catch(() => null);
            if (!sess) {
              await answer('⏳ ساخت سشن…');
              try { await this.chat.renewSession(this.settings.getModel()); }
              catch (e) { await answer(e.message); }
            } else {
              await answer(this.tr('سشن فعال است', 'Session is active'));
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
            await answer(`سشن ${name} ساخته شد`);
            return this.render(chatId, messageId, this.sessionsText(userId), this.sessionsKeyboard(userId));
          }
          case 'clear': {
            if (!u.activeSession) { await answer('سشن فعالی نیست'); return home(); }
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

      case 'chatNew': {
        const pend = this.pendingChat.get(userId);
        this.pendingChat.delete(userId);
        if (value === 'cancel' || !pend) {
          await answer(this.tr('لغو شد', 'Cancelled'));
          return home();
        }
        this.applyActiveAccount();
        try {
          await this.chat.renewSession(this.settings.getModel());
        } catch (e) {
          return this.send(chatId, `❌ ${this.chatErrorHint(e)}`, { reply_markup: { inline_keyboard: this.homeKeyboard(u) } });
        }
        const session = this.state.getSession(userId, pend.name) || this.state.ensureSession(userId, pend.name);
        await answer(this.tr('سشن ساخته شد، در حال ارسال…', 'Session started, sending…'));
        return this.runChat(chatId, userId, pend.name, session, pend.text);
      }

      case 'acc': {
        if (value === 'add') {
          return this.render(chatId, messageId, this.tr('➕ *افزودن اکانت*\nروش را انتخاب کن (نام خودکار از ایمیل ساخته می‌شود):', '➕ *Add account*\nChoose a method (name auto-derived from email):'), this.accountMethodKeyboard());
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

      case 'accnamed':
        this.pendingName.set(userId, true);
        return this.render(chatId, messageId, '✏️ نام اکانت را بفرست (حروف/عدد/`.-_`)…', [[{ text: '↩️ اکانت‌ها', callback_data: 'menu:account' }]]);

      case 'accweb':
        return this.startWebLogin(chatId, userId, value);

      case 'accjson':
        this.pendingAdd.set(userId, value);
        return this.render(chatId, messageId, `📋 محتوای کامل فایل \`credentials.json\` اکانت «${value}» را پیست و بفرست.`, [[{ text: '↩️ اکانت‌ها', callback_data: 'menu:account' }]]);

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
        this.sessionWarned = false;
        await answer(this.warnMin > 0 ? `هشدار روی ${this.warnMin} دقیقه تنظیم شد` : 'هشدار خاموش شد');
        return this.render(chatId, messageId, this.settingsText(), this.settingsKeyboard());
      }

      case 'ses': {
        const name = decodeURIComponent(value);
        if (!this.state.getSession(userId, name)) { await answer(this.tr('سشن پیدا نشد', 'Chat not found')); return home(); }
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
        return this.render(chatId, messageId, `مطمئنی سشن \`${name}\` حذف شود؟`, kb);
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

  /** دریافت JSON اکانت پس از /account add */
  async handleAccountJson(chatId, userId, text) {
    const preferred = this.pendingAdd.get(userId) || null;
    this.pendingAdd.delete(userId);
    let raw;
    try {
      raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      return this.send(chatId, this.tr('❌ JSON نامعتبر بود. دوباره «➕ افزودن اکانت» را بزن.', '❌ Invalid JSON. Tap ➕ Add account again.'));
    }
    try {
      const name = this.nextAccountName(preferred, raw?.default ?? raw);
      const acc = this.accounts.add(name, raw);
      return this.send(chatId, this.tr(`✅ اکانت \`${acc.name}\` اضافه شد. برای فعال‌کردن روی آن بزن.`, `✅ Account \`${acc.name}\` added. Tap it to activate.`), { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    } catch (e) {
      return this.send(chatId, `❌ ${e.message}`);
    }
  }

  // ---------- چت ----------
  /** ترجمهٔ خطاهای بک‌اند به پیام قابل‌فهم */
  chatErrorHint(e) {
    const status = e.status;
    const code = e.code;
    const body = String(e.body || e.message || '').toLowerCase();
    if (code === 'rate_limited' || code === 'spend_limited' || code === 'ip_capped') {
      const ms = e.data?.retryAfterMs;
      const when = ms ? humanMs(ms, this.lang()) : '';
      const link = e.data?.upgrade?.url || 'https://freebuff.com/plans';
      return this.tr(
        `سهمیهٔ Freebucks امروز تمام شده${when ? `؛ ریست تا ${when} دیگر` : ''}.\nمی‌توانی پلن را ارتقا بدهی: ${link}`,
        `Your daily Freebucks are used up${when ? `; resets in ${when}` : ''}.\nYou can upgrade: ${link}`,
      );
    }
    if (body.includes('waiting_room_required') || status === 428) {
      return this.tr('سشن فری‌باف تمام شده بود. دوباره پیام بفرست یا «➕ ایجاد سشن جدید» را بزن.', 'Your free session had ended. Send again or tap "➕ Start session".');
    }
    if (body.includes('free_mode_invalid_agent_model')) {
      return this.tr('این ترکیب مدل و agent مجاز نیست؛ از منوی «مدل» یک مدل دیگر انتخاب کن.', 'This model/agent combination is not allowed; pick another model from the Model menu.');
    }
    if (body.includes('free_mode_cli_required')) {
      return this.tr('مود رایگان فعلاً فقط از طریق CLI فعال است.', 'Free mode is currently CLI-only.');
    }
    if (body.includes('session_superseded') || status === 409) {
      return this.tr('تداخل سشن (۴۰۹): یک نمونهٔ دیگر سشن را گرفت. کمی بعد دوباره فرست کن.', 'Session conflict (409): another instance took the session. Try again shortly.');
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
    if (this.pendingName.has(userId)) return this.handleNameInput(chatId, userId, text);
    if (this.pendingAdd.has(userId)) return this.handleAccountJson(chatId, userId, text);
    if (this.busy.has(userId)) {
      return this.send(chatId, this.tr('⏳ هنوز پاسخ قبلی در جریان است…', '⏳ The previous answer is still in progress…'));
    }
    this.applyActiveAccount();
    if (!this.activeAccount()?.authToken) {
      return this.send(chatId, this.tr('❌ credentials فری‌باف پیدا نشد. اول در سرور freebuff login کن.', '❌ Freebuff credentials not found. Run freebuff login first.'));
    }

    const u = this.state.user(userId);
    const name = u.activeSession || (this.state.ensureSession(userId, 'chat-1'), 'chat-1');
    const session = this.state.getSession(userId, name);

    // برای جلوگیری از اسراف: اگر سشنی باز نیست، قبل از ساخت سشن اجازه بگیر.
    const active = await this.chat.activeSession().catch(() => null);
    if (!active) {
      this.pendingChat.set(userId, { chatId, text, name });
      return this.send(chatId, this.tr(
        '🚫 فعلاً هیچ سشن فری‌بافی باز نیست.\nاگر بفرستی، یک سشن تازه ساخته می‌شود و از Freebucks امروزت کم می‌کند.',
        '🚫 No freebuff session is currently open.\nIf you continue, a new session will start and use your daily Freebucks.',
      ), {
        reply_markup: {
          inline_keyboard: [
            [btn(this.tr('➕ ایجاد سشن جدید و ارسال', '➕ Start session & send'), 'chatNew:go', 'success')],
            [btn(this.tr('❌ انصراف', '❌ Cancel'), 'chatNew:cancel', 'danger')],
          ],
        },
      });
    }

    return this.runChat(chatId, userId, name, session, text);
  }

  /** اجرای واقعی چت روی سشن موجود */
  async runChat(chatId, userId, name, session, text) {
    this.busy.add(userId);
    const progress = await this.send(chatId, '🤔 …');
    try {
      const history = session.messages.slice(-16);
      const messages = [
        { role: 'system', content: 'تو نگهبان فری‌باف هستی؛ دستیار فنی کاربر روی سرور خودش. کوتاه، دقیق و فارسی جواب بده.' },
        ...history,
        { role: 'user', content: text },
      ];

      const answer = await this.chat.complete({ model: this.settings.getModel(), messages });
      this.state.pushMessage(userId, name, { role: 'user', content: text });
      this.state.pushMessage(userId, name, { role: 'assistant', content: answer });

      const out = answer.length > this.cfg.maxAnswerChars
        ? answer.slice(0, this.cfg.maxAnswerChars) + '\n…' + this.tr('(بریده شد)', '(truncated)')
        : answer || this.tr('(پاسخ خالی)', '(empty answer)');
      await this.bot.editMessageText(out, { chat_id: chatId, message_id: progress.message_id });
    } catch (e) {
      log.error('چت ناموفق:', e);
      const hint = this.chatErrorHint(e);
      // خطا به‌صورت پیام تازه در پایین فرستاده می‌شود (نه ویرایش پیام بالایی).
      await this.bot.deleteMessage(chatId, progress.message_id).catch(() => {});
      await this.send(chatId, `❌ ${hint.slice(0, 500)}`, { reply_markup: { inline_keyboard: this.statusKeyboard() } }).catch(() => {});
    } finally {
      this.busy.delete(userId);
    }
  }
}
