import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createPool, transaction } from '../../packages/database/index.js';
import { migrate } from '../../packages/database/migrate.js';
import { configSchema } from '../../packages/config.js';
import { createApp } from '../../apps/api/app.js';
import {
  acceptPayment,
  receiveEvidence,
  replay,
} from '../../apps/api/service.js';
import { claim, finish } from '../../apps/worker/dispatch.js';
import { reconcile } from '../../apps/worker/reconcile.js';
import {
  hashPassword,
  issueToken,
  signMessage,
} from '../../packages/security/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^payops_test_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))
  throw new Error(
    'Integration tests require TEST_DATABASE_URL with isolated database name payops_test_*',
  );
const pool = createPool(url),
  a = randomUUID(),
  b = randomUUID(),
  user = randomUUID(),
  reader = randomUUID(),
  device = randomUUID(),
  otherDevice = randomUUID(),
  key = 'k'.repeat(48);
const config = configSchema.parse({
  DATABASE_URL: url,
  JWT_SECRET: 'j'.repeat(48),
  MQTT_PASSWORD: 'm'.repeat(48),
  DEVICE_KEY: key,
  LEASE_MS: 1000,
  MAX_ATTEMPTS: 3,
});
const app = createApp(pool, config);
let token = '',
  readerToken = '';
