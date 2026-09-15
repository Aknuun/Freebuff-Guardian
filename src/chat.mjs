// chat.mjs — موتور چت با بک‌اند فری‌باف
//
// یافته‌های سشن قبلی (reverse-engineering باینری و SDK):
//  • POST /api/v1/agent-runs      {action:'START', agentId, ancestorRunIds:[]} → {runId}
//  • POST /api/v1/chat/completions با بدنه‌ی OpenAI-compatible؛ متادیتا به‌صورت
//    کلید سطح بالای codebuff_metadata: { run_id, cost_mode:'free', agent_id, freebuff_instance_id }
//  • هدر Authorization: Bearer <authToken از credentials.json>
//  • cost_mode: 'free' → مدل رایگان z-ai/glm-5.3-flash بدون کسر اعتبار
//  • POST /api/v1/agent-runs {action:'FINISH', runId, ...} برای بستن run
//  • GET  /api/v1/freebuff/session            → سشن فعال + instanceId
//  • POST /api/v1/freebuff/session/admission  → ساخت سشن (هدر x-freebuff-model)
//
// نکته‌های حیاتی (کشف‌شده از ترافیک CLI):
//  1) سرور مود رایگان را فقط وقتی می‌پذیرد که پیام system با جمله‌ی
//     FREE_MODE_SYSTEM_PREFIX شروع شود؛ وگرنه free_mode_cli_required.
//  2) freebuff_instance_id باید همان instanceId سشن admitted باشد؛ وگرنه
//     409 session_superseded. برای همین اول سشن را می‌خوانیم/می‌سازیم.
//  3) agent باید با مدل هماهنگ باشد؛ وگرنه free_mode_invalid_agent_model.

import { makeLogger } from './logger.mjs';
import { freeAgentForModel } from './config.mjs';

const log = makeLogger('chat');

// مود رایگان سمت سرور فقط وقتی پذیرفته می‌شود که پیام system با این جمله شروع
// شود؛ در غیر این صورت خطای free_mode_cli_required برمی‌گردد. دستورهای خودمان
// بعد از این جمله می‌آیند.
const FREE_MODE_SYSTEM_PREFIX = 'You are Buffy, the coding agent behind Codebuff.';

/** اگر پیام system با پیشوند لازم شروع نشده باشد، آن را اضافه می‌کند */
function withCliSystemPrompt(messages) {
  const idx = messages.findIndex((m) => m.role === 'system');
  if (idx === -1) {
    return [{ role: 'system', content: FREE_MODE_SYSTEM_PREFIX }, ...messages];
  }
  const msg = messages[idx];
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.startsWith(FREE_MODE_SYSTEM_PREFIX)) return messages;
  const next = [...messages];
  next[idx] = { ...msg, content: `${FREE_MODE_SYSTEM_PREFIX} ${content}`.trim() };
  return next;
}

export class FreebuffChat {
  constructor({ authToken, websiteUrl, agent, instanceManager }) {
    this.authToken = authToken;
    this.websiteUrl = websiteUrl.replace(/\/$/, '');
    this.agent = agent;
    this.instances = instanceManager;
    this.lastSession = null; // آخرین سشن شناخته‌شده برای محاسبه‌ی زنده‌ی انقضا
    this.lastQuota = null; // آخرین سهمیه‌ی دیده‌شده (وقتی سشن بسته است هم نمایش داده می‌شود)
    this.accountName = null; // نام اکانت فعال (چند-اکانتی)
  }

  /** تغییر اکانت فعال؛ چون سشن/سهمیه per-account است، کش پاک می‌شود */
  useAccount(account) {
    if (!account?.authToken) return false;
    if (this.accountName === account.name) return false;
    this.accountName = account.name;
    this.authToken = account.authToken;
    this.fingerprintId = account.fingerprintId ?? null;
    this.lastSession = null;
    this.lastQuota = null;
    log.info('اکانت فعال تغییر کرد:', account.name);
    return true;
  }

