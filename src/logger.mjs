// logger.mjs — لاگر ساده با رنگ و سطح
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const env = process.env.LOG_LEVEL || 'info';
const threshold = LEVELS[env] ?? 20;

function fmt(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg).slice(0, 800); } catch { return String(arg); }
  }
  return String(arg);
}

function emit(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${tag}] ${args.map(fmt).join(' ')}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export function makeLogger(tag) {
  return {
    debug: (...a) => emit('debug', tag, a),
    info: (...a) => emit('info', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
  };
}
