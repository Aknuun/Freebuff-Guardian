// accounts.mjs — پروفایل‌های اکانت فری‌باف (برای استفادهٔ شریکی/چندنفره)
//
// هر اکانت در یک فایل JSON داخل پوشهٔ accounts/ نگه داشته می‌شود (gitignored):
//   accounts/<name>.json = { name, authToken, fingerprintId, userId, email }
// اکانت «default» همان credentials خود سرور است که در config خوانده می‌شود.
import fs from 'node:fs';
import path from 'node:path';
import { makeLogger } from './logger.mjs';

const log = makeLogger('accounts');

const NAME_RE = /^[\w.-]{1,40}$/;

/** ورودی credentials (خام) را به شکل یکسان تبدیل می‌کند */
function normalize(raw) {
  const base = raw?.default ?? raw ?? {};
  return {
    authToken: base.authToken,
    fingerprintId: base.fingerprintId,
    userId: base.id ?? base.userId ?? null,
    email: base.email ?? null,
    label: base.name ?? null,
  };
}

export class AccountStore {
  constructor({ dir, defaults }) {
    this.dir = dir;
    this.defaults = defaults ?? null; // { authToken, fingerprintId, userId, email, label }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** لیست همهٔ اکانت‌ها؛ اول اکانت پیش‌فرض سرور */
  list() {
    const out = [];
    if (this.defaults?.authToken) {
      out.push({ name: 'default', label: this.defaults.label || 'default', source: 'server', ...this.defaults });
    }
    for (const f of fs.readdirSync(this.dir).sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const a = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (!a.authToken) continue;
        const name = a.name || f.replace(/\.json$/, '');
        out.push({ source: 'file', ...a, name, label: a.label || name });
      } catch (e) {
        log.warn(`اکانت نامعتبر ${f}:`, e.message);
      }
    }
    return out;
  }

  get(name) {
    return this.list().find((a) => a.name === name) ?? null;
  }

  has(name) {
    return !!this.get(name);
  }

  /** افزودن/به‌روزرسانی اکانت از یک credentials خام */
  add(name, raw) {
    if (!NAME_RE.test(name)) throw new Error('نام اکانت نامعتبر است (حروف/عدد/.-_ تا ۴۰ کاراکتر)');
    if (name === 'default') throw new Error('نام default رزرو است');
    const c = normalize(raw);
    if (!c.authToken) throw new Error('authToken در این فایل پیدا نشد');
    const file = path.join(this.dir, `${name}.json`);
    const data = { name, label: c.label || name, authToken: c.authToken, fingerprintId: c.fingerprintId, userId: c.userId, email: c.email };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    log.info(`اکانت اضافه شد: ${name}`);
    return this.get(name);
  }

  remove(name) {
    if (name === 'default') throw new Error('اکانت default قابل حذف نیست');
    const file = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(file)) throw new Error('اکانت پیدا نشد');
    fs.unlinkSync(file);
    return true;
  }
}
