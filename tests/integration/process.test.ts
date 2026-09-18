import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createPool } from '../../packages/database/index.js';
import { migrate } from '../../packages/database/migrate.js';
import { configSchema } from '../../packages/config.js';
import { acceptPayment } from '../../apps/api/service.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/payops_test_'))
  throw new Error('Isolated TEST_DATABASE_URL required');
const pool = createPool(url),
  merchant = randomUUID(),
  device = randomUUID();
const config = configSchema.parse({
  DATABASE_URL: url,
  JWT_SECRET: 'j'.repeat(40),
  MQTT_PASSWORD: 'm'.repeat(40),
  DEVICE_KEY: 'k'.repeat(40),
  DEVICE_ID: device,
  NODE_ENV: 'test',
  FAULT_TEST: '1',
});
beforeAll(async () => {
  await migrate(pool);
  await pool.query('INSERT INTO merchants(id,name) VALUES($1,$2)', [
    merchant,
    'Process fault tenant',
  ]);
  await pool.query(
    'INSERT INTO devices(id,merchant_id,name) VALUES($1,$2,$3)',
    [device, merchant, 'Process fault device'],
  );
});
afterAll(async () => pool.end());
for (const point of ['api-before-commit', 'api-after-commit'])
  it(`real process death at ${point} preserves atomic acceptance and retry identity`, async () => {
    const key = randomUUID();
    const start = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/fault/child.ts'],
        {
          env: {
            ...process.env,
            ...Object.fromEntries(
              Object.entries(config).map(([k, v]) => [k, String(v)]),
            ),
            FAULT_POINT: point,
            TEST_MERCHANT: merchant,
            TEST_KEY: key,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      let error = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Fault process timed out: ' + error));
      }, 15000);
      child.stderr.on('data', (b) => {
        error += String(b);
      });
      child.on('error', reject);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(86);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM payments WHERE merchant_id=$1 AND idempotency_key=$2',
      [merchant, key],
    );
    expect(rows.rows[0].n).toBe(point === 'api-before-commit' ? 0 : 1);
    const body = {
      deviceId: device,
      amountMinor: '9900',
      currency: 'INR',
      reference: 'Fault probe',
    };
    const first = await acceptPayment(
      pool,
      { ...config, FAULT_TEST: '0' },
      merchant,
      key,
      body,
    );
    const again = await acceptPayment(
      pool,
      { ...config, FAULT_TEST: '0' },
      merchant,
      key,
      body,
    );
    expect(first.payment.id).toBe(again.payment.id);
    const durable = await pool.query(
      'SELECT count(*)::int AS n FROM payments p JOIN commands c ON c.payment_id=p.id JOIN outbox o ON o.command_id=c.id WHERE p.merchant_id=$1 AND p.idempotency_key=$2',
      [merchant, key],
    );
    expect(durable.rows[0].n).toBe(1);
    console.log(
      JSON.stringify({
        scenario: point,
        processExit: code,
        verifiedRecoveryMs: Date.now() - start,
        logicalPayments: 1,
        logicalCommands: 1,
      }),
    );
  });
