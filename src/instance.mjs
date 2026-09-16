// instance.mjs — مدیریت instance/قفل فری‌باف (رفع خطای takeover)
//
// درسِ جلسه قبلی: اگر ربات با freebuff_instance_id متفاوت admission بزند،
// بک‌اند جلسه تعاملی CLI را kick می‌کند (HTTP 409 Conflict) و CLI کاربر پیام
// «Another freebuff instance took over this account» می‌دهد.
//
// راه‌حل: ربات باید:
//  1) اگر CLI تعاملی در حال اجراست، از admission با instance-id جدید بپرهیزد
//     (یا فقط زمانی که کاربر صریحاً اجازه داده). وگرنه با همان instance-id
//     فعلی (از freebuff-instance-owner.json) چت کند.
//  2) خودش هم فقط یک instance داشته باشد (قفل فایل + PID).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { makeLogger } from './logger.mjs';

const log = makeLogger('instance');

export class InstanceManager {
  constructor() {
    this.configDir = process.env.FREEBUFF_CONFIG_DIR
      || path.join(os.homedir(), '.config', 'manicode');
    this.ownerFile = path.join(this.configDir, 'freebuff-instance-owner.json');
    this.botLockFile = path.join(this.configDir, 'freebuff-guardian.lock');
    this.instanceId = null;
  }

  // --- وضعیت CLI تعاملی ---
  // freebuff-instance-owner.json = { instanceId, pid }
  readOwner() {
    try {
      return JSON.parse(fs.readFileSync(this.ownerFile, 'utf8'));
    } catch {
      return null;
    }
  }

  isPidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  /** اطلاعات CLI تعاملی فعال (اگر هست) */
  activeCli() {
    const owner = this.readOwner();
    if (!owner) return null;
    if (!this.isPidAlive(owner.pid)) return null;
    // اگر پروسه‌ی زنده freebuff خودِ ربات باشد، تداخل حساب نمی‌شود
    try {
      const cmd = execSync(`ps -o args= -p ${owner.pid}`, { encoding: 'utf8' });
      if (cmd.includes('freebuff-guardian')) return null;
    } catch { /* پروسه مرد */ }
    return owner;
  }

  /** آیا هم‌اکنون CLI تعاملی فعال است؟ */
  isInteractiveActive() {
    return this.activeCli() !== null;
  }

  // --- قفل تک‌نمونه‌ای خود ربات ---
  acquireBotLock() {
    try {
      if (fs.existsSync(this.botLockFile)) {
        const old = JSON.parse(fs.readFileSync(this.botLockFile, 'utf8'));
        if (old.pid && this.isPidAlive(old.pid)) {
          throw new Error(`یک نمونه‌ی دیگر از نگهبان در حال اجراست (pid ${old.pid})`);
        }
      }
      fs.writeFileSync(this.botLockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      log.info('قفل ربات گرفته شد', `pid=${process.pid}`);
      return true;
    } catch (e) {
      log.error('گرفتن قفل ناموفق:', e.message);
      throw e;
    }
  }

  releaseBotLock() {
    try {
      const cur = JSON.parse(fs.readFileSync(this.botLockFile, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(this.botLockFile);
    } catch { /* نیست */ }
  }

  // --- instance-id برای درخواست‌های بک‌اند ---
  /**
   * instance-id امن برای metadata چت.
   * اگر CLI تعاملی فعال است، همان instanceId آن را برمی‌گردانیم تا بک‌اند
   * ما را به‌عنوان نمونه‌ی بیگانه kick نکند.
   */
  safeInstanceId() {
    const owner = this.activeCli();
    if (owner?.instanceId) {
      this.instanceId = owner.instanceId;
      return { id: owner.instanceId, borrowed: true };
    }
    if (!this.instanceId) {
      this.instanceId = `freebuff-guardian-${process.pid}-${Date.now().toString(36)}`;
    }
    return { id: this.instanceId, borrowed: false };
  }

  /** وضعیت برای نمایش به کاربر */
  statusText() {
    const owner = this.readOwner();
    const cli = this.activeCli();
    const lines = [
      `🔐 وضعیت instance فری‌باف:`,
      `• CLI تعاملی: ${cli ? `فعال ✅ (pid ${cli.pid}, id ${String(cli.instanceId).slice(0, 18)}…)` : 'غیرفعال'}`,
      `• مالک قفل فعلی: ${owner ? `pid ${owner.pid}${this.isPidAlive(owner.pid) ? '' : ' (مرده)'}` : 'هیچ'}`,
      `• instance ربات: ${this.instanceId ?? '—'}`,
      `• قفل ربات: ${fs.existsSync(this.botLockFile) ? 'برقرار' : 'آزاد'}`,
    ];
    return lines.join('\n');
  }
}
