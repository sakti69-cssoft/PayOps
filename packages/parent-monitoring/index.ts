import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from '../database/index.js';
import { transaction } from '../database/index.js';

export const parentConfig = z.object({
  sourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  merchantId: z.uuid(),
  parentMerchantId: z.uuid(),
  baseUrl: z.url().refine((s) => {
    const u = new URL(s);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/' &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  }, 'Use an HTTPS origin or a loopback HTTP origin'),
  token: z.string().min(1),
});
export type ParentConfig = z.infer<typeof parentConfig>;
export const parentRow = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  deviceId: z.uuid(),
  transactionReference: z.string().min(1).max(80),
  amount: z
    .number()
    .positive()
    .max(10000000)
    .refine((n) => Number(n.toFixed(2)) === n),
  currency: z.literal('INR'),
  paymentStatus: z.enum(['PENDING', 'SUCCESS', 'FAILED']),
  announcementStatus: z.enum(['PENDING', 'PUBLISHED', 'DELIVERED', 'FAILED']),
  createdAt: z.iso.datetime(),
});
export type ParentRow = z.infer<typeof parentRow>;
const pageSchema = z.object({
  items: z.array(parentRow).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.literal(100),
});

export async function fetchParentPage(
  config: ParentConfig,
  page: number,
  transport: typeof fetch = fetch,
) {
  const url = new URL('/api/v1/transactions', config.baseUrl);
  url.searchParams.set('merchantId', config.parentMerchantId);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', '100');
  const response = await transport(url, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Parent API HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Parent response is empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 524288) throw new Error('Parent response exceeds limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const parsed = pageSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
  );
  if (
    parsed.page !== page ||
    parsed.items.some((row) => row.merchantId !== config.parentMerchantId)
  )
    throw new Error('Parent response scope mismatch');
  return parsed;
}

export async function importParentRows(
  pool: Pool,
  config: ParentConfig,
  rows: ParentRow[],
) {
  const validated = z.array(parentRow).max(100).parse(rows);
  if (validated.some((row) => row.merchantId !== config.parentMerchantId))
    throw new Error('Parent response scope mismatch');
  await transaction(pool, async (c) => {
    const source = await c.query(
      'SELECT * FROM parent_sources WHERE id=$1 FOR UPDATE',
      [config.sourceId],
    );
    const s = source.rows[0];
    if (
      !s ||
      s.merchant_id !== config.merchantId ||
      s.parent_merchant_id !== config.parentMerchantId ||
      s.base_url !== new URL(config.baseUrl).origin
    )
      throw new Error('Parent source mapping mismatch');
    for (const row of validated) {
      const saved = await c.query(
        `INSERT INTO parent_transactions(id,source_id,parent_id,device_id,reference,amount_minor,currency,payment_status,announcement_status,parent_created_at,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT(source_id,parent_id) DO UPDATE SET
        device_id=EXCLUDED.device_id,reference=EXCLUDED.reference,amount_minor=EXCLUDED.amount_minor,payment_status=EXCLUDED.payment_status,
        announcement_status=EXCLUDED.announcement_status,observed_at=EXCLUDED.observed_at RETURNING id`,
        [
          randomUUID(),
          config.sourceId,
          row.id,
          row.deviceId,
          row.transactionReference,
          Math.round(row.amount * 100),
          row.currency,
          row.paymentStatus,
          row.announcementStatus,
          row.createdAt,
        ],
      );
      const resourceId = saved.rows[0].id;
      const problem =
        row.paymentStatus === 'SUCCESS' &&
        (row.announcementStatus === 'FAILED' ||
          (row.announcementStatus === 'PENDING' &&
            Date.now() - Date.parse(row.createdAt) > 30000));
      const current = await c.query(
        "SELECT id,status FROM incidents WHERE merchant_id=$1 AND kind='parent_publication_pending' AND resource_id=$2 FOR UPDATE",
        [config.merchantId, resourceId],
      );
      let incident = current.rows[0];
      if (problem && !incident) {
        const created = await c.query(
          "INSERT INTO incidents(id,merchant_id,kind,resource_id) VALUES($1,$2,'parent_publication_pending',$3) RETURNING id,status",
          [randomUUID(), config.merchantId, resourceId],
        );
        incident = created.rows[0];
        incident.fresh = true;
      }
      if (
        incident &&
        (incident.fresh || incident.status !== (problem ? 'open' : 'resolved'))
      ) {
        await c.query('UPDATE incidents SET status=$2 WHERE id=$1', [
          incident.id,
          problem ? 'open' : 'resolved',
        ]);
        await c.query(
          'INSERT INTO incident_evidence(id,incident_id,snapshot) VALUES($1,$2,$3)',
          [
            randomUUID(),
            incident.id,
            {
              schemaVersion: 1,
              parent: {
                paymentStatus: row.paymentStatus,
                announcementStatus: row.announcementStatus,
                createdAt: row.createdAt,
              },
            },
          ],
        );
      }
    }
  });
}

export async function syncParent(
  pool: Pool,
  input: ParentConfig,
  transport: typeof fetch = fetch,
) {
  const config = parentConfig.parse(input);
  // A session lock prevents overlapping collectors from applying stale pages out of order.
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (
      await lock.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1,728416232)) AS locked',
        [config.sourceId],
      )
    ).rows[0].locked;
    if (!locked) return { status: 'busy', imported: 0 };
    await pool.query(
      'INSERT INTO parent_sources(id,merchant_id,parent_merchant_id,base_url) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [
        config.sourceId,
        config.merchantId,
        config.parentMerchantId,
        new URL(config.baseUrl).origin,
      ],
    );
    const source = (
      await pool.query('SELECT * FROM parent_sources WHERE id=$1', [
        config.sourceId,
      ])
    ).rows[0];
    if (
      source.merchant_id !== config.merchantId ||
      source.parent_merchant_id !== config.parentMerchantId ||
      source.base_url !== new URL(config.baseUrl).origin
    )
      throw new Error('Parent source mapping mismatch');
    await pool.query(
      "UPDATE parent_sources SET last_attempt_at=now(),sync_status='syncing' WHERE id=$1",
      [config.sourceId],
    );
    let imported = 0;
    try {
      for (let page = 1; page <= 20; page++) {
        const result = await fetchParentPage(config, page, transport);
        await importParentRows(pool, config, result.items);
        imported += result.items.length;
        if (result.items.length < 100 || page * 100 >= result.total) {
          await pool.query(
            "UPDATE parent_sources SET last_success_at=now(),sync_status='ok' WHERE id=$1",
            [config.sourceId],
          );
          return { status: 'ok', imported };
        }
      }
      await pool.query(
        "UPDATE parent_sources SET sync_status='partial' WHERE id=$1",
        [config.sourceId],
      );
      return { status: 'partial', imported };
    } catch {
      await pool.query(
        "UPDATE parent_sources SET sync_status='error' WHERE id=$1",
        [config.sourceId],
      );
      throw new Error(
        'Parent synchronization failed; check connectivity, token validity and source mapping',
      );
    }
  } finally {
    if (locked)
      await lock.query(
        'SELECT pg_advisory_unlock(hashtextextended($1,728416232))',
        [config.sourceId],
      );
    lock.release();
  }
}
