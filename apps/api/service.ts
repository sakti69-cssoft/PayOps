import { randomUUID } from 'node:crypto';
import { type Pool, transaction } from '../../packages/database/index.js';
import {
  paymentInput,
  type SignedMessage,
} from '../../packages/contracts/index.js';
import { fingerprint, verifyMessage } from '../../packages/security/index.js';
import type { Config } from '../../packages/config.js';
import { fault } from '../../packages/fault.js';
import { latency } from '../../packages/observability/index.js';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function acceptPayment(
  pool: Pool,
  config: Config,
  merchantId: string,
  key: string,
  body: unknown,
) {
  const input = paymentInput.parse(body);
  const hash = fingerprint(input);
  const result = await transaction(pool, async (c) => {
    const device = await c.query(
      'SELECT id FROM devices WHERE id=$1 AND merchant_id=$2 AND NOT revoked FOR SHARE',
      [input.deviceId, merchantId],
    );
    if (!device.rowCount) throw new HttpError(404, 'Device not found');
    const id = randomUUID();
    const inserted = await c.query(
      'INSERT INTO payments(id,merchant_id,device_id,idempotency_key,fingerprint,amount_minor,currency,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(merchant_id,idempotency_key) DO NOTHING RETURNING *',
      [
        id,
        merchantId,
        input.deviceId,
        key,
        hash,
        input.amountMinor,
        input.currency,
        input.reference,
      ],
    );
    if (!inserted.rowCount) {
      const original = await c.query(
        'SELECT * FROM payments WHERE merchant_id=$1 AND idempotency_key=$2',
        [merchantId, key],
      );
      if (original.rows[0].fingerprint !== hash)
        throw new HttpError(
          409,
          'Idempotency key reused with a different payment',
        );
      return { payment: original.rows[0], duplicate: true };
    }
    const commandId = randomUUID();
    const expiresAt = new Date(
      Date.now() + config.COMMAND_TTL_MS,
    ).toISOString();
    await c.query(
      'INSERT INTO commands(id,merchant_id,payment_id,device_id,expires_at) VALUES($1,$2,$3,$4,$5)',
      [commandId, merchantId, id, input.deviceId, expiresAt],
    );
    await c.query(
      'INSERT INTO outbox(id,command_id,payload) VALUES($1,$2,$3)',
      [
        randomUUID(),
        commandId,
        {
          commandId,
          deviceId: input.deviceId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          expiresAt,
        },
      ],
    );
    fault(config, 'api-before-commit');
    return { payment: inserted.rows[0], duplicate: false };
  });
  fault(config, 'api-after-commit');
  return result;
}
export async function receiveEvidence(pool: Pool, message: SignedMessage) {
  return transaction(pool, async (c) => {
    const credential = await c.query(
      'SELECT k.secret FROM device_credentials k JOIN devices d ON d.id=k.device_id WHERE k.device_id=$1 AND k.version=$2 AND k.revoked_at IS NULL AND NOT d.revoked FOR SHARE OF k,d',
      [message.deviceId, message.credentialVersion],
    );
    if (
      !credential.rowCount ||
      !verifyMessage(message, credential.rows[0].secret)
    )
      throw new HttpError(401, 'Invalid device credentials');
    const hash = fingerprint(message);
    const previous = await c.query(
      'SELECT fingerprint FROM device_messages WHERE device_id=$1 AND message_id=$2',
      [message.deviceId, message.messageId],
    );
    if (previous.rowCount) {
      if (previous.rows[0].fingerprint !== hash)
        throw new HttpError(409, 'Conflicting message identity');
      return { acknowledged: true, duplicate: true };
    }
    const timestamp = new Date(message.timestamp).getTime();
    if (
      timestamp > Date.now() + 120000 ||
      (message.kind === 'heartbeat' && timestamp < Date.now() - 120000)
    )
      throw new HttpError(422, 'Timestamp outside allowed window');
    const inserted = await c.query(
      'INSERT INTO device_messages(device_id,message_id,fingerprint,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id',
      [message.deviceId, message.messageId, hash, message.kind],
    );
    if (!inserted.rowCount) {
      const row = await c.query(
        'SELECT fingerprint FROM device_messages WHERE device_id=$1 AND message_id=$2',
        [message.deviceId, message.messageId],
      );
      if (row.rows[0].fingerprint !== hash)
        throw new HttpError(409, 'Conflicting message identity');
      return { acknowledged: true, duplicate: true };
    }
    if (message.kind === 'heartbeat') {
      await c.query(
        'UPDATE devices SET last_heartbeat=GREATEST(COALESCE(last_heartbeat,$2::timestamptz),$2::timestamptz) WHERE id=$1',
        [message.deviceId, message.timestamp],
      );
    } else {
      const command = await c.query(
        'SELECT c.*,p.accepted_at FROM commands c JOIN payments p ON p.id=c.payment_id WHERE c.id=$1 AND c.device_id=$2 FOR UPDATE OF c',
        [message.commandId, message.deviceId],
      );
      if (!command.rowCount) throw new HttpError(404, 'Command not found');
      const row = command.rows[0];
      if (timestamp < new Date(row.accepted_at).getTime() - 120000)
        throw new HttpError(422, 'Receipt predates payment');
      const lateEffect =
        message.result === 'completed' &&
        timestamp > new Date(row.expires_at).getTime();
      const conflicting =
        lateEffect ||
        (row.state === 'completed' && message.result !== 'completed') ||
        (row.state === 'expired' && message.result === 'completed');
      await c.query(
        'INSERT INTO receipts(id,device_id,command_id,credential_version,result,device_timestamp,fingerprint,conflicting) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          message.messageId,
          message.deviceId,
          message.commandId,
          message.credentialVersion,
          message.result,
          message.timestamp,
          hash,
          conflicting,
        ],
      );
      if (message.result === 'completed' && !lateEffect) {
        await c.query(
          "UPDATE commands SET state='completed',completed_at=COALESCE(completed_at,now()) WHERE id=$1",
          [message.commandId],
        );
        if (row.state !== 'completed')
          latency.observe(
            (Date.now() - new Date(row.accepted_at).getTime()) / 1000,
          );
      } else if (row.state !== 'completed')
        await c.query('UPDATE commands SET state=$2 WHERE id=$1', [
          message.commandId,
          lateEffect ? 'unknown' : 'expired',
        ]);
    }
    return { acknowledged: true, duplicate: false };
  });
}
export async function replay(
  pool: Pool,
  merchantId: string,
  userId: string,
  commandId: string,
) {
  return transaction(pool, async (c) => {
    const result = await c.query(
      'SELECT c.*,o.status FROM commands c JOIN outbox o ON o.command_id=c.id WHERE c.id=$1 AND c.merchant_id=$2 FOR UPDATE OF c,o',
      [commandId, merchantId],
    );
    if (!result.rowCount) throw new HttpError(404, 'Announcement not found');
    const row = result.rows[0];
    if (
      row.state === 'completed' ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      !['exhausted', 'permanent', 'published'].includes(row.status)
    )
      throw new HttpError(
        409,
        'Only uncompleted, unexpired terminal dispatches can be replayed',
      );
    await c.query(
      "UPDATE outbox SET status='pending',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE command_id=$1",
      [commandId],
    );
    await c.query(
      "INSERT INTO audit_events(merchant_id,user_id,action,resource_id) VALUES($1,$2,'announcement.replay',$3)",
      [merchantId, userId, commandId],
    );
    return { commandId, replayed: true };
  });
}
