import { randomUUID } from 'node:crypto';
import { recentLatency } from '../../packages/observability/index.js';
import { transaction, type Pool } from '../../packages/database/index.js';
import {
  backlog,
  oldest,
  retries,
  missing,
  offline,
} from '../../packages/observability/index.js';
export async function reconcile(pool: Pool) {
  await transaction(pool, async (c) => {
    const lock = await c.query(
      'SELECT pg_try_advisory_xact_lock(728416231) AS locked',
    );
    if (!lock.rows[0].locked) return;
    await c.query(
      "UPDATE commands SET state='expired' WHERE id IN (SELECT id FROM commands WHERE expires_at<now() AND state IN ('pending','published') ORDER BY expires_at LIMIT 100)",
    );
    const problems = await c.query(`
    SELECT c.merchant_id,c.id AS resource_id,CASE WHEN o.status='exhausted' THEN 'retry_exhausted' WHEN o.status='permanent' THEN 'poison_command' WHEN o.status IN ('pending','leased') THEN 'old_pending' ELSE 'missing_receipt' END AS kind
    FROM outbox o JOIN commands c ON c.id=o.command_id WHERE c.state<>'completed' AND (o.status IN ('exhausted','permanent') OR (o.status IN ('pending','leased') AND o.created_at<now()-interval '15 seconds') OR (c.published_at<now()-interval '15 seconds'))
    UNION ALL SELECT merchant_id,id,'offline_device' FROM devices WHERE NOT revoked AND (last_heartbeat IS NULL OR last_heartbeat<now()-interval '30 seconds')
    UNION ALL SELECT c.merchant_id,c.id,'conflicting_receipt' FROM receipts r JOIN commands c ON c.id=r.command_id WHERE r.conflicting
    UNION ALL SELECT merchant_id,resource_id,'device_auth_failures' FROM audit_events WHERE action='device.auth.failure' AND created_at>now()-interval '5 minutes' GROUP BY merchant_id,resource_id HAVING count(*)>=5
    UNION ALL SELECT id,id,'authentication_failures' FROM merchants WHERE (SELECT count(*) FROM audit_events WHERE action='auth.failure' AND created_at>now()-interval '5 minutes')>=10
    UNION ALL SELECT id,id,'dependency_failure' FROM merchants WHERE EXISTS(SELECT 1 FROM worker_status WHERE disconnected_since<now()-interval '15 seconds' OR progressed_at<now()-interval '30 seconds')
    LIMIT 100`);
    for (const p of problems.rows) {
      const id = randomUUID();
      const inserted = await c.query(
        'INSERT INTO incidents(id,merchant_id,kind,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
        [id, p.merchant_id, p.kind, p.resource_id],
      );
      if (!inserted.rowCount) continue;
      const command = await c.query(
        'SELECT id,state,expires_at,published_at,completed_at,device_id,payment_id FROM commands WHERE id=$1 AND merchant_id=$2',
        [p.resource_id, p.merchant_id],
      );
      const attempts = await c.query(
        'SELECT a.id,a.started_at,a.ended_at,a.outcome,a.error FROM delivery_attempts a JOIN outbox o ON o.id=a.outbox_id WHERE o.command_id=$1 ORDER BY a.id DESC LIMIT 20',
        [p.resource_id],
      );
      const receipts = await c.query(
        'SELECT id,result,conflicting,received_at FROM receipts WHERE command_id=$1 ORDER BY received_at DESC LIMIT 20',
        [p.resource_id],
      );
      const devices = await c.query(
        'SELECT id,name,last_heartbeat,revoked FROM devices WHERE merchant_id=$1 AND (id=$2 OR id=$3)',
        [p.merchant_id, p.resource_id, command.rows[0]?.device_id ?? null],
      );
      await c.query(
        'INSERT INTO incident_evidence(id,incident_id,snapshot) VALUES($1,$2,$3)',
        [
          randomUUID(),
          id,
          {
            schemaVersion: 1,
            capturedAt: new Date().toISOString(),
            kind: p.kind,
            resourceId: p.resource_id,
            command: command.rows[0] ?? null,
            attempts: attempts.rows,
            receipts: receipts.rows,
            devices: devices.rows,
          },
        ],
      );
    }
    // Redeliver missing receipts using the same command. A late publisher is harmless to device deduplication.
    await c.query(
      "UPDATE outbox SET status='pending',next_attempt_at=now() WHERE id IN (SELECT o.id FROM outbox o JOIN commands c ON c.id=o.command_id WHERE o.status='published' AND c.state<>'completed' AND c.expires_at>now() AND o.next_attempt_at<now()-interval '10 seconds' ORDER BY o.created_at LIMIT 100)",
    );
    // Heartbeat replay tombstones can expire beyond the skew window; receipts never do.
    await c.query(
      "DELETE FROM device_messages WHERE (device_id,message_id) IN (SELECT device_id,message_id FROM device_messages WHERE kind='heartbeat' AND received_at<now()-interval '1 day' LIMIT 500)",
    );
  });
  const stats = await pool.query(
    `SELECT (SELECT count(*) FROM outbox WHERE status IN ('pending','leased')) AS backlog,(SELECT COALESCE(EXTRACT(epoch FROM now()-min(created_at)),0) FROM outbox WHERE status IN ('pending','leased')) AS oldest,(SELECT count(*) FROM delivery_attempts WHERE outcome='retry') AS retries,(SELECT count(*) FROM commands WHERE published_at IS NOT NULL AND state<>'completed') AS missing,(SELECT count(*) FROM devices WHERE last_heartbeat IS NULL OR last_heartbeat<now()-interval '30 seconds') AS offline`,
  );
  const s = stats.rows[0];
  backlog.set(Number(s.backlog));
  oldest.set(Number(s.oldest));
  retries.set(Number(s.retries));
  missing.set(Number(s.missing));
  offline.set(Number(s.offline));
  const deliveries = await pool.query(
    `SELECT COALESCE(avg(seconds),0) AS mean FROM (SELECT EXTRACT(epoch FROM c.completed_at-p.accepted_at) AS seconds FROM commands c JOIN payments p ON p.id=c.payment_id WHERE c.state='completed' ORDER BY c.completed_at DESC LIMIT 1000) recent`,
  );
  recentLatency.set(Number(deliveries.rows[0].mean));
}
