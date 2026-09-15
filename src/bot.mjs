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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execp = promisify(exec);
const log = makeLogger('bot');

/** نمایش خوانای مدت‌زمان میلی‌ثانیه‌ای */
function humanMs(ms) {
  if (ms == null) return '—';
  const total = Math.max(0, Math.round(ms / 60000));
  if (total < 1) return 'کمتر از ۱ دقیقه';
  if (total < 60) return `${total} دقیقه`;
  return `${Math.floor(total / 60)} ساعت و ${total % 60} دقیقه`;
}

const HELP = `🛡️ *نگهبان فری‌باف*

مدیریت کامل فری‌باف از تلگرام — بدون SSH.
/menu — منوی دکمه‌ای (ساده‌ترین راه)

*تنظیمات فری‌باف*
/status — وضعیت کلی (با تایمر سشن)
/renew — تمدید سشن (ریست تایمر ۱ ساعته)
/settings — نمایش تنظیمات
/mode DEFAULT\\|AGENT\\|PLAN\\|PRINT
/model — دیدن مدل فعلی
/model provider/model — تغییر مدل (سشن را سوییچ می‌کند)
/models — لیست مدل‌های رایگان
/ads on\\|off — تبلیغات

*چت با فری‌باف*
/new نام — سشن جدید
/sessions — لیست سشن‌ها
/switch نام — سوییچ
/del نام — حذف
/clear — پاک‌کردن تاریخچه
متن ساده بفرست تا با مدل رایگان چت کند.

*مدیریت سرور*
/ps — پروسه‌های کلیدی
/restart نام‌سرویس — ری‌استارت systemd
/freebuff restart\\|stop\\|start
/instances — وضعیت قفل و instance
/unlock — آزادسازی قفل گیرکرده`;

export class GuardianBot {
  constructor(cfg, state, instances) {
    this.cfg = cfg;
    this.state = state;
    this.instances = instances;
    this.settings = new FreebuffSettings();
    this.chat = new FreebuffChat({
      authToken: cfg.fbAuthToken,
      websiteUrl: cfg.websiteUrl,
      agent: cfg.fbAgent,
      instanceManager: instances,
    });
    this.busy = new Set(); // userId هایی که درخواست پردازشی در جریان دارند
    this.sessionWarned = false;
    this.lastProbe = 0;

    // هشدار پیش از انقضای سشن (هر دقیقه بررسی؛ فقط یک‌بار در هر سشن)
    const warnMin = parseInt(process.env.SESSION_WARN_MIN || '5', 10);
    if (warnMin > 0) {
      this.warnTimer = setInterval(() => this.checkSessionWarn(warnMin).catch((e) => log.warn('sessionWarn:', e.message)), 60000);
      this.warnTimer.unref?.();
    }

    this.bot = new TelegramBot(cfg.telegramToken, { polling: true });
    this.bot.on('message', (msg) => this.onMessage(msg).catch((e) => log.error('onMessage:', e)));
    this.bot.on('callback_query', (q) => this.onCallback(q).catch((e) => log.error('onCallback:', e)));
    this.bot.on('polling_error', (e) => log.warn('polling:', e.message));

    log.info('ربات نگهبان فری‌باف آماده است');
  }

  allowed(id) { return this.cfg.allowedUserIds.includes(id); }

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
        return this.render(chatId, null, this.homeText(u), this.homeKeyboard(u));

