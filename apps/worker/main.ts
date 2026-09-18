import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from '../../packages/config.js';
import { createPool } from '../../packages/database/index.js';
import { connectBroker } from '../../packages/mqtt.js';
import { log, registry } from '../../packages/observability/index.js';
import { claim, dispatch } from './dispatch.js';
import { reconcile } from './reconcile.js';
const config = getConfig(),
  pool = createPool(config.DATABASE_URL),
  client = connectBroker(
    config.MQTT_URL,
    config.MQTT_USERNAME,
    config.MQTT_PASSWORD,
    config.WORKER_ID,
  );
pool.on('error', () => log.error({ event: 'database.idle_error' }));
let stopping = false,
  lastProgress = Date.now(),
  lastReconcile = 0;
const health = createServer((req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', registry.contentType);
    void registry.metrics().then((m) => res.end(m));
  } else {
    res.statusCode = Date.now() - lastProgress < 30000 ? 200 : 503;
    res.end(
      JSON.stringify({
        progressedAt: lastProgress,
        brokerConnected: client.connected,
      }),
    );
  }
}).listen(config.WORKER_PORT);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopping = true;
    setTimeout(() => process.exit(1), 15000).unref();
  });
while (!stopping) {
  try {
    if (Date.now() - lastReconcile > 3000) {
      await reconcile(pool);
      lastReconcile = Date.now();
    }
    const items = await Promise.all([
      claim(pool, config),
      claim(pool, config),
      claim(pool, config),
      claim(pool, config),
    ]);
    await Promise.all(
      items
        .filter((i) => i !== undefined)
        .map((i) => dispatch(pool, config, client, i)),
    );
    await pool.query(
      'INSERT INTO worker_status(id,progressed_at,broker_connected,disconnected_since) VALUES($1,now(),$2,CASE WHEN $2 THEN NULL ELSE now() END) ON CONFLICT(id) DO UPDATE SET progressed_at=now(),broker_connected=$2,disconnected_since=CASE WHEN $2 THEN NULL ELSE COALESCE(worker_status.disconnected_since,now()) END',
      [config.WORKER_ID, client.connected],
    );
    lastProgress = Date.now();
  } catch {
    log.error({ event: 'worker.cycle_failure' });
  }
  await sleep(250);
}
await client.endAsync();
await pool.end();
health.close();
