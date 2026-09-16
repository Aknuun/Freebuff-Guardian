// settings.mjs — مدیریت تنظیمات فری‌باف (خواندن/نوشتن settings.json واقعی CLI)
// کاملاً همگام با همان فایلی که خود freebuff استفاده می‌کند:
//   /root/.config/manicode/settings.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeLogger } from './logger.mjs';

const log = makeLogger('settings');

export class FreebuffSettings {
  constructor(settingsPath) {
    this.path = settingsPath
      || process.env.FREEBUFF_SETTINGS_PATH
      || path.join(os.homedir(), '.config', 'manicode', 'settings.json');
    this.defaults = {
      mode: 'DEFAULT',
      adsEnabled: true,
      freebuffModel: 'z-ai/glm-5.3-flash',
      freebuffModelDefaultMigration: 'glm-5.3-flash-2026-09-05',
    };
  }

  read() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      return { ...this.defaults, ...JSON.parse(raw) };
    } catch {
      return { ...this.defaults };
    }
  }

  write(patch) {
    const current = this.read();
    const next = { ...current, ...patch };
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(next, null, 2) + '\n');
    log.info('settings.json به‌روزرسانی شد:', JSON.stringify(patch));
    return next;
  }

  // --- عملیات‌های سطح بالا ---
  getMode() { return this.read().mode; }
  setMode(mode) {
    // مودهای واقعی فری‌باف (از باینری CLI): DEFAULT | LITE | MAX | PLAN
    const allowed = ['DEFAULT', 'LITE', 'MAX', 'PLAN'];
    if (!allowed.includes(mode)) throw new Error(`مود نامعتبر: ${mode}. مجاز: ${allowed.join(' | ')}`);
    return this.write({ mode });
  }

  getModel() { return this.read().freebuffModel; }
  validateModel(model) {
    if (!/^[a-z0-9-]+\/[a-z0-9._:-]+$/i.test(model)) throw new Error(`قالب مدل باید provider/model باشد`);
    return model;
  }
  setModel(model) {
    this.validateModel(model);
    return this.write({ freebuffModel: model });
  }

  getAds() { return !!this.read().adsEnabled; }
  setAds(on) { return this.write({ adsEnabled: !!on }); }

  summary() {
    const s = this.read();
    return [
      `📄 تنظیمات فری‌باف (${path.basename(path.dirname(this.path))}):`,
      `• مود: ${s.mode}`,
      `• مدل: ${s.freebuffModel}`,
      `• تبلیغات: ${s.adsEnabled ? 'فعال ✅' : 'غیرفعال ❌'}`,
      s.freebuffModelDefaultMigration ? `• مدل مهاجرت پیش‌فرض: ${s.freebuffModelDefaultMigration}` : '',
    ].filter(Boolean).join('\n');
  }
}
