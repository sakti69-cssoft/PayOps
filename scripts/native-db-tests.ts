// Optional fallback: exercises real PostgreSQL without claiming container/MQTT coverage.
import { run } from './process.js';
import { createPool } from '../packages/database/index.js';
const server = process.env.NATIVE_PG_URL;
if (!server)
  throw new Error(
    'Set NATIVE_PG_URL to a local PostgreSQL maintenance database URL',
  );
const u = new URL(server);
if (!['127.0.0.1', 'localhost'].includes(u.hostname))
  throw new Error('Native fallback is restricted to localhost');
const database = `payops_test_native_${Date.now()}`;
const pool = createPool(server);
try {
  await pool.query(`CREATE DATABASE ${database}`);
} finally {
  await pool.end();
}
u.pathname = '/' + database;
await run(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/integration/core.test.ts',
    'tests/integration/process.test.ts',
  ],
  { env: { ...process.env, TEST_DATABASE_URL: u.toString() } },
);
console.log(
  `Retained isolated database ${database}; MQTT/container checks are separate.`,
);
