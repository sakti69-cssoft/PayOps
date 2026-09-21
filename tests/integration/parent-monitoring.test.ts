import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import request from 'supertest';
import { createPool } from '../../packages/database/index.js';
import { migrate } from '../../packages/database/migrate.js';
import { syncParent } from '../../packages/parent-monitoring/index.js';
import { createApp } from '../../apps/api/app.js';
import { configSchema } from '../../packages/config.js';
import { issueToken } from '../../packages/security/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^payops_test_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))
  throw new Error('Isolated test database required');
const pool = createPool(url),
  merchant = randomUUID(),
  other = randomUUID(),
  user = randomUUID();
const mapping = {
  sourceId: 'parent-' + randomUUID(),
  merchantId: merchant,
  parentMerchantId: randomUUID(),
  baseUrl: 'http://localhost:39009',
  token: 'private-test-token',
};
const row = {
  id: randomUUID(),
  merchantId: mapping.parentMerchantId,
  deviceId: randomUUID(),
  transactionReference: 'PARENT-TEST',
  amount: 129,
  currency: 'INR',
  paymentStatus: 'SUCCESS',
  announcementStatus: 'PENDING',
  createdAt: new Date(Date.now() - 60000).toISOString(),
};
const transport = async () =>
  Response.json({ items: [row], page: 1, limit: 100, total: 1 });
const config = configSchema.parse({
  DATABASE_URL: url,
  JWT_SECRET: 'j'.repeat(40),
  MQTT_PASSWORD: 'm'.repeat(40),
  DEVICE_KEY: 'k'.repeat(40),
});
let token = '';
const app = createApp(pool, config);
beforeAll(async () => {
  await migrate(pool);
  await pool.query('INSERT INTO merchants(id,name) VALUES($1,$2),($3,$4)', [
    merchant,
    'Parent mapped',
    other,
    'Other',
  ]);
  await pool.query(
    'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
    [user, `${user}@test.invalid`, 'not-a-password'],
  );
  await pool.query(
    "INSERT INTO memberships(user_id,merchant_id,role) VALUES($1,$2,'reader')",
    [user, merchant],
  );
  token = await issueToken(user, config.JWT_SECRET);
});
afterAll(async () => pool.end());
it('imports idempotently with incident evidence but creates no delivery work', async () => {
  const before = await pool.query(
    'SELECT (SELECT count(*) FROM payments WHERE merchant_id=$1) AS p,(SELECT count(*) FROM commands WHERE merchant_id=$1) AS c,(SELECT count(*) FROM outbox o JOIN commands c ON c.id=o.command_id WHERE c.merchant_id=$1) AS o',
    [merchant],
  );
  await syncParent(pool, mapping, transport);
  await syncParent(pool, mapping, transport);
  const imported = await pool.query(
    'SELECT * FROM parent_transactions WHERE source_id=$1',
    [mapping.sourceId],
  );
  expect(imported.rows).toHaveLength(1);
  expect(imported.rows[0].amount_minor).toBe('12900');
  const incident = await pool.query(
    'SELECT i.*,e.id AS evidence_id FROM incidents i JOIN incident_evidence e ON e.incident_id=i.id WHERE resource_id=$1',
    [imported.rows[0].id],
  );
  expect(incident.rows).toHaveLength(1);
  expect(incident.rows[0].status).toBe('open');
  const after = await pool.query(
    'SELECT (SELECT count(*) FROM payments WHERE merchant_id=$1) AS p,(SELECT count(*) FROM commands WHERE merchant_id=$1) AS c,(SELECT count(*) FROM outbox o JOIN commands c ON c.id=o.command_id WHERE c.merchant_id=$1) AS o',
    [merchant],
  );
  expect(after.rows).toEqual(before.rows);
  const answer = await request(app)
    .post(
      `/api/merchants/${merchant}/incidents/${incident.rows[0].id}/investigation`,
    )
    .auth(token, { type: 'bearer' })
    .send({});
  expect(answer.status).toBe(200);
  expect(
    answer.body.facts.every(
      (f: { evidenceId: string }) =>
        f.evidenceId === incident.rows[0].evidence_id,
    ),
  ).toBe(true);
});
it('resolves publication incidents without claiming device completion', async () => {
  row.announcementStatus = 'PUBLISHED';
  await syncParent(pool, mapping, transport);
  const incident = await pool.query(
    'SELECT i.status FROM incidents i JOIN parent_transactions p ON p.id=i.resource_id WHERE p.source_id=$1',
    [mapping.sourceId],
  );
  expect(incident.rows[0].status).toBe('resolved');
  const evidence = await pool.query(
    'SELECT e.snapshot FROM incident_evidence e JOIN incidents i ON i.id=e.incident_id JOIN parent_transactions p ON p.id=i.resource_id WHERE p.source_id=$1',
    [mapping.sourceId],
  );
  expect(evidence.rows).toHaveLength(2);
  expect(
    evidence.rows.some(
      (e) => e.snapshot.parent.announcementStatus === 'PENDING',
    ),
  ).toBe(true);
});
it('enforces merchant read access and does not return source credentials', async () => {
  const own = await request(app)
    .get(`/api/merchants/${merchant}/parent-transactions`)
    .auth(token, { type: 'bearer' });
  expect(own.status).toBe(200);
  expect(own.body.items).toHaveLength(1);
  expect(JSON.stringify(own.body)).not.toContain(mapping.token);
  expect(
    (
      await request(app)
        .get(`/api/merchants/${other}/parent-transactions`)
        .auth(token, { type: 'bearer' })
    ).status,
  ).toBe(404);
  expect(
    (await request(app).get(`/api/merchants/${merchant}/parent-transactions`))
      .status,
  ).toBe(401);
});
it('retains observations on authentication failure and rejects mapping changes', async () => {
  await expect(
    syncParent(pool, mapping, async () => new Response('', { status: 401 })),
  ).rejects.toThrow('synchronization failed');
  expect(
    (
      await pool.query('SELECT sync_status FROM parent_sources WHERE id=$1', [
        mapping.sourceId,
      ])
    ).rows[0].sync_status,
  ).toBe('error');
  await expect(
    syncParent(pool, { ...mapping, merchantId: other }, transport),
  ).rejects.toThrow('mapping mismatch');
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM parent_transactions WHERE source_id=$1',
        [mapping.sourceId],
      )
    ).rows[0].n,
  ).toBe(1);
});
it('rejects a wrong-merchant page before any import', async () => {
  await expect(
    syncParent(pool, mapping, async () =>
      Response.json({
        items: [{ ...row, id: randomUUID(), merchantId: other }],
        page: 1,
        limit: 100,
        total: 1,
      }),
    ),
  ).rejects.toThrow();
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM parent_transactions WHERE source_id=$1',
        [mapping.sourceId],
      )
    ).rows[0].n,
  ).toBe(1);
});