      case '/help':
        return this.send(chatId, HELP, { reply_markup: { inline_keyboard: [[{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]] } });

      case '/status':
        return this.send(chatId, await this.statusText(userId), { reply_markup: { inline_keyboard: this.statusKeyboard() } });

      case '/renew':
        return this.doRenew(chatId, null);

      case '/settings':
        return this.send(chatId, this.settings.summary());

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

  homeKeyboard(u) {
    return [
      [{ text: '📊 وضعیت', callback_data: 'menu:status' }, { text: '⚙️ تنظیمات', callback_data: 'menu:settings' }],
      [{ text: `🤖 مدل: ${this.settings.getModel()}`, callback_data: 'menu:model' }],
      [
        { text: `🎛 مود: ${this.settings.getMode()}`, callback_data: 'menu:mode' },
        { text: `📢 تبلیغات: ${this.settings.getAds() ? 'روشن' : 'خاموش'}`, callback_data: 'menu:ads' },
      ],
      [{ text: `💬 سشن‌ها (فعال: ${u.activeSession ?? '—'})`, callback_data: 'menu:sessions' }],
      [{ text: '➕ سشن جدید', callback_data: 'menu:new' }, { text: '🧹 پاک‌کردن تاریخچه', callback_data: 'menu:clear' }],
      [{ text: '🖥 سرور', callback_data: 'menu:server' }, { text: '❓ راهنما', callback_data: 'menu:help' }],
    ];
  }

  homeText(u) {
    const left = this.chat.remainingMs();
    const clock = left == null ? '' : `\n⏳ سشن فری‌باف: ${humanMs(left)} دیگر`;
    return `🛡️ *نگهبان فری‌باف*\n\nمدل: \`${this.settings.getModel()}\`\nسشن فعال: \`${u.activeSession ?? '—'}\`${clock}\n\nاز دکمه‌ها استفاده کن یا مثل قبل پیام بفرست تا چت کند.`;
  }

  modelKeyboard() {
    const cur = this.settings.getModel();
    const rows = freeModels().map((m) => [{ text: `${m === cur ? '✅ ' : ''}${m}`, callback_data: `model:${m}` }]);
    rows.push([{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]);
    return rows;
  }

  modeKeyboard() {
    const cur = this.settings.getMode();
    const modes = ['DEFAULT', 'AGENT', 'PLAN', 'PRINT'];
    const rows = [];
    for (let i = 0; i < modes.length; i += 2) {
      rows.push(modes.slice(i, i + 2).map((m) => ({ text: `${m === cur ? '✅ ' : ''}${m}`, callback_data: `mode:${m}` })));
    }
    rows.push([{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]);
    return rows;
  }

  adsKeyboard() {
    const on = this.settings.getAds();
    return [
      [{ text: `${on ? '✅ ' : ''}روشن`, callback_data: 'ads:on' }, { text: `${!on ? '✅ ' : ''}خاموش`, callback_data: 'ads:off' }],
      [{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }],
    ];
  }

  sessionsKeyboard(userId) {
    const u = this.state.user(userId);
    const rows = this.state.listSessions(userId).map((n) => [
      { text: `${n === u.activeSession ? '✅ ' : ''}${n}`, callback_data: `ses:${encodeURIComponent(n)}` },
      { text: '🗑', callback_data: `delq:${encodeURIComponent(n)}` },
    ]);
    rows.push([{ text: '➕ سشن جدید', callback_data: 'menu:new' }]);
    rows.push([{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]);
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
      [{ text: '🔄 تمدید سشن', callback_data: 'menu:renew' }],
      [{ text: '📈 پروسه‌ها', callback_data: 'svc:ps' }],
      [{ text: '♻️ ری‌استارت freebuff', callback_data: 'fb:restart' }, { text: '⏹ توقف CLI', callback_data: 'fb:stop' }],
      [{ text: '🔐 وضعیت instance', callback_data: 'menu:instances' }, { text: '🔓 آزادسازی قفل', callback_data: 'svc:unlock' }],
      [{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }],
    ];
  }

  statusKeyboard() {
    return [
      [{ text: '🔄 تمدید سشن', callback_data: 'menu:renew' }, { text: '🏠 منوی اصلی', callback_data: 'menu:home' }],
    ];
  }

  async statusText(userId) {
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
    if (sess?.freeWindows) {
      const w = sess.freeWindows;
      lines.push(`🎟 سشن رایگان — امروز: ${w.dayUsed}/${w.dayLimit} | هفته: ${w.weekUsed}/${w.weekLimit} | ماه: ${w.monthUsed}/${w.monthLimit}`);
    }
    if (sess?.freebucks?.daily) {
      const d = sess.freebucks.daily;
      lines.push(`💵 Freebucks امروز: ${d.remaining}/${d.limit}`);
    }
    return lines.join('\n');
  }

  /** بستن سشن فعلی و ساخت سشن تازه (ریست تایمر ۱ ساعته) */
  async doRenew(chatId, messageId) {
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
  async checkSessionWarn(warnMin) {
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
          case 'status': return this.render(chatId, messageId, await this.statusText(userId), this.statusKeyboard());
          case 'renew': return this.doRenew(chatId, messageId);
          case 'settings': return this.render(chatId, messageId, this.settings.summary(), [[{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]]);
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
          case 'help': return this.render(chatId, messageId, HELP, [[{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]]);
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
          [{ text: '🗑 بله، حذف کن', callback_data: `delc:${encodeURIComponent(name)}` }, { text: '↩️ انصراف', callback_data: 'menu:sessions' }],
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

  // ---------- چت ----------
  async onChat(msg, chatId, userId, text) {
    if (this.busy.has(userId)) {
      return this.send(chatId, '⏳ هنوز پاسخ قبلی در جریان است…');
    }
    if (!this.cfg.fbAuthToken) {
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
