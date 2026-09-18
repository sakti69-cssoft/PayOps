import { getConfig } from '../../packages/config.js';
import { createPool } from '../../packages/database/index.js';
import { log } from '../../packages/observability/index.js';
import { createApp } from './app.js';
const config = getConfig();
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => log.error({ event: 'database.idle_error' }));
const server = createApp(pool, config).listen(config.PORT, (error?: Error) => {
  if (error) {
    log.error({ event: 'api.listen_failed', port: config.PORT });
    void pool.end().finally(() => process.exit(1));
    return;
  }
  log.info({ event: 'api.listening', port: config.PORT });
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
