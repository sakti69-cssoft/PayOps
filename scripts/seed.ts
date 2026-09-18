import { randomUUID } from 'node:crypto';
import { createPool, transaction } from '../packages/database/index.js';
import { hashPassword } from '../packages/security/index.js';
export const merchantA = '10000000-0000-4000-8000-000000000001',
  merchantB = '10000000-0000-4000-8000-000000000002';
const pool = createPool(
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL!,
);
if (
  !process.env.SEED_PASSWORD ||
  !process.env.DEVICE_KEY ||
  !process.env.APP_PASSWORD
)
  throw new Error('Seed requires SEED_PASSWORD, DEVICE_KEY, APP_PASSWORD');
try {
  await transaction(pool, async (c) => {
    // Role DDL cannot bind passwords. quote_literal is evaluated by PostgreSQL, never interpolated from user input.
    const quoted = await c.query('SELECT quote_literal($1) AS password', [
      process.env.APP_PASSWORD,
    ]);
    await c.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='payops_app') THEN CREATE ROLE payops_app LOGIN; END IF; END $$",
    );
    await c.query('ALTER ROLE payops_app PASSWORD ' + quoted.rows[0].password);
    await c.query(
      'GRANT CONNECT ON DATABASE ' +
        (await c.query('SELECT quote_ident(current_database()) AS db')).rows[0]
          .db +
        ' TO payops_app',
    );
    await c.query(
      'GRANT USAGE ON SCHEMA public TO payops_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO payops_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO payops_app; REVOKE UPDATE,DELETE,TRUNCATE ON incident_evidence,receipts,audit_events FROM payops_app; REVOKE ALL ON schema_migrations FROM payops_app; REVOKE CREATE ON SCHEMA public FROM PUBLIC;',
    );
    await c.query(
      'INSERT INTO merchants(id,name) VALUES($1,$2),($3,$4) ON CONFLICT DO NOTHING',
      [
        merchantA,
        'Synthetic • Cedar Market',
        merchantB,
        'Synthetic • Harbor Cafe',
      ],
    );
    for (const [email, merchant, role] of [
      ['admin@cedar.test', merchantA, 'merchant-admin'],
      ['reader@cedar.test', merchantA, 'reader'],
      ['admin@harbor.test', merchantB, 'merchant-admin'],
    ] as const) {
      const id = randomUUID();
      const user = await c.query(
        'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id',
        [id, email, await hashPassword(process.env.SEED_PASSWORD!)],
      );
      await c.query(
        'INSERT INTO memberships(user_id,merchant_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [user.rows[0].id, merchant, role],
      );
    }
    await c.query(
      'INSERT INTO devices(id,merchant_id,name) VALUES($1,$2,$3),($4,$5,$6) ON CONFLICT DO NOTHING',
      [
        process.env.DEVICE_ID ?? '00000000-0000-4000-8000-000000000001',
        merchantA,
        'Counter 01',
        '00000000-0000-4000-8000-000000000002',
        merchantB,
        'Counter 02',
      ],
    );
    await c.query(
      'INSERT INTO device_credentials(device_id,version,secret) VALUES($1,1,$2) ON CONFLICT DO NOTHING',
      [
        process.env.DEVICE_ID ?? '00000000-0000-4000-8000-000000000001',
        process.env.DEVICE_KEY,
      ],
    );
  });
  console.log(
    'Synthetic merchants, users, device and restricted application role seeded.',
  );
} finally {
  await pool.end();
}