const body = () => ({
  deviceId: device,
  amountMinor: '12900',
  currency: 'INR',
  reference: 'Synthetic test',
});
beforeAll(async () => {
  await migrate(pool);
  await transaction(pool, async (c) => {
    await c.query('INSERT INTO merchants(id,name) VALUES($1,$2),($3,$4)', [
      a,
      'Test A',
      b,
      'Test B',
    ]);
    await c.query(
      'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3)',
      [
        user,
        `${user}@test.invalid`,
        await hashPassword('password'),
        reader,
        `${reader}@test.invalid`,
      ],
    );
    await c.query(
      "INSERT INTO memberships(user_id,merchant_id,role) VALUES($1,$2,'merchant-admin'),($3,$2,'reader')",
      [user, a, reader],
    );
    await c.query(
      'INSERT INTO devices(id,merchant_id,name) VALUES($1,$2,$3),($4,$5,$6)',
      [device, a, 'Test A device', otherDevice, b, 'Test B device'],
    );
    await c.query(
      'INSERT INTO device_credentials(device_id,version,secret) VALUES($1,1,$2)',
      [device, key],
    );
  });
  token = await issueToken(user, config.JWT_SECRET);
  readerToken = await issueToken(reader, config.JWT_SECRET);
});
afterAll(async () => pool.end());
describe('Atomic acceptance and isolation against PostgreSQL', () => {
  it('commits one payment, command and outbox for 40 concurrent identical requests', async () => {
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        acceptPayment(pool, config, a, id, body()),
      ),
    );
    expect(new Set(results.map((r) => r.payment.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM payments p JOIN commands c ON c.payment_id=p.id JOIN outbox o ON o.command_id=c.id WHERE p.merchant_id=$1 AND p.idempotency_key=$2',
      [a, id],
    );
    expect(rows.rows[0].n).toBe(1);
  });
  it('rejects conflicting reuse and permits the same key in a different tenant', async () => {
    const id = randomUUID();
    await acceptPayment(pool, config, a, id, body());
    await expect(
      acceptPayment(pool, config, a, id, { ...body(), amountMinor: '100' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      acceptPayment(pool, config, b, id, { ...body(), deviceId: otherDevice }),
    ).resolves.toMatchObject({ duplicate: false });
  });
  it('rolls back a transaction that fails after acceptance statements', async () => {
    const id = randomUUID();
    await expect(
      transaction(pool, async (c) => {
        await c.query('INSERT INTO merchants(id,name) VALUES($1,$2)', [
          id,
          'rollback',
        ]);
        await c.query('SELECT 1/0');
      }),
    ).rejects.toThrow();
    expect(
      (await pool.query('SELECT * FROM merchants WHERE id=$1', [id])).rowCount,
    ).toBe(0);
  });
  it('denies tenant B payments, devices, incidents, audit and detail routes', async () => {
    for (const path of [
      'payments',
      'devices',
      'incidents',
      'audit',
      `payments/${randomUUID()}`,
      `incidents/${randomUUID()}`,
    ]) {
      const response = await request(app)
        .get(`/api/merchants/${b}/${path}`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(404);
    }
  });
  it('does not authorize an injected tenant or foreign device', async () => {
    const response = await request(app)
      .post(`/api/merchants/${a}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...body(), deviceId: otherDevice });
    expect(response.status).toBe(404);
  });
  it('reader cannot ingest or replay; missing JWT is denied', async () => {
    expect(
      (
        await request(app)
          .post(`/api/merchants/${a}/payments`)
          .set('Authorization', `Bearer ${readerToken}`)
          .set('Idempotency-Key', randomUUID())
          .send(body())
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/merchants/${a}/announcements/${randomUUID()}/replay`)
          .set('Authorization', `Bearer ${readerToken}`)
          .send({ confirm: true })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/merchants/${a}/payments`)).status,
    ).toBe(401);
  });
  it('returns consistent validation errors for missing idempotency and money fractions', async () => {
    expect(
      (
        await request(app)
          .post(`/api/merchants/${a}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .send(body())
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/merchants/${a}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({ ...body(), amountMinor: '1.5' })
      ).status,
    ).toBe(400);
  });
});
describe('Fencing and device evidence', () => {
  it('competing workers never claim the same lease', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        acceptPayment(pool, config, a, randomUUID(), body()),
      ),
    );
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claim(pool, { ...config, WORKER_ID: `test-${i}` }),
      ),
    );
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((c) => c!.id)).size).toBe(8);
  });
  it('expired claims recover and stale writers cannot overwrite the new owner', async () => {
    await pool.query(
      "UPDATE outbox SET status='published' WHERE status IN ('pending','leased')",
    );
    await acceptPayment(pool, config, a, randomUUID(), body());
    const old = (await claim(pool, config))!;
    await pool.query(
      "UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",
      [old.id],
    );
    const fresh = (await claim(pool, { ...config, WORKER_ID: 'new-worker' }))!;
    expect(fresh.id).toBe(old.id);
    expect(fresh.lease_token).not.toBe(old.lease_token);
    expect(await finish(pool, config, old, 'published')).toBe(false);
    expect(await finish(pool, config, fresh, 'published')).toBe(true);
    expect(
      (
        await pool.query('SELECT state FROM commands WHERE id=$1', [
          old.command_id,
        ])
      ).rows[0].state,
    ).toBe('published');
  });
  it('signed completion alone marks completed; duplicate evidence is idempotent, conflicting IDs rejected', async () => {
    const result = await acceptPayment(pool, config, a, randomUUID(), body());
    const c = (
      await pool.query('SELECT * FROM commands WHERE payment_id=$1', [
        result.payment.id,
      ])
    ).rows[0];
    const unsigned = {
      kind: 'receipt' as const,
      deviceId: device,
      credentialVersion: 1,
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
      commandId: c.id as string,
      result: 'completed' as const,
    };
    const m = { ...unsigned, signature: signMessage(unsigned, key) };
    await receiveEvidence(pool, m);
    expect(await receiveEvidence(pool, m)).toMatchObject({ duplicate: true });
    const changed = { ...unsigned, result: 'expired' as const };
    await expect(
      receiveEvidence(pool, {
        ...changed,
        signature: signMessage(changed, key),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await pool.query('SELECT state FROM commands WHERE id=$1', [c.id]))
        .rows[0].state,
    ).toBe('completed');
    await expect(replay(pool, a, user, c.id)).rejects.toMatchObject({
      status: 409,
    });
  });
  it('rejects wrong signatures, future heartbeats and cross-device completion', async () => {
    const unsigned = {
      kind: 'heartbeat' as const,
      deviceId: device,
      credentialVersion: 1,
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    await expect(
      receiveEvidence(pool, {
        ...unsigned,
        signature: signMessage(unsigned, 'wrong'),
      }),
    ).rejects.toMatchObject({ status: 401 });
    const future = {
      ...unsigned,
      timestamp: new Date(Date.now() + 600000).toISOString(),
    };
    await expect(
      receiveEvidence(pool, { ...future, signature: signMessage(future, key) }),
    ).rejects.toMatchObject({ status: 422 });
    const foreign = await acceptPayment(pool, config, b, randomUUID(), {
      ...body(),
      deviceId: otherDevice,
    });
    const c = (
      await pool.query('SELECT id FROM commands WHERE payment_id=$1', [
        foreign.payment.id,
      ])
    ).rows[0];
    const receipt = {
      ...unsigned,
      kind: 'receipt' as const,
      commandId: c.id as string,
      result: 'completed' as const,
    };
    await expect(
      receiveEvidence(pool, {
        ...receipt,
        signature: signMessage(receipt, key),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('keeps completed state despite a contradictory late receipt and stores conflict', async () => {
    const result = await acceptPayment(pool, config, a, randomUUID(), body());
    const c = (
      await pool.query('SELECT id FROM commands WHERE payment_id=$1', [
        result.payment.id,
      ])
    ).rows[0];
    for (const outcome of ['completed', 'expired'] as const) {
      const payload = {
        kind: 'receipt' as const,
        deviceId: device,
        credentialVersion: 1,
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
        commandId: c.id as string,
        result: outcome,
      };
      await receiveEvidence(pool, {
        ...payload,
        signature: signMessage(payload, key),
      });
    }
    expect(
      (await pool.query('SELECT state FROM commands WHERE id=$1', [c.id]))
        .rows[0].state,
    ).toBe('completed');
    expect(
      (
        await pool.query(
          'SELECT * FROM receipts WHERE command_id=$1 AND conflicting',
          [c.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('deduplicates incident creation, protects evidence from mutation, checks migration checksums', async () => {
    await reconcile(pool);
    const before = (await pool.query('SELECT count(*) FROM incidents')).rows[0]
      .count;
    await Promise.all([reconcile(pool), reconcile(pool)]);
    expect(
      (await pool.query('SELECT count(*) FROM incidents')).rows[0].count,
    ).toBe(before);
    await expect(
      pool.query("UPDATE incident_evidence SET snapshot='{}'"),
    ).rejects.toThrow('append-only');
    await migrate(pool);
  });
  it('rejects evidence signed by a revoked credential version, including retransmissions', async () => {
    await pool.query(
      'INSERT INTO device_credentials(device_id,version,secret) VALUES($1,2,$2)',
      [device, key],
    );
    const unsigned = {
      kind: 'heartbeat' as const,
      deviceId: device,
      credentialVersion: 2,
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    const message = { ...unsigned, signature: signMessage(unsigned, key) };
    await receiveEvidence(pool, message);
    await pool.query(
      'UPDATE device_credentials SET revoked_at=now() WHERE device_id=$1 AND version=2',
      [device],
    );
    await expect(receiveEvidence(pool, message)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('serializes migration runners and rejects a changed recorded checksum', async () => {
    await Promise.all([migrate(pool), migrate(pool)]);
    const original = (
      await pool.query(
        'SELECT name,checksum FROM schema_migrations ORDER BY name LIMIT 1',
      )
    ).rows[0];
    await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1', [
      original.name,
      'tampered',
    ]);
    try {
      await expect(migrate(pool)).rejects.toThrow(
        'Migration checksum mismatch',
      );
    } finally {
      await pool.query(
        'UPDATE schema_migrations SET checksum=$2 WHERE name=$1',
        [original.name, original.checksum],
      );
    }
  });
  it('records exhaustion separately from completion and audits replay without changing command identity', async () => {
    await pool.query(
      "UPDATE outbox SET status='published' WHERE status IN ('pending','leased')",
    );
    const accepted = await acceptPayment(pool, config, a, randomUUID(), body());
    const item = (await claim(pool, config))!;
    expect(item).toBeDefined();
    await finish(
      pool,
      { ...config, MAX_ATTEMPTS: 1 },
      item,
      'retry',
      'broker_unavailable',
    );
    expect(
      (await pool.query('SELECT status FROM outbox WHERE id=$1', [item.id]))
        .rows[0].status,
    ).toBe('exhausted');
    expect(
      (
        await pool.query('SELECT state FROM commands WHERE id=$1', [
          item.command_id,
        ])
      ).rows[0].state,
    ).toBe('unknown');
    const result = await replay(pool, a, user, item.command_id);
    expect(result.commandId).toBe(item.command_id);
    expect(
      (
        await pool.query('SELECT id FROM commands WHERE payment_id=$1', [
          accepted.payment.id,
        ])
      ).rows[0].id,
    ).toBe(item.command_id);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='announcement.replay' AND resource_id=$1",
          [item.command_id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
