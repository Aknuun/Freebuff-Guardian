// state.mjs — ذخیره‌سازی state کاربران و جلسه‌های چت
import fs from 'node:fs';
import { makeLogger } from './logger.mjs';

const log = makeLogger('state');

export class StateStore {
  constructor(filePath) {
    this.path = filePath;
    this.data = { users: {} }; // users[userId] = { chatId, sessions: {name: {messages, runId, updatedAt}} }
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        this.data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        log.info('state بارگذاری شد:', this.path);
      }
    } catch (e) {
      log.error('خواندن state ناموفق بود:', e.message);
      this.data = { users: {} };
    }
  }

  save() {
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch (e) {
      log.error('ذخیره state ناموفق بود:', e.message);
    }
  }

  // --- تنظیمات سراسری (مثل دقیقهٔ هشدار انقضا) ---
  getMeta(key) {
    return (this.data.meta ?? {})[key];
  }

  setMeta(key, value) {
    if (!this.data.meta) this.data.meta = {};
    this.data.meta[key] = value;
    this.save();
    return value;
  }

  user(userId) {
    if (!this.data.users[userId]) {
      this.data.users[userId] = {
        chatId: null,
        activeSession: null,
        sessions: {}, // name -> { messages: [], runId, updatedAt }
      };
    }
    return this.data.users[userId];
  }

  // --- جلسه‌ها ---
  listSessions(userId) {
    return Object.keys(this.user(userId).sessions);
  }

  getSession(userId, name) {
    return this.user(userId).sessions[name] ?? null;
  }

  ensureSession(userId, name) {
    const u = this.user(userId);
    if (!u.sessions[name]) {
      u.sessions[name] = { messages: [], runId: null, createdAt: Date.now(), updatedAt: Date.now() };
    }
    u.activeSession = name;
    this.save();
    return u.sessions[name];
  }

  deleteSession(userId, name) {
    const u = this.user(userId);
    delete u.sessions[name];
    if (u.activeSession === name) {
      u.activeSession = Object.keys(u.sessions)[0] ?? null;
    }
    this.save();
  }

  renameSession(userId, oldName, newName) {
    const u = this.user(userId);
    if (!u.sessions[oldName]) return false;
    u.sessions[newName] = u.sessions[oldName];
    delete u.sessions[oldName];
    if (u.activeSession === oldName) u.activeSession = newName;
    this.save();
    return true;
  }

  pushMessage(userId, name, msg) {
    const s = this.getSession(userId, name);
    if (!s) return;
    s.messages.push(msg);
    // تاریخچه را محدود نگه می‌داریم تا توکن نترکد
    const max = parseInt(process.env.MAX_HISTORY_MESSAGES || '40', 10);
    while (s.messages.length > max) s.messages.shift();
    s.updatedAt = Date.now();
    this.save();
  }

  clearMessages(userId, name) {
    const s = this.getSession(userId, name);
    if (s) {
      s.messages = [];
      s.updatedAt = Date.now();
      this.save();
    }
  }
}