  /** ذخیره‌ی سهمیه‌ی سشن برای نمایش حتی بعد از بسته‌شدن سشن */
  cacheQuota(session) {
    if (session?.freeWindows || session?.freebucks) {
      this.lastQuota = { freeWindows: session.freeWindows, freebucks: session.freebucks, at: Date.now() };
    }
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
      'user-agent': 'ai-sdk/openai-compatible/1.0.0/codebuff',
      ...extra,
    };
  }

  /** سشن فعال فری‌باف (instanceId معتبر) یا null */
  async activeSession() {
    const res = await fetch(`${this.websiteUrl}/api/v1/freebuff/session`, { headers: this.headers() });
    if (!res.ok) return null;
    const s = await res.json().catch(() => null);
    if (s?.status === 'active' && s.instanceId) {
      this.lastSession = s;
      this.cacheQuota(s);
      return s;
    }
    this.lastSession = null;
    return null;
  }

  /**
   * زمان باقی‌مانده‌ی سشن به میلی‌ثانیه (زنده، از expiresAt) یا null اگر
   * سشنی شناخته‌شده نباشد. TTL سمت سرور ثابت است و با چت تمدید نمی‌شود.
   */
  remainingMs() {
    if (!this.lastSession?.expiresAt) return null;
    return new Date(this.lastSession.expiresAt).getTime() - Date.now();
  }

  /** پایان سشن فعلی (برای آزادسازی مدل) */
  async endSession(instanceId) {
    const res = await fetch(`${this.websiteUrl}/api/v1/freebuff/session`, {
      method: 'DELETE',
      headers: this.headers({ 'x-freebuff-instance-id': instanceId }),
    });
    if (!res.ok) log.warn('پایان سشن ناموفق:', res.status);
    return res.ok;
  }

  /** توضیح خوانا برای خطای admission */
  admissionError(data, status) {
    switch (data?.status) {
      case 'model_unavailable':
        return `مدل ${data.requestedModel} فعلاً برای اکانت تو در دسترس نیست${data.availableHours ? ` (پنجره‌ی دسترسی: ${data.availableHours})` : ''}`;
      case 'model_locked':
        return `سشن قبلی روی ${data.currentModel} قفل است؛ اول آن را ببند`;
      case 'consent_required':
        return `تأیید هزینه لازم است (${data.walletConsent?.walletSpend ?? '—'})`;
      case 'rate_limited':
      case 'spend_limited':
      case 'ip_capped':
        return `محدودیت سرور: ${data.status}`;
      default:
        return `admission ناموفق (${status}): ${JSON.stringify(data).slice(0, 200)}`;
    }
  }

  /** درخواست admission برای ساخت سشن جدید؛ شیء سشن را برمی‌گرداند */
  async admitSession(model) {
    const res = await fetch(`${this.websiteUrl}/api/v1/freebuff/session/admission`, {
      method: 'POST',
      headers: this.headers({ 'x-freebuff-model': model, 'x-freebuff-wallet-spend-limit': '0' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.instanceId) {
      const err = new Error(this.admissionError(data, res.status));
      err.code = data?.status;
      throw err;
    }
    this.lastSession = data;
    this.cacheQuota(data);
    return data;
  }

  /** بستن سشن فعلی و ساخت سشن تازه با همان مدل (ریست تایمر ۱ ساعته) */
  async renewSession(model) {
    const session = await this.activeSession();
    if (session) await this.endSession(session.instanceId);
    return this.admitSession(model || session?.model || this.agent);
  }

  /**
   * اطمینان از سشن با مدل خواسته‌شده: اگر سشن فعال مدل دیگری دارد، آن را
   * می‌بندد و با مدل جدید admission می‌زند (سرور فقط یک سشن هم‌زمان می‌دهد).
   */
  async switchSessionModel(model) {
    const session = await this.activeSession();
    if (session && session.model === model) return session;
    if (session) await this.endSession(session.instanceId);
    try {
      return await this.admitSession(model);
    } catch (e) {
      // بعد از admission ناموفق، سرور گاهی یک سشن fallback روی مدل پیش‌فرض
      // می‌سازد که مدل را قفل می‌کند؛ یک‌بار آن را می‌بندیم و دوباره تلاش می‌کنیم.
      if (e.code === 'model_locked') {
        const fallback = await this.activeSession();
        if (fallback) {
          await this.endSession(fallback.instanceId);
          return this.admitSession(model);
        }
      }
      throw e;
    }
  }

  /** سشن معتبر برای این چت؛ در نهایت اگر همه‌چیز شکست خورد instance محلی */
  async resolveSession(model) {
    let session = await this.activeSession();
    if (!session) {
      try {
        return await this.admitSession(model || this.agent);
      } catch (e) {
        log.warn('admission ناموفق؛ استفاده از instance محلی:', e.message);
        return { instanceId: this.instances.safeInstanceId().id, model };
      }
    }

    const left = this.remainingMs();
    if (left !== null && left <= 60_000) {
      // نزدیک انقضا؛ پیش از ارسال پیام تمدید می‌کنیم تا وسط درخواست قطع نشود.
      log.info('سشن نزدیک انقضا بود؛ تمدید شد');
      session = await this.renewSession(session.model).catch((e) => {
        log.warn('تمدید ناموفق؛ ادامه با سشن فعلی:', e.message);
        return session;
      });
    } else if (model && session.model !== model) {
      session = await this.switchSessionModel(model).catch((e) => {
        log.warn(`سوییچ به ${model} ناموفق؛ ادامه با ${session.model}:`, e.message);
        return session;
      });
    }
    return session;
  }

  /** شروع یک run جدید؛ runId برای متادیتای چت لازم است */
  async startRun(agentId = this.agent) {
    const res = await fetch(`${this.websiteUrl}/api/v1/agent-runs`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ action: 'START', agentId, ancestorRunIds: [] }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`START ناموفق (${res.status}): ${t.slice(0, 200)}`);
    }
    const { runId } = await res.json();
    return runId;
  }

  async finishRun(runId, status = 'completed', steps = 1) {
    try {
      await fetch(`${this.websiteUrl}/api/v1/agent-runs`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          action: 'FINISH',
          runId,
          status,
          totalSteps: steps,
          directCredits: 0,
          totalCredits: 0,
        }),
      });
    } catch (e) {
      log.warn('FINISH ناموفق (بی‌خطر):', e.message);
    }
  }

  /**
   * یک پیام بفرست و پاسخ مدل را بگیر (بدون streaming).
   * history: آرایه‌ی {role, content}
   */
  async complete({ model, messages, maxTokens = 2048, agent }) {
    if (!this.authToken) throw new Error('احراز هویت فری‌باف تنظیم نشده است');
    // سشن معتبر را بگیر (در صورت نیاز مدل را سوییچ می‌کند)؛ instanceId باید
    // همان سشن admitted باشد وگرنه 409 session_superseded.
    const session = await this.resolveSession(model);
    const useModel = session.model || model;
    // در مود رایگان، agent باید با مدل نهایی هماهنگ باشد؛ وگرنه
    // free_mode_invalid_agent_model برمی‌گردد.
    const agentId = agent || freeAgentForModel(useModel) || this.agent;

    const runId = await this.startRun(agentId);
    log.info('run شروع شد', runId, `instance=${session.instanceId}`, `agent=${agentId}`);

    const res = await fetch(`${this.websiteUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: useModel,
        messages: withCliSystemPrompt(messages),
        max_tokens: maxTokens,
        codebuff_metadata: {
          run_id: runId,
          cost_mode: 'free',
          agent_id: agentId,
          freebuff_instance_id: session.instanceId,
        },
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      await this.finishRun(runId, 'error');
      throw new Error(`چت ناموفق (${res.status}): ${text.slice(0, 300)}`);
    }

    let answer = '';
    try {
      const data = JSON.parse(text);
      answer = data.choices?.[0]?.message?.content ?? '';
      if (Array.isArray(answer)) {
        answer = answer.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
      }
    } catch {
      answer = text.slice(0, 2000);
    }

    await this.finishRun(runId);
    return answer.trim();
  }
}
