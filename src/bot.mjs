// bot.mjs — رابط تلگرام نگهبان فری‌باف
//
// دستورات:
//   /start /help        راهنما
//   /status             وضعیت سرور، فری‌باف و instanceها
//   /settings           نمایش تنظیمات
//   /mode [m]           تغییر مود (DEFAULT|AGENT|PLAN|PRINT)
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
const REPLY_LABELS = new Set(['📊 وضعیت', '▶️ شروع', '🤖 مدل']);

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
function quotaLines(q) {
  const lines = [];
  const w = q?.freeWindows;
  if (w) {
    lines.push(`🎟 سشن — امروز: ${w.dayUsed}/${w.dayLimit} (${Math.max(0, w.dayLimit - w.dayUsed)} مانده) | هفته: ${w.weekUsed}/${w.weekLimit} | ماه: ${w.monthUsed}/${w.monthLimit}`);
  }
  const d = q?.freebucks?.daily;
  if (d) {
    const used = d.spent ?? Math.max(0, (d.limit ?? 0) - (d.remaining ?? 0));
    lines.push(`💵 Freebucks — مانده: ${d.remaining}/${d.limit} | استفاده‌شده: ${used}`);
  }
  return lines;
}

/** نمایش خوانای مدت‌زمان میلی‌ثانیه‌ای */
function humanMs(ms) {
  if (ms == null) return '—';
  const total = Math.max(0, Math.round(ms / 60000));
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

  // ---------- کیبورد ثابت پایین ----------
  replyKeyboardMarkup() {
    return {
      reply_markup: {
        keyboard: [[
          { text: '📊 وضعیت', style: 'primary' },
          { text: '▶️ شروع', style: 'success' },
          { text: '🤖 مدل', style: 'primary' },
        ]],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: 'پیام بفرست یا از دکمه‌ها استفاده کن',
      },
    };
  }

  showReplyKeyboard(chatId) {
    return this.send(chatId, '⌨️ دکمه‌های ثابت پایین فعال شد.', this.replyKeyboardMarkup());
  }

  /** دکمه‌های ثابت پایین (متن پیام = برچسب دکمه) */
  async handleReplyButton(chatId, userId, label) {
    const u = this.state.user(userId);
    u.chatId = chatId;
    switch (label) {
      case '📊 وضعیت':
        return this.send(chatId, await this.statusText(userId), { reply_markup: { inline_keyboard: this.statusKeyboard() } });
      case '▶️ شروع':
        return this.render(chatId, null, this.homeText(u), this.homeKeyboard(u));
      case '🤖 مدل':
        return this.send(chatId, `🤖 *مدل‌های رایگان*\nفعلی: \`${this.settings.getModel()}\`\nبرای سوییچ روی مدل بزن.`, { reply_markup: { inline_keyboard: this.modelKeyboard() } });
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
    const lines = ['👤 *اکانت‌های فری‌باف*', `فعال: \`${active}\``, `${list.length} اکانت`, ''];
    list.forEach((a, i) => {
      const q = quotas[i];
      const actor = a.label && a.label !== a.name ? `${a.name} — ${a.label}` : a.name;
      lines.push(`${a.name === active ? '✅' : '•'} ${actor}${q && q.status !== 'active' ? ' (بدون سشن)' : ''}`);
      const ql = quotaLines(q);
      if (ql.length) for (const l of ql) lines.push('   ' + l);
      else lines.push('   سهمیه: —');
    });
    lines.push('', 'برای تعویض، روی اکانت بزن.');
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
      return this.send(chatId, '❌ نام اکانت نامعتبر است (حروف/عدد/.-_ و نه default).');
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
      return this.send(chatId, `✅ اکانت \`${acc.name}\` ${acc.email ? `(${acc.email}) ` : ''}اضافه شد. برای فعال‌کردن روی آن بزن.`, { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    } catch (e) {
      return this.send(chatId, `❌ ${e.message}`);
    }
  }

  /** انتخاب روش افزودن اکانت (نام اختیاری) */
  accountMethodKeyboard(name = '') {
    const suffix = `:${name}`;
    return [
      [btn('🌐 ورود با وب', `accweb${suffix}`, 'success')],
      [btn('📋 پیست credentials.json', `accjson${suffix}`)],
      [btn('✏️ با نام دلخواه', 'accnamed')],
      [btn('↩️ اکانت‌ها', 'menu:account')],
    ];
  }

  accountKeyboard() {
    const active = this.activeAccountName();
    const rows = this.accounts.list().map((a) => {
      const label = a.label && a.label !== a.name ? `${a.name} — ${a.label}` : a.name;
      return [btn(`${a.name === active ? '✅ ' : ''}${label}`, `acc:${a.name}`, a.name === active ? 'success' : 'primary')];
    });
    rows.push([btn('➕ افزودن اکانت', 'acc:add', 'success')]);
    rows.push([btn('↩️ تنظیمات', 'menu:settings'), btn('🏠 منوی اصلی', 'menu:home')]);
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

    if (REPLY_LABELS.has(text)) return this.handleReplyButton(chatId, userId, text);
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
        if (!arg) return this.send(chatId, `مود فعلی: \`${this.settings.getMode()}\`\nاستفاده: /mode DEFAULT|AGENT|PLAN|PRINT`);
        try {
          this.settings.setMode(arg.toUpperCase());
          return this.send(chatId, `✅ مود روی \`${arg.toUpperCase()}\` تنظیم شد`);
        } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
      }

      case '/model': {
        if (!arg) {
          const model = this.settings.getModel();
          const agent = freeAgentForModel(model);
          return this.send(chatId, `مدل فعلی: \`${model}\`${agent ? `\nایجنت رایگان: \`${agent}\`` : ''}\nاستفاده: /model provider/model\nلیست: /models`);
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
          if (!this.accounts.has(name)) return this.send(chatId, '❌ اکانت پیدا نشد.');
          this.state.setMeta('activeAccount', name);
          this.applyActiveAccount();
          return this.send(chatId, `✅ اکانت فعال: \`${name}\`\n${await this.statusText(userId)}`, { reply_markup: { inline_keyboard: this.statusKeyboard() } });
        }
        if (sub === 'add') {
          const msg = name ? `افزودن اکانت «${name}» — روش را انتخاب کن:` : '➕ *افزودن اکانت*\nروش را انتخاب کن (نام خودکار از ایمیل ساخته می‌شود):';
          return this.send(chatId, msg, { reply_markup: { inline_keyboard: this.accountMethodKeyboard(name) } });
        }
        if (sub === 'del') {
          try { this.accounts.remove(name); } catch (e) { return this.send(chatId, `❌ ${e.message}`); }
          if (this.activeAccountName() === name) { this.state.setMeta('activeAccount', 'default'); this.applyActiveAccount(); }
          return this.send(chatId, `🗑 اکانت \`${name}\` حذف شد.`, { reply_markup: { inline_keyboard: this.accountKeyboard() } });
        }
        return this.send(chatId, 'استفاده: /account | /account use <n> | /account add <n> | /account del <n>');
      }

      case '/models':
        return this.send(chatId, [
          '🤖 *مدل‌های رایگان قابل انتخاب*',
          ...freeModels().map((m) => m === this.settings.getModel() ? `👉 \`${m}\`` : `• \`${m}\``),
          '',
          'با /model provider/model سوییچ کن.',
          '⚠️ سرور ممکن است بعضی مدل‌ها را موقتاً «در دسترس نبودن» برگرداند.',
        ].join('\n'));

      case '/ads': {
        if (arg !== 'on' && arg !== 'off') return this.send(chatId, 'استفاده: /ads on|off');
        this.settings.setAds(arg === 'on');
        return this.send(chatId, `✅ تبلیغات ${arg === 'on' ? 'روشن' : 'خاموش'} شد`);
      }

      case '/new': {
        const name = arg || `chat-${Object.keys(u.sessions).length + 1}`;
        this.state.ensureSession(userId, name);
        return this.send(chatId, `✅ سشن \`${name}\` ساخته شد و فعال شد`);
      }

      case '/sessions': {
        const names = this.state.listSessions(userId);
        if (!names.length) return this.send(chatId, 'هیچ سشنی نیست. /new بزن.');
        return this.send(chatId, names.map((n) => `${n === u.activeSession ? '👉' : '•'} ${n} (${this.state.getSession(userId, n).messages.length} پیام)`).join('\n'));
      }

      case '/switch': {
        if (!arg || !this.state.getSession(userId, arg)) return this.send(chatId, 'سشن پیدا نشد. /sessions را ببین.');
        u.activeSession = arg;
        this.state.save();
        return this.send(chatId, `✅ سوییچ شد به \`${arg}\``);
      }

      case '/del': {
        if (!arg || !this.state.getSession(userId, arg)) return this.send(chatId, 'سشن پیدا نشد.');
        this.state.deleteSession(userId, arg);
        return this.send(chatId, `🗑 سشن \`${arg}\` حذف شد`);
      }

      case '/clear': {
        if (!u.activeSession) return this.send(chatId, 'سشن فعالی نیست.');
        this.state.clearMessages(userId, u.activeSession);
        return this.send(chatId, '🧹 تاریخچه سشن فعال پاک شد');
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
    if (left == null) return '⏳ سشن بسته — ▶️ استارت';
    return `⏳ سشن: ${humanMs(left)}`;
  }

  homeKeyboard(u) {
    return [
      [
        btn(`💬 سشن‌ها (${u.activeSession ?? '—'})`, 'menu:sessions', 'primary'),
        btn('⚙️ تنظیمات', 'menu:settings', 'primary'),
        btn(`👤 ${this.activeAccountName()}`, 'menu:account', 'primary'),
      ],
      [btn('➕ سشن جدید', 'menu:new', 'success'), btn('🧹 پاک‌کردن تاریخچه', 'menu:clear', 'danger')],
      [btn('🖥 سرور', 'menu:server', 'primary'), btn('❓ راهنما', 'menu:help')],
      [btn(this.timerButtonText(), 'menu:timer', 'primary')],
    ];
  }

  helpKeyboard() {
    return [
      [btn('💵 سهمیه و Freebucks', 'help:quota', 'primary')],
      [btn('⏳ سشن و تایمر', 'help:session', 'primary')],
      [btn('🤖 مدل‌ها', 'help:model', 'primary')],
      [btn('👤 اکانت‌ها', 'help:account', 'primary')],
      [btn('💬 چت و سشن‌ها', 'help:chat', 'primary')],
      [btn('🖥 سرور', 'help:server', 'primary')],
      [btn('🏠 منوی اصلی', 'menu:home')],
    ];
  }

  helpText() {
    return '❓ *راهنما*\nیک بخش را انتخاب کن تا توضیحش همین‌جا بیاید.';
  }

  helpSectionText(section) {
    const sections = {
      quota: [
        '💵 *سهمیه و Freebucks*',
        '',
        'فری‌باف هر روز یک بودجهٔ «Freebucks» می‌دهد که بین همهٔ مدل‌ها مشترک است.',
        '• هر سشن، هنگام شروع، معادل قیمت ساعتی مدل از Freebucks کم می‌کند (یک‌بار، نه هر پیام).',
        '• قیمت‌ها (Freebucks برای هر ساعت): GLM 5.3 Flash=۵ · Kimi=۵ · MiMo=۱۰ · Solar=۱۰ · DeepSeek V4 Flash=۱۵ · Luna=۲۰ · Gemini 3.8=۵۰',
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
        '• دکمهٔ «⏳ سشن» در پایین منو زمان باقی‌مانده را نشان می‌دهد.',
        '• ۵ دقیقه قبل از انقضا هشدار می‌آید (با «⏰ هشدار انقضا» در تنظیمات قابل تغییر).',
        '• «🔄 تمدید سشن» تایمر را از نو می‌کند؛ «▶️ شروع» منوی اصلی را باز می‌کند.',
        '• پیام بعدی هم خودکار سشن تازه می‌سازد؛ پس وقفه‌ای حس نمی‌کنی.',
      ].join('\n'),
      model: [
        '🤖 *مدل‌ها*',
        '',
        'از «🤖 مدل» مدل را عوض کن؛ agent هماهنگ خودکار انتخاب می‌شود.',
        '• ارزان‌ترین (۵ FB/ساعت): GLM 5.3 Flash · Kimi',
        '• متوسط (۱۰): MiMo 2.5 · Solar Pro 4',
        '• گران‌تر: DeepSeek V4 Flash (۱۵) · Luna (۲۰) · Gemini 3.8 (۵۰)',
        '',
        'سوییچ مدل، سشن فعلی را می‌بندد و سشن جدید می‌سازد.',
      ].join('\n'),
      account: [
        '👤 *اکانت‌ها*',
        '',
        'برای استفادهٔ شریکی؛ هرکس اکانت خودش.',
        '«➕ افزودن اکانت» را بزن و یکی را انتخاب کن:',
        '• «🌐 ورود با وب» — لینک لاگین می‌دهد؛ در سایت فری‌باف لاگین کن، اکانت خودکار اضافه می‌شود.',
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
        '• «🎛 مود» — حالت اجرای فری‌باف (DEFAULT/AGENT/PLAN/PRINT)',
        '• «📢 تبلیغات» — روشن/خاموش',
        '• «🤖 مدل» — مدل فعال',
        '• «⏰ هشدار انقضا» — چند دقیقه قبل هشدار بدهد (خاموش/۲/۵/۱۰)',
      ].join('\n'),
    };
    return sections[section] || this.helpText();
  }

  settingsText() {
    const warn = this.warnMin > 0 ? `${this.warnMin} دقیقه قبل از انقضا` : 'خاموش';
    return [
      '⚙️ *تنظیمات*',
      `🎛 مود: \`${this.settings.getMode()}\``,
      `📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`,
      `🤖 مدل: \`${this.settings.getModel()}\``,
      `👤 اکانت فعال: \`${this.activeAccountName()}\``,
      `⏰ هشدار انقضای سشن: ${warn}`,
    ].join('\n');
  }

  settingsKeyboard() {
    const warn = this.warnMin;
    const mark = (n) => (warn === n ? '✅ ' : '');
    const warnBtn = (n, label) => btn(`${mark(n)}${label}`, `warn:${n}`, warn === n ? 'success' : undefined);
    return [
      [
        btn(`🎛 مود: ${this.settings.getMode()}`, 'menu:mode', 'primary'),
        btn(`📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`, 'menu:ads', this.settings.getAds() ? 'success' : 'danger'),
      ],
      [btn(`🤖 مدل: ${this.settings.getModel()}`, 'menu:model', 'primary')],
      [btn(`👤 اکانت: ${this.activeAccountName()}`, 'menu:account', 'primary')],
      [warnBtn(0, 'خاموش'), warnBtn(2, '۲د'), warnBtn(5, '۵د'), warnBtn(10, '۱۰د')],
      [btn('🔄 تمدید سشن', 'menu:renew', 'success')],
      [btn('🏠 منوی اصلی', 'menu:home')],
    ];
  }

  homeText(u) {
    const left = this.chat.remainingMs();
    const clock = left == null ? '' : `\n⏳ سشن فری‌باف: ${humanMs(left)} دیگر`;
    return `🛡️ *نگهبان فری‌باف*\n\nمدل: \`${this.settings.getModel()}\`\nسشن فعال: \`${u.activeSession ?? '—'}\`${clock}\n\nاز دکمه‌ها استفاده کن یا مثل قبل پیام بفرست تا چت کند.`;
  }

  modelKeyboard() {
    const cur = this.settings.getModel();
    const prices = this.chat.lastQuota?.freebucks?.prices ?? {};
    const rows = freeModels().map((m) => [
      btn(`${m === cur ? '✅ ' : ''}${m}${prices[m] != null ? `  (${prices[m]} FB)` : ''}`, `model:${m}`, m === cur ? 'success' : 'primary'),
    ]);
    rows.push([btn('↩️ تنظیمات', 'menu:settings'), btn('🏠 منوی اصلی', 'menu:home')]);
    return rows;
  }

  modeKeyboard() {
    const cur = this.settings.getMode();
    const modes = ['DEFAULT', 'AGENT', 'PLAN', 'PRINT'];
    const rows = [];
    for (let i = 0; i < modes.length; i += 2) {
      rows.push(modes.slice(i, i + 2).map((m) => btn(`${m === cur ? '✅ ' : ''}${m}`, `mode:${m}`, m === cur ? 'success' : 'primary')));
    }
    rows.push([btn('↩️ تنظیمات', 'menu:settings'), btn('🏠 منوی اصلی', 'menu:home')]);
    return rows;
  }

  adsKeyboard() {
    const on = this.settings.getAds();
    return [
      [btn(`${on ? '✅ ' : ''}روشن`, 'ads:on', 'success'), btn(`${!on ? '✅ ' : ''}خاموش`, 'ads:off', 'danger')],
      [btn('↩️ تنظیمات', 'menu:settings'), btn('🏠 منوی اصلی', 'menu:home')],
    ];
  }

  sessionsKeyboard(userId) {
    const u = this.state.user(userId);
    const rows = this.state.listSessions(userId).map((n) => [
      btn(`${n === u.activeSession ? '✅ ' : ''}${n}`, `ses:${encodeURIComponent(n)}`, n === u.activeSession ? 'success' : 'primary'),
      btn('🗑', `delq:${encodeURIComponent(n)}`, 'danger'),
    ]);
    rows.push([btn('➕ سشن جدید', 'menu:new', 'success')]);
    rows.push([btn('🏠 منوی اصلی', 'menu:home')]);
    return rows;
  }

  sessionsText(userId) {
    const names = this.state.listSessions(userId);
    if (!names.length) return 'هیچ سشنی نیست. ➕ بزن.';
    const u = this.state.user(userId);
    return '💬 *سشن‌ها*\n' + names
      .map((n) => `${n === u.activeSession ? '👉' : '•'} \`${n}\` (${this.state.getSession(userId, n).messages.length} پیام)`)
      .join('\n');
  }

  serverKeyboard() {
    return [
      [btn('🔄 تمدید سشن', 'menu:renew', 'success')],
      [btn('📈 پروسه‌ها', 'svc:ps', 'primary')],
      [btn('♻️ ری‌استارت freebuff', 'fb:restart', 'success'), btn('⏹ توقف CLI', 'fb:stop', 'danger')],
      [btn('🔐 وضعیت instance', 'menu:instances', 'primary'), btn('🔓 آزادسازی قفل', 'svc:unlock', 'danger')],
      [btn('🏠 منوی اصلی', 'menu:home')],
    ];
  }

  statusKeyboard() {
    return [
      [btn('🔄 تمدید سشن', 'menu:renew', 'success'), btn('🏠 منوی اصلی', 'menu:home')],
    ];
  }

  async statusText(userId) {
    this.applyActiveAccount();
    const os = await import('node:os');
    const load = os.loadavg().map((n) => n.toFixed(2)).join(' / ');
    const mem = `RAM: ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB پروسه / ${(os.totalmem() - os.freemem()) / 1e9 | 0}GB/${os.totalmem() / 1e9 | 0}GB سرور`;
    const up = `Uptime ربات: ${(process.uptime() / 3600).toFixed(1)}h`;
    const fbSession = this.instances.isInteractiveActive() ? 'CLI تعاملی فعال است ⚠️' : 'CLI تعاملی غیرفعال';
    const sess = await this.chat.activeSession().catch(() => null);
    const left = this.chat.remainingMs();
    const lines = [
      `📊 *وضعیت*`,
      `🖥 Load: ${load} | ${mem}`,
      `⏱ ${up}`,
      `🤖 مدل: \`${this.settings.getModel()}\``,
      sess ? `🔓 سشن سرور: \`${sess.model}\` — ⏳ ${humanMs(left)} دیگر` : '🔓 سشن سرور: — (پیام بعدی سشن تازه می‌سازد)',
      `🎛 مود: ${this.settings.getMode()}`,
      `📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`,
      `🔐 ${fbSession}`,
      `💬 سشن فعال: ${this.state.user(userId).activeSession ?? '—'}`,
    ];
    const quota = sess ?? this.chat.lastQuota;
    if (!sess && quota) lines.push('♻️ سهمیهٔ زیر آخرین مقدار ثبت‌شده است');
    lines.push(...quotaLines(quota));
    return lines.join('\n');
  }

  /** بستن سشن فعلی و ساخت سشن تازه (ریست تایمر ۱ ساعته) */
  async doRenew(chatId, messageId) {
    this.applyActiveAccount();
    const sess = await this.chat.activeSession().catch(() => null);
    const model = sess?.model || this.settings.getModel();
    try {
      await this.chat.renewSession(model);
      return this.render(chatId, messageId, `✅ سشن \`${model}\` تمدید شد — ⏳ ${humanMs(this.chat.remainingMs())} دیگر`, this.statusKeyboard());
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
    const text = `⏳ سشن فری‌باف ${humanMs(left)} دیگر بسته می‌شود.\nبرای تمدید /renew بزن، یا پیام بعدی خودکار سشن تازه می‌سازد.`;
    const kb = { reply_markup: { inline_keyboard: [[{ text: '🔄 تمدید سشن', callback_data: 'menu:renew' }]] } };
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
              await answer('سشن فعال است');
            }
            return this.render(chatId, messageId, await this.statusText(userId), this.statusKeyboard());
          }
          case 'model': return this.render(chatId, messageId, `🤖 *مدل‌های رایگان*\nفعلی: \`${this.settings.getModel()}\`\nبرای سوییچ روی مدل بزن.`, this.modelKeyboard());
          case 'mode': return this.render(chatId, messageId, `🎛 *مود* (فعلی: \`${this.settings.getMode()}\`)`, this.modeKeyboard());
          case 'ads': return this.render(chatId, messageId, '📢 *تبلیغات*', this.adsKeyboard());
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
            await answer('تاریخچه پاک شد');
            return home();
          }
          case 'instances': return this.render(chatId, messageId, this.instances.statusText(), [[{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]]);
          case 'server': return this.render(chatId, messageId, '🖥 *مدیریت سرور*', this.serverKeyboard());
          case 'help': return this.render(chatId, messageId, this.helpText(), this.helpKeyboard());
          default: return home();
        }

      case 'model': {
        await answer('⏳ در حال سوییچ…');
        try {
          const session = await this.chat.switchSessionModel(value);
          this.settings.setModel(value);
          const left = session.remainingMs ? ` — ${Math.round(session.remainingMs / 60000)} دقیقه` : '';
          await this.render(chatId, messageId, `✅ مدل روی \`${value}\` تنظیم شد${left}`, this.modelKeyboard());
        } catch (e) {
          await this.render(chatId, messageId, `❌ ${e.message}\n\nمدل فعلی: \`${this.settings.getModel()}\``, this.modelKeyboard());
        }
        return;
      }

      case 'mode': {
        try { this.settings.setMode(value); await answer(`مود روی ${value} تنظیم شد`); }
        catch (e) { await answer(e.message); }
        return this.render(chatId, messageId, `🎛 *مود* (فعلی: \`${this.settings.getMode()}\`)`, this.modeKeyboard());
      }

      case 'ads': {
        this.settings.setAds(value === 'on');
        await answer(`تبلیغات ${value === 'on' ? 'روشن' : 'خاموش'} شد`);
        return this.render(chatId, messageId, '📢 *تبلیغات*', this.adsKeyboard());
      }

      case 'acc': {
        if (value === 'add') {
          return this.render(chatId, messageId, '➕ *افزودن اکانت*\nروش را انتخاب کن (نام خودکار از ایمیل ساخته می‌شود):', this.accountMethodKeyboard());
        }
        if (!this.accounts.has(value)) {
          await answer('اکانت پیدا نشد');
          return this.render(chatId, messageId, await this.accountText(), this.accountKeyboard());
        }
        this.state.setMeta('activeAccount', value);
        this.applyActiveAccount();
        await answer(`اکانت فعال: ${value}`);
        return this.render(chatId, messageId, await this.statusText(userId), this.statusKeyboard());
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
        if (!this.state.getSession(userId, name)) { await answer('سشن پیدا نشد'); return home(); }
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
        await answer('حذف شد');
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
            return this.render(chatId, messageId, '🖥 *مدیریت سرور*', this.serverKeyboard());
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
    return this.send(chatId, `افزودن اکانت «${name}» — روش را انتخاب کن:`, { reply_markup: { inline_keyboard: this.accountMethodKeyboard(name) } });
  }

  /** دریافت JSON اکانت پس از /account add */
  async handleAccountJson(chatId, userId, text) {
    const preferred = this.pendingAdd.get(userId) || null;
    this.pendingAdd.delete(userId);
    let raw;
    try {
      raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      return this.send(chatId, '❌ JSON نامعتبر بود. دوباره «➕ افزودن اکانت» را بزن.');
    }
    try {
      const name = this.nextAccountName(preferred, raw?.default ?? raw);
      const acc = this.accounts.add(name, raw);
      return this.send(chatId, `✅ اکانت \`${acc.name}\` اضافه شد. برای فعال‌کردن روی آن بزن.`, { reply_markup: { inline_keyboard: this.accountKeyboard() } });
    } catch (e) {
      return this.send(chatId, `❌ ${e.message}`);
    }
  }

  // ---------- چت ----------
  async onChat(msg, chatId, userId, text) {
    if (this.pendingName.has(userId)) return this.handleNameInput(chatId, userId, text);
    if (this.pendingAdd.has(userId)) return this.handleAccountJson(chatId, userId, text);
    if (this.busy.has(userId)) {
      return this.send(chatId, '⏳ هنوز پاسخ قبلی در جریان است…');
    }
    this.applyActiveAccount();
    if (!this.activeAccount()?.authToken) {
      return this.send(chatId, '❌ credentials فری‌باف پیدا نشد. اول در سرور freebuff login کن.');
    }

    const u = this.state.user(userId);
    const name = u.activeSession || this.state.ensureSession(userId, 'chat-1');
    const session = this.state.getSession(userId, name);

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
        ? answer.slice(0, this.cfg.maxAnswerChars) + '\n…(بریده شد)'
        : answer || '(پاسخ خالی)';
      await this.bot.editMessageText(out, { chat_id: chatId, message_id: progress.message_id });
    } catch (e) {
      log.error('چت ناموفق:', e);
      let hint = e.message;
      if (e.message.includes('409') || e.message.toLowerCase().includes('conflict')) {
        hint = 'تداخل با سشن تعاملی فری‌باف (409). یا CLI تعاملی را ببند، یا از /instances وضعیت را ببین.';
      }
      await this.bot.editMessageText(`❌ ${hint.slice(0, 500)}`, { chat_id: chatId, message_id: progress.message_id }).catch(() => {});
    } finally {
      this.busy.delete(userId);
    }
  }
}
