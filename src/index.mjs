// index.mjs — نقطه‌ی ورود نگهبان فری‌باف
import { loadConfig } from './config.mjs';
import { StateStore } from './state.mjs';
import { InstanceManager } from './instance.mjs';
import { GuardianBot } from './bot.mjs';
import { makeLogger } from './logger.mjs';

const log = makeLogger('main');

async function main() {
  const cfg = loadConfig();
  const instances = new InstanceManager();

  // فقط یک نمونه از خود ربات
  instances.acquireBotLock();
  process.on('SIGTERM', () => { instances.releaseBotLock(); process.exit(0); });
  process.on('SIGINT', () => { instances.releaseBotLock(); process.exit(0); });

  const state = new StateStore(cfg.stateFile);
  new GuardianBot(cfg, state, instances);

  log.info('🛡️ نگهبان فری‌باف بالا آمد');
}

main().catch((e) => {
  log.error('خطای راه‌اندازی:', e);
  process.exit(1);
});
