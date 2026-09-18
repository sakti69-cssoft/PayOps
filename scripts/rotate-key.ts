import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createPool, transaction } from '../packages/database/index.js';
const device = z.uuid().parse(process.argv[2]);
const pool = createPool(process.env.MIGRATION_DATABASE_URL!);
const secret = randomBytes(32).toString('hex');
try {
  const version = await transaction(pool, async (c) => {
    const d = await c.query(
      'SELECT merchant_id FROM devices WHERE id=$1 FOR UPDATE',
      [device],
    );
    if (!d.rowCount) throw new Error('Device not found');
    const v = Number(
      (
        await c.query(
          'SELECT COALESCE(max(version),0)+1 AS v FROM device_credentials WHERE device_id=$1',
          [device],
        )
      ).rows[0].v,
    );
    await c.query(
      'INSERT INTO device_credentials(device_id,version,secret) VALUES($1,$2,$3)',
      [device, v, secret],
    );
    await c.query(
      "INSERT INTO audit_events(merchant_id,action,resource_id,detail) VALUES($1,'credential.rotate',$2,$3)",
      [d.rows[0].merchant_id, device, { version: v }],
    );
    return v;
  });
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir('.runtime', { recursive: true });
  await writeFile(
    `.runtime/device-${device}-v${version}.env`,
    `DEVICE_VERSION=${version}\nDEVICE_KEY=${secret}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    `New version ${version} saved to a private .runtime file. Old versions remain valid until explicitly revoked.`,
  );
} finally {
  await pool.end();
}
