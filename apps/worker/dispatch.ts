import { randomUUID } from 'node:crypto';
import type { MqttClient } from 'mqtt';
import { transaction, type Pool } from '../../packages/database/index.js';
import { commandSchema, retryDelay } from '../../packages/contracts/index.js';
import type { Config } from '../../packages/config.js';
import { fault } from '../../packages/fault.js';
export interface Claim {
  id: string;
  command_id: string;
  lease_token: string;
  payload: unknown;
  attempts: number;
}
export async function claim(
  pool: Pool,
  config: Config,
): Promise<Claim | undefined> {
  return transaction(pool, async (c) => {
    const row = await c.query(
      "SELECT * FROM outbox WHERE (status='pending' AND next_attempt_at<=now()) OR (status='leased' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!row.rowCount) return;
    const item = row.rows[0];
    if (item.lease_token)
      await c.query(
        "UPDATE delivery_attempts SET outcome='lease_expired',ended_at=now() WHERE lease_token=$1 AND outcome='claimed'",
        [item.lease_token],
      );
    if (item.attempts >= config.MAX_ATTEMPTS) {
      await c.query(
        "UPDATE outbox SET status='exhausted',lease_token=NULL,lease_until=NULL WHERE id=$1",
        [item.id],
      );
      await c.query(
        "UPDATE commands SET state='unknown' WHERE id=$1 AND state IN ('pending','published')",
        [item.command_id],
      );
      return;
    }
    const token = randomUUID();
    const updated = await c.query(
      "UPDATE outbox SET status='leased',lease_token=$2,owner=$3,lease_until=now()+$4*interval '1 millisecond',attempts=attempts+1 WHERE id=$1 RETURNING *",
      [item.id, token, config.WORKER_ID, config.LEASE_MS],
    );
    await c.query(
      'INSERT INTO delivery_attempts(outbox_id,lease_token,owner) VALUES($1,$2,$3)',
      [item.id, token, config.WORKER_ID],
    );
    return updated.rows[0] as Claim;
  });
}
export async function finish(
  pool: Pool,
  config: Config,
  item: Claim,
  outcome: 'published' | 'retry' | 'permanent' | 'expired',
  error?: string,
) {
  return transaction(pool, async (c) => {
    const status =
      outcome === 'retry'
        ? item.attempts >= config.MAX_ATTEMPTS
          ? 'exhausted'
          : 'pending'
        : outcome;
    const updated = await c.query(
      "UPDATE outbox SET status=$3,lease_until=NULL,lease_token=NULL,last_error=$4,next_attempt_at=now()+$5*interval '1 millisecond' WHERE id=$1 AND lease_token=$2 AND status='leased' AND lease_until>now() RETURNING command_id",
      [
        item.id,
        item.lease_token,
        status,
        error ?? null,
        retryDelay(item.attempts),
      ],
    );
    if (!updated.rowCount) return false;
    await c.query(
      'UPDATE delivery_attempts SET outcome=$2,error=$3,ended_at=now() WHERE lease_token=$1',
      [item.lease_token, outcome, error ?? null],
    );
    if (outcome === 'published')
      await c.query(
        "UPDATE commands SET published_at=COALESCE(published_at,now()),state=CASE WHEN state='pending' THEN 'published' ELSE state END WHERE id=$1",
        [item.command_id],
      );
    if (outcome === 'expired')
      await c.query(
        "UPDATE commands SET state='expired' WHERE id=$1 AND state IN ('pending','published')",
        [item.command_id],
      );
    if (status === 'exhausted')
      await c.query(
        "UPDATE commands SET state='unknown' WHERE id=$1 AND state IN ('pending','published')",
        [item.command_id],
      );
    return true;
  });
}
export function publish(
  client: MqttClient,
  topic: string,
  payload: string,
  timeoutMs: number,
  ttl: number,
) {
  return new Promise<void>((resolve, reject) => {
    if (!client.connected) {
      reject(new Error('broker_unavailable'));
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('publish_timeout')),
      timeoutMs,
    );
    client.publish(
      topic,
      payload,
      { qos: 1, retain: false, properties: { messageExpiryInterval: ttl } },
      (err) => {
        clearTimeout(timer);
        if (err) reject(new Error('publish_failed'));
        else resolve();
      },
    );
  });
}
export async function dispatch(
  pool: Pool,
  config: Config,
  client: MqttClient,
  item: Claim,
) {
  fault(config, 'worker-after-claim');
  const parsed = commandSchema.safeParse(item.payload);
  if (!parsed.success || parsed.data.commandId !== item.command_id) {
    await finish(pool, config, item, 'permanent', 'invalid_command');
    return;
  }
  const command = parsed.data;
  const ttl = Math.floor(
    (new Date(command.expiresAt).getTime() - Date.now()) / 1000,
  );
  if (ttl <= 0) {
    await finish(pool, config, item, 'expired');
    return;
  }
  try {
    await publish(
      client,
      `devices/${command.deviceId}/commands`,
      JSON.stringify(command),
      config.PUBLISH_TIMEOUT_MS,
      ttl,
    );
    fault(config, 'worker-after-publish');
    await finish(pool, config, item, 'published');
  } catch (e) {
    await finish(
      pool,
      config,
      item,
      'retry',
      e instanceof Error ? e.message : 'publish_failed',
    );
  }
}
