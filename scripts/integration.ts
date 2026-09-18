import { randomBytes } from 'node:crypto';
import { run } from './process.js';
const project = `payops-test-${randomBytes(5).toString('hex')}`;
const args = ['compose', '-f', 'infra/compose/test.yaml', '-p', project];
try {
  await run('docker', [...args, 'up', '-d', '--wait', 'database', 'broker']);
  await run(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration'],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://payops:test-only-local@localhost:${process.env.TEST_PG_PORT ?? 55432}/payops_test_core`,
        TEST_MQTT_URL: `mqtt://localhost:${process.env.TEST_MQTT_PORT ?? 51883}`,
      },
    },
  );
} finally {
  await run('docker', [...args, 'down', '--remove-orphans']).catch(() => {});
  console.log(`Preserved test volumes for ${project}; no volumes deleted.`);
}
