// backup.mjs — بکاپ و ریستور اکانت‌های فری‌باف به‌صورت یک فایل JSON
//
// خروجی شامل همهٔ فایل‌های accounts/*.json و همچنین credentials اکانت default
// است تا بتوان همهٔ اکانت‌ها را با یک فایل بازگرداند.
import fs from 'node:fs';
import path from 'node:path';
import { makeLogger } from './logger.mjs';

const log = makeLogger('backup');

const NAME_RE = /^[\w.-]{1,40}$/;
const KIND = 'freebuff-guardian-accounts';

export class AccountBackup {
  constructor({ accountsDir, credPath, backupDir }) {
    this.accountsDir = accountsDir;
    this.credPath = credPath;
    this.backupDir = backupDir;
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
  }

  /** ساخت فایل بکاپ؛ { file, name, count, hasDefault } برمی‌گرداند */
  create() {
    const accounts = {};
    if (fs.existsSync(this.accountsDir)) {
      for (const f of fs.readdirSync(this.accountsDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.accountsDir, f), 'utf8'));
          const name = data.name || f.replace(/\.json$/, '');
          if (!data.authToken || !NAME_RE.test(name) || name === 'default') continue;
          accounts[name] = {
            name,
            label: data.label || name,
            authToken: data.authToken,
            fingerprintId: data.fingerprintId,
            userId: data.userId ?? null,
            email: data.email ?? null,
          };
        } catch (e) {
          log.warn(`اکانت نامعتبر ${f}:`, e.message);
        }
      }
    }

    let def = null;
    try {
      if (this.credPath && fs.existsSync(this.credPath)) def = JSON.parse(fs.readFileSync(this.credPath, 'utf8'));
    } catch (e) {
      log.warn('credentials برای بکاپ خوانده نشد:', e.message);
    }

    const payload = {
      kind: KIND,
      version: 1,
      createdAt: new Date().toISOString(),
      accounts,
      default: def,
    };
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const file = path.join(this.backupDir, `freebuff-accounts-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return { file, name: path.basename(file), count: Object.keys(accounts).length, hasDefault: !!def };
  }

  parse(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    if (!data || data.kind !== KIND || typeof data.accounts !== 'object' || data.accounts === null) {
      throw new Error('این فایل، بکاپ معتبر اکانت‌های نگهبان نیست');
    }
    return data;
  }

  /** ریستور از متن/شیء بکاپ؛ تعداد افزوده/به‌روز و اطلاعات default را برمی‌گرداند */
  restore(text) {
    const data = this.parse(text);
    fs.mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
    let added = 0;
    let updated = 0;
    for (const [name, a] of Object.entries(data.accounts)) {
      if (!NAME_RE.test(name) || name === 'default' || !a?.authToken) {
        log.warn('اکانت نامعتبر در بکاپ رد شد:', name);
        continue;
      }
      const file = path.join(this.accountsDir, `${name}.json`);
      const existed = fs.existsSync(file);
      const out = {
        name,
        label: a.label || name,
        authToken: a.authToken,
        fingerprintId: a.fingerprintId,
        userId: a.userId ?? null,
        email: a.email ?? null,
      };
      fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
      if (existed) updated++;
      else added++;
    }

    let defaultCreds = null;
    const def = data.default?.default ?? data.default;
    if (def?.authToken && this.credPath) {
      fs.mkdirSync(path.dirname(this.credPath), { recursive: true, mode: 0o700 });
      let wrapper = { default: def };
      try {
        const cur = JSON.parse(fs.readFileSync(this.credPath, 'utf8'));
        if (cur && typeof cur === 'object' && cur.default) wrapper = { ...cur, default: { ...cur.default, ...def } };
      } catch { /* فایل فعلی نبود؛ همان بکاپ را با ساختار default می‌نویسیم */ }
      fs.writeFileSync(this.credPath, JSON.stringify(wrapper, null, 2));
      defaultCreds = def;
    }
    return { added, updated, defaultCreds, total: added + updated };
  }
}
