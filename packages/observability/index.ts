import pino from 'pino';
import { Registry, Gauge, Histogram } from 'prom-client';
export const log = pino({
  redact: [
    'password',
    'secret',
    'key',
    'token',
    'authorization',
    'signature',
    'req.headers.authorization',
  ],
  base: undefined,
});
export const registry = new Registry();
export const backlog = new Gauge({
  name: 'payops_outbox_backlog',
  help: 'Outstanding dispatch work',
  registers: [registry],
});
export const oldest = new Gauge({
  name: 'payops_outbox_oldest_seconds',
  help: 'Age of oldest dispatch',
  registers: [registry],
});
export const retries = new Gauge({
  name: 'payops_retry_total',
  help: 'Recorded retry attempts',
  registers: [registry],
});
export const missing = new Gauge({
  name: 'payops_missing_receipts',
  help: 'Published commands without receipts',
  registers: [registry],
});
export const offline = new Gauge({
  name: 'payops_devices_offline',
  help: 'Devices without fresh heartbeats',
  registers: [registry],
});
export const latency = new Histogram({
  name: 'payops_delivery_seconds',
  help: 'Verified device completion latency',
  buckets: [1, 5, 15, 30, 60, 300],
  registers: [registry],
});
export const recentLatency = new Gauge({
  name: 'payops_recent_delivery_mean_seconds',
  help: 'Mean acceptance-to-verified-receipt latency of the latest 1000 completed commands; zero when empty',
  registers: [registry],
});
