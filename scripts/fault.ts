import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createPool } from '../packages/database/index.js';
import { configSchema } from '../packages/config.js';
import { acceptPayment, receiveEvidence, replay } from '../apps/api/service.js';
import { claim, finish } from '../apps/worker/dispatch.js';
import { signMessage } from '../packages/security/index.js';
import { run, until } from './process.js';
const project = `payops-test-${randomBytes(5).toString('hex')}`,
  base = ['compose', '-f', 'infra/compose/test.yaml', '-p', project];
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  run('docker', [...base, ...args], { env, timeout: 300000 });
const url = `postgresql://payops:test-only-local@localhost:${process.env.TEST_PG_PORT ?? 55432}/payops_test_core`,
  pool = createPool(url);
pool.on('error', () => {});
const merchant = '10000000-0000-4000-8000-000000000001',
  device = '00000000-0000-4000-8000-000000000001',
  deviceKey = 'test-device-signing-secret-at-least-thirty-two';
const config = configSchema.parse({
  DATABASE_URL: url,
  JWT_SECRET: 'j'.repeat(40),
  MQTT_PASSWORD: 'test-worker-password',
  DEVICE_KEY: deviceKey,
  LEASE_MS: 3000,
  MAX_ATTEMPTS: 12,
  COMMAND_TTL_MS: 180000,
});
const results: {
  scenario: string;
  invariant: string;
  recoveryMs: number;
  passed: boolean;
  error?: string;
}[] = [];
let brokerIncidentId = '';
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function scenario(
  name: string,
  invariant: string,
  fn: () => Promise<void>,
) {
  const start = Date.now();
  try {
    await fn();
    results.push({
      scenario: name,
      invariant,
      recoveryMs: Date.now() - start,
      passed: true,
    });
    console.log(`PASS ${name} (${Date.now() - start}ms)`);
  } catch (e) {
    results.push({
      scenario: name,
      invariant,
      recoveryMs: Date.now() - start,
      passed: false,
      error: e instanceof Error ? e.message : 'Unknown',
    });
    throw e;
  }
}
async function pay() {
  const result = await acceptPayment(pool, config, merchant, randomUUID(), {
    deviceId: device,
    amountMinor: '9900',
    currency: 'INR',
    reference: 'Fault demonstration',
  });
  return (
    await pool.query(
      'SELECT c.id,c.payment_id FROM commands c WHERE payment_id=$1',
      [result.payment.id],
    )
  ).rows[0] as { id: string; payment_id: string };
}
async function completed(id: string) {
  await until(
    async () =>
      (await pool.query('SELECT state FROM commands WHERE id=$1', [id])).rows[0]
        ?.state === 'completed',
    60000,
  );
  await docker([
    'exec',
    '-T',
    'simulator',
    'node',
    '--input-type=module',
    '-e',
    "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.SIMULATOR_DB,{readOnly:true}); const row=db.prepare('SELECT effect_count FROM inbox WHERE command_id=?').get(process.argv[1]); db.close(); if(row?.effect_count!==1)throw new Error('Missing or duplicate simulated effect');",
    id,
  ]);
}
async function crashed(service: string, point: string) {
  await until(async () => {
    const output = await docker(['ps', '--all', '--format', 'json', service]);
    const rows = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { State: string; ExitCode: number });
    return rows.some((row) => row.State === 'exited' && row.ExitCode === 86);
  }, 30000);
  const logs = await docker(['logs', '--no-color', service]);
  assert(
    logs.includes(`"point":"${point}"`),
    `Missing exact crash marker ${point}`,
  );
}
async function restartWorker(point = '') {
  await docker(['up', '-d', '--no-deps', '--force-recreate', 'worker'], {
    ...process.env,
    WORKER_FAULT_POINT: point,
  });
}
async function restartSimulator(point = '') {
  await docker(['up', '-d', '--no-deps', '--force-recreate', 'simulator'], {
    ...process.env,
    SIMULATOR_FAULT_POINT: point,
  });
}
try {
  // First-time image downloads and npm installation can exceed recovery deadlines.
  await run(
    'docker',
    [...base, 'up', '-d', '--build', 'api', 'worker', 'simulator'],
    {
      timeout: 1200000,
    },
  );
  await until(async () => {
    await pool.query('SELECT 1 FROM payments LIMIT 1');
    return (
      await fetch(
        `http://localhost:${process.env.TEST_API_PORT ?? 53000}/health/ready`,
      )
    ).ok;
  }, 60000);
  await scenario(
    'baseline',
    'Accepted work receives verified device completion',
    async () => {
      await completed((await pay()).id);
    },
  );
  for (const point of ['api-before-commit', 'api-after-commit'])
    await scenario(
      point,
      'A killed API leaves zero or one complete acceptance; same-key retry never duplicates',
      async () => {
        const key = randomUUID();
        let crashed = false;
        try {
          await docker([
            'run',
            '--rm',
            '--no-deps',
            '-e',
            `FAULT_POINT=${point}`,
            '-e',
            `TEST_MERCHANT=${merchant}`,
            '-e',
            `TEST_KEY=${key}`,
            'api',
            'node',
            '--import',
            'tsx',
            'tests/fault/child.ts',
          ]);
        } catch (e) {
          assert(String(e).includes('86'), 'Expected intentional exit code 86');
          crashed = true;
        }
        assert(crashed, 'Crash hook was not reached');
        const before = (
          await pool.query(
            'SELECT count(*)::int AS n FROM payments WHERE merchant_id=$1 AND idempotency_key=$2',
            [merchant, key],
          )
        ).rows[0].n;
        assert(
          before === (point === 'api-before-commit' ? 0 : 1),
          'Wrong durable commit boundary',
        );
        const first = await acceptPayment(pool, config, merchant, key, {
          deviceId: device,
          amountMinor: '9900',
          currency: 'INR',
          reference: 'Fault probe',
        });
        const second = await acceptPayment(pool, config, merchant, key, {
          deviceId: device,
          amountMinor: '9900',
          currency: 'INR',
          reference: 'Fault probe',
        });
        assert(
          first.payment.id === second.payment.id,
          'Duplicate payment after ambiguous response',
        );
      },
    );
  await scenario(
    'broker outage and restart',
    'Accepted payment remains durable without false device completion; recovers on broker return',
    async () => {
      await docker(['stop', 'broker']);
      const c = await pay();
      await until(
        async () =>
          (
            await pool.query(
              'SELECT attempts FROM outbox WHERE command_id=$1',
              [c.id],
            )
          ).rows[0].attempts > 0,
      );
      assert(
        (await pool.query('SELECT state FROM commands WHERE id=$1', [c.id]))
          .rows[0].state !== 'completed',
        'False completion while broker is stopped',
      );
      await until(async () => {
        const incident = await pool.query(
          'SELECT id FROM incidents WHERE resource_id=$1 AND merchant_id=$2 ORDER BY opened_at LIMIT 1',
          [c.id, merchant],
        );
        brokerIncidentId = incident.rows[0]?.id ?? '';
        return Boolean(brokerIncidentId);
      }, 30000);
      await docker(['start', 'broker']);
      await completed(c.id);
    },
  );
  await scenario(
    'read-only investigation after broker recovery',
    'The authenticated assistant cites stored incident evidence without changing delivery state',
    async () => {
      const api = `http://localhost:${process.env.TEST_API_PORT ?? 53000}`;
      const login = await fetch(`${api}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@cedar.test',
          password: 'test-login-password',
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert(login.ok, 'Demo login failed');
      const { token } = (await login.json()) as { token: string };
      const response = await fetch(
        `${api}/api/merchants/${merchant}/incidents/${brokerIncidentId}/investigation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: '{}',
          signal: AbortSignal.timeout(10000),
        },
      );
      assert(response.ok, 'Investigation failed');
      const result = (await response.json()) as {
        mode: string;
        facts: { evidenceId: string }[];
      };
      assert(
        result.mode === 'mock' && result.facts.length > 0,
        'Expected labeled mock evidence summary',
      );
      const evidence = await pool.query(
        'SELECT id FROM incident_evidence WHERE incident_id=$1',
        [brokerIncidentId],
      );
      assert(
        result.facts.every((f) =>
          evidence.rows.some((e) => e.id === f.evidenceId),
        ),
        'Invented evidence citation',
      );
    },
  );
  for (const point of ['worker-after-claim', 'worker-after-publish'])
    await scenario(
      point,
      'Abandoned leases recover with the same logical command and at most one synthetic effect',
      async () => {
        await docker(['stop', 'worker', 'simulator']);
        const c = await pay();
        await restartWorker(point);
        await crashed('worker', point);
        await restartWorker();
        await restartSimulator();
        await completed(c.id);
        assert(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM commands WHERE payment_id=$1',
              [c.payment_id],
            )
          ).rows[0].n === 1,
          'Duplicate logical command',
        );
      },
    );
  for (const point of [
    'simulator-before-processing',
    'simulator-before-commit',
    'simulator-after-completion',
    'simulator-before-ack',
  ])
    await scenario(
      point,
      'Simulator restart preserves deduplication and retries original signed completion evidence',
      async () => {
        await docker(['stop', 'simulator']);
        const c = await pay();
        await restartSimulator(point);
        await crashed('simulator', point);
        await restartSimulator();
        await completed(c.id);
        await until(
          async () =>
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM receipts WHERE command_id=$1',
                [c.id],
              )
            ).rows[0].n === 1,
        );
      },
    );
  await scenario(
    'database outage',
    'Processes reconnect after database restart without losing accepted work',
    async () => {
      await docker(['stop', 'simulator']);
      const c = await pay();
      await docker(['stop', 'database']);
      await new Promise((r) => setTimeout(r, 2000));
      await docker(['start', 'database']);
      await until(async () => {
        await pool.query('SELECT 1');
        return true;
      });
      await docker(['start', 'simulator']);
      await completed(c.id);
    },
  );
  await scenario(
    'stale leases and competing claimers',
    'Lease token fences an old publisher after another worker owns the claim',
    async () => {
      await docker(['stop', 'worker']);
      const c = await pay();
      let old = await claim(pool, config);
      while (old && old.command_id !== c.id) {
        await finish(pool, config, old, 'published');
        old = await claim(pool, config);
      }
      assert(old, 'No claim');
      await pool.query(
        "UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      const claims = await Promise.all([
        claim(pool, { ...config, WORKER_ID: 'second' }),
        claim(pool, { ...config, WORKER_ID: 'third' }),
      ]);
      const next = claims.find((v) => v?.id === old.id);
      assert(next, 'Lease not reclaimed');
      assert(
        !(await finish(pool, config, old, 'published')),
        'Stale owner overwrote new lease',
      );
      await finish(pool, config, next, 'retry', 'test_retry');
      await docker(['start', 'worker']);
      await completed(c.id);
    },
  );
  await scenario(
    'poison command and audited replay',
    'Malformed payload is terminal; a corrected replay preserves the command ID',
    async () => {
      await docker(['stop', 'worker']);
      const c = await pay();
      const saved = (
        await pool.query('SELECT payload FROM outbox WHERE command_id=$1', [
          c.id,
        ])
      ).rows[0].payload;
      await pool.query("UPDATE outbox SET payload='{}' WHERE command_id=$1", [
        c.id,
      ]);
      await docker(['start', 'worker']);
      await until(
        async () =>
          (
            await pool.query('SELECT status FROM outbox WHERE command_id=$1', [
              c.id,
            ])
          ).rows[0].status === 'permanent',
      );
      await pool.query('UPDATE outbox SET payload=$2 WHERE command_id=$1', [
        c.id,
        saved,
      ]);
      const user = (
        await pool.query("SELECT id FROM users WHERE email='admin@cedar.test'")
      ).rows[0].id;
      await replay(pool, merchant, user, c.id);
      await completed(c.id);
      assert(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM audit_events WHERE action='announcement.replay' AND resource_id=$1",
            [c.id],
          )
        ).rows[0].n === 1,
        'Replay not audited',
      );
    },
  );
  await scenario(
    'retry exhaustion and replay',
    'Exhaustion is explicit and never fabricated completion',
    async () => {
      await docker(['stop', 'worker', 'simulator']);
      const c = await pay();
      await pool.query('UPDATE outbox SET attempts=12 WHERE command_id=$1', [
        c.id,
      ]);
      await docker(['start', 'worker']);
      await until(
        async () =>
          (
            await pool.query('SELECT status FROM outbox WHERE command_id=$1', [
              c.id,
            ])
          ).rows[0].status === 'exhausted',
      );
      const user = (
        await pool.query("SELECT id FROM users WHERE email='admin@cedar.test'")
      ).rows[0].id;
      await replay(pool, merchant, user, c.id);
      await docker(['start', 'simulator']);
      await completed(c.id);
    },
  );
  await scenario(
    'duplicate delayed contradictory receipts',
    'Valid retransmissions are idempotent and contradictory late evidence cannot regress completion',
    async () => {
      const c = await pay();
      await completed(c.id);
      const payload = {
        kind: 'receipt' as const,
        deviceId: device,
        credentialVersion: 1,
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
        commandId: c.id,
        result: 'expired' as const,
      };
      const m = { ...payload, signature: signMessage(payload, deviceKey) };
      await receiveEvidence(pool, m);
      assert(
        (await receiveEvidence(pool, m)).duplicate,
        'Duplicate receipt not recognized',
      );
      assert(
        (await pool.query('SELECT state FROM commands WHERE id=$1', [c.id]))
          .rows[0].state === 'completed',
        'Completed state regressed',
      );
      assert(
        (
          await pool.query('SELECT conflicting FROM receipts WHERE id=$1', [
            m.messageId,
          ])
        ).rows[0].conflicting,
        'Conflict not stored',
      );
    },
  );
  await scenario(
    'backlog and bounded drain',
    'A burst of 60 accepted payments drains without duplicate logical commands',
    async () => {
      await docker(['stop', 'worker']);
      const payments = await Promise.all(
        Array.from({ length: 60 }, () => pay()),
      );
      await docker(['start', 'worker']);
      await until(
        async () =>
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM commands WHERE id=ANY($1::uuid[]) AND state='completed'",
              [payments.map((p) => p.id)],
            )
          ).rows[0].n === 60,
        90000,
      );
    },
  );
  await scenario(
    'backup and separate restore',
    'A consistent dump restores payment and evidence rows to a new database',
    async () => {
      await docker(['stop', 'api', 'worker', 'simulator']);
      await docker([
        'exec',
        '-T',
        'database',
        'pg_dump',
        '-U',
        'payops',
        '-d',
        'payops_test_core',
        '-Fc',
        '-f',
        '/tmp/payops-test.dump',
      ]);
      const target = `payops_test_restore_${Date.now()}`;
      await docker([
        'exec',
        '-T',
        'database',
        'createdb',
        '-U',
        'payops',
        target,
      ]);
      await docker([
        'exec',
        '-T',
        'database',
        'pg_restore',
        '-U',
        'payops',
        '-d',
        target,
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '/tmp/payops-test.dump',
      ]);
      const restored = createPool(
        url.replace('/payops_test_core', `/${target}`),
      );
      try {
        for (const table of [
          'payments',
          'commands',
          'receipts',
          'incident_evidence',
        ]) {
          const query = `SELECT count(*)::int AS n, md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]')) AS digest FROM ${table} t`;
          const original = (await pool.query(query)).rows[0];
          const copy = (await restored.query(query)).rows[0];
          assert(
            original.n > 0 &&
              original.n === copy.n &&
              original.digest === copy.digest,
            `Restored ${table} differs from source`,
          );
        }
      } finally {
        await restored.end();
      }
    },
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/${project}.json`,
    JSON.stringify(
      {
        project,
        endedAt: new Date().toISOString(),
        results,
        complete: results.length === 18 && results.every((r) => r.passed),
      },
      null,
      2,
    ),
  );
  await pool.end();
  await docker(['down', '--remove-orphans']).catch(() => {});
  console.log(
    `Test project ${project} stopped. All test volumes retained; no development resources targeted.`,
  );
}
