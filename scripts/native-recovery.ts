// Supplementary native-process verification. Does not replace the container fault suite.
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPool } from '../packages/database/index.js';
import { migrate } from '../packages/database/migrate.js';
import { acceptPayment } from '../apps/api/service.js';
import { configSchema } from '../packages/config.js';
import { run, until } from './process.js';
const maintenance = process.env.NATIVE_PG_URL,
  mosquitto = process.env.NATIVE_MOSQUITTO;
if (!maintenance || !mosquitto)
  throw new Error('NATIVE_PG_URL and NATIVE_MOSQUITTO are required');
if (!['127.0.0.1', 'localhost'].includes(new URL(maintenance).hostname))
  throw new Error('Only local native test PostgreSQL allowed');
const stamp = Date.now(),
  directory = resolve(`.runtime/native-recovery-${stamp}`),
  db = `payops_test_recovery_${stamp}`;
await mkdir(directory, { recursive: true });
const admin = createPool(maintenance);
await admin.query(`CREATE DATABASE ${db}`);
await admin.end();
const url = new URL(maintenance);
url.pathname = '/' + db;
const pool = createPool(url.toString());
pool.on('error', () => {});
await migrate(pool);
const merchant = randomUUID(),
  device = '00000000-0000-4000-8000-000000000001',
  key = 'native-test-signing-key-32-characters-long';
await pool.query('INSERT INTO merchants(id,name) VALUES($1,$2)', [
  merchant,
  'Native recovery test',
]);
await pool.query('INSERT INTO devices(id,merchant_id,name) VALUES($1,$2,$3)', [
  device,
  merchant,
  'Native recovery device',
]);
await pool.query(
  'INSERT INTO device_credentials(device_id,version,secret) VALUES($1,1,$2)',
  [device, key],
);
const brokerPort = Number(process.env.NATIVE_MQTT_PORT ?? 51899),
  apiPort = Number(process.env.NATIVE_API_PORT ?? 53019);
const conf = resolve(directory, 'mosquitto.conf'),
  passwords = resolve(directory, 'passwords'),
  sqlite = resolve(directory, 'simulator.db');
