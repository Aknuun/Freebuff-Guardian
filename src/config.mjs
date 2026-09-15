// config.mjs — بارگذاری و اعتبارسنجی پیکربندی ربات نگهبان فری‌باف
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeLogger } from './logger.mjs';

const log = makeLogger('config');

const REQUIRED_KEYS = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS'];

// در مود رایگان، هر مدل فقط با یک agent مشخص مجاز است (خطای
// free_mode_invalid_agent_model). این نگاشت از کاتالوگ خود باینری freebuff
// استخراج شده است تا agent همیشه با مدل انتخاب‌شده هماهنگ بماند.
const FREE_AGENT_BY_MODEL = {
  'z-ai/glm-5.3-flash': 'base2-free-glm-5-3-flash',
  'z-ai/glm-5.2': 'base2-free-glm',
  'z-ai/glm-5.1': 'base2-free-glm',
  'z-ai/glm-5': 'base2-free-glm',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'openai/gpt-5.6-luna': 'base2-free-luna',
  'openai/gpt-5.6-luna-es': 'base2-free-luna-es',
  'openai/gpt-5.6-luna-max': 'base2-free-luna-max',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'deepseek/deepseek-v4-pro-max': 'base2-free-deepseek-pro-max',
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'deepseek/deepseek-v4-flash-max': 'base2-free-deepseek-flash-max',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'crof/kimi-k3-eco': 'base2-free-kimi-k3-eco',
  'meta/muse-spark-1.2-contributor': 'base2-free-muse-spark',
  'meta/muse-spark-1.3-contributor': 'base2-free-muse-spark-1-3',
  'google/gemini-3.8-flash': 'base2-free-gemini-3-8-flash',
  'stealth/ox-alpha': 'base2-free-ox-alpha',
  'anthropic/claude-fable-5': 'base2-free-fable',
};

/** agent رایگان متناظر با مدل؛ اگر مدل ناشناخته باشد undefined */
export function freeAgentForModel(model) {
  return FREE_AGENT_BY_MODEL[model];
}

/** مدل‌های رایگان پشتیبانی‌شده */
export function freeModels() {
  return Object.keys(FREE_AGENT_BY_MODEL);
}

export function loadConfig() {
  // .env ساده را دستی می‌خوانیم (بدون وابستگی خارجی)
  const envFile = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }

  const missing = REQUIRED_KEYS.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`متغیرهای محیطی الزامی تنظیم نشده‌اند: ${missing.join(', ')} — فایل .env را کامل کن`);
  }

  // اعتبارنامه‌ی فری‌باف از همان فایلی که خود CLI استفاده می‌کند
  const credPath = process.env.FREEBUFF_CREDENTIALS_PATH
    || path.join(os.homedir(), '.config', 'manicode', 'credentials.json');
  let fbUser = null;
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    fbUser = creds.default ?? null;
  } catch (e) {
    log.warn('خواندن credentials فری‌باف ناموفق بود؛ چت غیرفعال می‌ماند:', e.message);
  }

  const fbModel = process.env.FREEBUFF_MODEL || 'z-ai/glm-5.3-flash';
  const envAgent = process.env.FREEBUFF_AGENT || null;
  const mappedAgent = freeAgentForModel(fbModel);
  const fbAgent = mappedAgent || envAgent || 'base2-free';
  if (envAgent && mappedAgent && envAgent !== mappedAgent) {
    log.warn(`FREEBUFF_AGENT=${envAgent} با مدل ${fbModel} ناسازگار است؛ از ${mappedAgent} استفاده می‌شود`);
  }

  const cfg = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUserIds: process.env.ALLOWED_USER_IDS.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n)),
    stateFile: process.env.STATE_FILE || path.join(process.cwd(), 'state.json'),
    // فری‌باف
    fbUser,
    fbAuthToken: fbUser?.authToken ?? null,
    fbFingerprintId: fbUser?.fingerprintId ?? `freebuff-guardian-${Date.now().toString(36)}`,
    fbModel,
    fbAgent,
    websiteUrl: process.env.FREEBUFF_WEBSITE_URL || 'https://www.codebuff.com',
    // محدودیت‌ها
    maxAnswerChars: parseInt(process.env.MAX_ANSWER_CHARS || '3500', 10),
    cmdTimeoutSec: parseInt(process.env.CMD_TIMEOUT_SEC || '60', 10),
  };

  log.info('پیکربندی بارگذاری شد', `user=${cfg.allowedUserIds.join(',')}`, `model=${cfg.fbModel}`, `fbAuth=${cfg.fbAuthToken ? 'OK' : 'MISSING'}`);
  return cfg;
}