await writeFile(
  passwords,
  'worker:test-worker-password\n' + device + ':test-device-password\n',
);
await run(resolve(mosquitto, 'mosquitto_passwd.exe'), ['-U', passwords]);
await writeFile(
  conf,
  `listener ${brokerPort} 127.0.0.1\nallow_anonymous false\npassword_file ${passwords.replaceAll('\\', '/')}\nacl_file ${resolve('infra/mosquitto/acl').replaceAll('\\', '/')}\npersistence true\npersistence_location ${directory.replaceAll('\\', '/')}/\nautosave_interval 1\nlog_dest stdout\n`,
);
const config = configSchema.parse({
  DATABASE_URL: url.toString(),
  JWT_SECRET: 'j'.repeat(40),
  MQTT_URL: `mqtt://127.0.0.1:${brokerPort}`,
  MQTT_PASSWORD: 'test-worker-password',
  DEVICE_KEY: key,
  DEVICE_ID: device,
  PORT: apiPort,
  WORKER_PORT: apiPort + 1,
  API_URL: `http://127.0.0.1:${apiPort}`,
  SIMULATOR_DB: sqlite,
  LEASE_MS: 2000,
  PUBLISH_TIMEOUT_MS: 500,
  COMMAND_TTL_MS: 120000,
  MAX_ATTEMPTS: 20,
  NODE_ENV: 'test',
  FAULT_TEST: '1',
});
const env = {
  ...process.env,
  ...Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])),
};
const children = new Map<string, ChildProcess>();
let logs = '';
const outputs = new WeakMap<ChildProcess, string>();
function start(name: string, point = '') {
  const child =
    name === 'broker'
      ? spawn(resolve(mosquitto!, 'mosquitto.exe'), ['-c', conf], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(process.execPath, ['--import', 'tsx', `apps/${name}/main.ts`], {
          env: {
            ...env,
            FAULT_POINT: point,
            ...(name === 'simulator'
              ? { MQTT_PASSWORD: 'test-device-password' }
              : {}),
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
  children.set(name, child);
  outputs.set(child, '');
  child.stdout?.on('data', (b) => {
    logs += String(b);
  });
  child.stderr?.on('data', (b) => {
    logs += String(b);
    outputs.set(child, (outputs.get(child) ?? '') + String(b));
  });
  return child;
}
function reached(child: ChildProcess, point: string) {
  return (
    child.exitCode !== 0 &&
    (outputs.get(child) ?? '').includes(
      JSON.stringify({ event: 'fault.injected', point }),
    )
  );
}
async function stop(name: string) {
  const child = children.get(name);
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((r) => {
    child.once('exit', () => r());
    child.kill('SIGKILL');
  });
}
async function pay() {
  return (
    await acceptPayment(pool, config, merchant, randomUUID(), {
      deviceId: device,
      amountMinor: '5500',
      currency: 'INR',
      reference: 'Native recovery probe',
    })
  ).payment.id as string;
}
async function complete(paymentId: string) {
  await until(
    async () =>
      (
        await pool.query('SELECT state FROM commands WHERE payment_id=$1', [
          paymentId,
        ])
      ).rows[0].state === 'completed',
    45000,
  );
  const command = (
    await pool.query('SELECT id FROM commands WHERE payment_id=$1', [paymentId])
  ).rows[0].id;
  const store = new DatabaseSync(sqlite);
  try {
    const effect = store
      .prepare('SELECT effect_count FROM inbox WHERE command_id=?')
      .get(command);
    if (effect?.effect_count !== 1)
      throw new Error('Missing or duplicate synthetic effect');
  } finally {
    store.close();
  }
  const receipt = await pool.query(
    'SELECT count(*)::int AS n FROM receipts WHERE command_id=$1',
    [command],
  );
  if (receipt.rows[0].n !== 1)
    throw new Error('Duplicate or missing original receipt');
}
const results: {
  scenario: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}[] = [];
async function scenario(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({
      scenario: name,
      passed: true,
      durationMs: Date.now() - start,
    });
    console.log(`PASS ${name}: ${Date.now() - start}ms`);
  } catch (e) {
    results.push({
      scenario: name,
      passed: false,
      durationMs: Date.now() - start,
      error: String(e),
    });
    throw e;
  }
}
try {
  start('broker');
  start('api');
  start('worker');
  start('simulator');
  await until(
    async () =>
      (
        await fetch(config.API_URL + '/health/ready', {
          signal: AbortSignal.timeout(1000),
        })
      ).ok,
    30000,
  );
  await scenario('baseline verified round trip', async () =>
    complete(await pay()),
  );
  await scenario('broker killed and restarted', async () => {
    await stop('broker');
    const id = await pay();
    await until(
      async () =>
        (
          await pool.query(
            'SELECT o.attempts FROM outbox o JOIN commands c ON c.id=o.command_id WHERE c.payment_id=$1',
            [id],
          )
        ).rows[0].attempts > 0,
    );
    const state = (
      await pool.query('SELECT state FROM commands WHERE payment_id=$1', [id])
    ).rows[0].state;
    if (state === 'completed')
      throw new Error('False completion during broker outage');
    start('broker');
    await complete(id);
  });
  for (const point of ['worker-after-claim', 'worker-after-publish'])
    await scenario(point, async () => {
      await stop('worker');
      await stop('simulator');
      const id = await pay();
      const child = start('worker', point);
      await until(async () => child.exitCode !== null, 30000);
      if (!reached(child, point))
        throw new Error('Worker did not reach crash point');
      start('worker');
      start('simulator');
      await complete(id);
    });
  for (const point of [
    'simulator-before-processing',
    'simulator-before-commit',
    'simulator-after-completion',
    'simulator-before-ack',
  ])
    await scenario(point, async () => {
      await stop('simulator');
      const id = await pay();
      const child = start('simulator', point);
      await until(async () => child.exitCode !== null, 30000);
      if (!reached(child, point))
        throw new Error('Simulator did not reach crash point');
      start('simulator');
      await complete(id);
    });
  await scenario('API offline after durable simulated completion', async () => {
    await stop('api');
    const id = await pay();
    const c = (
      await pool.query('SELECT id FROM commands WHERE payment_id=$1', [id])
    ).rows[0].id;
    await until(async () => {
      const s = new DatabaseSync(sqlite);
      try {
        return Boolean(
          s.prepare('SELECT command_id FROM inbox WHERE command_id=?').get(c),
        );
      } finally {
        s.close();
      }
    });
    if (
      (await pool.query('SELECT state FROM commands WHERE id=$1', [c])).rows[0]
        .state === 'completed'
    )
      throw new Error('Completion fabricated without API receipt');
    start('api');
    await complete(id);
  });
  await scenario('database connections terminated and recovered', async () => {
    await pool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [db],
    );
    await complete(await pay());
  });
  await scenario('bounded backlog of 30 payments', async () => {
    await stop('worker');
    const ids = await Promise.all(Array.from({ length: 30 }, () => pay()));
    start('worker');
    for (const id of ids) await complete(id);
  });
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const name of ['simulator', 'worker', 'api', 'broker']) await stop(name);
  await pool.end();
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/native-recovery-${stamp}.json`,
    JSON.stringify(
      {
        mode: 'native processes; not container verification',
        database: db,
        results,
        complete: results.length === 11 && results.every((r) => r.passed),
      },
      null,
      2,
    ),
  );
  await writeFile(resolve(directory, 'process.log'), logs);
  console.log(`Retained test database and ${directory}.`);
}
