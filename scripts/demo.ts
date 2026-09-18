import { randomUUID } from 'node:crypto';
import { until } from './process.js';
const url = process.env.API_URL ?? 'http://localhost:3000';
async function post(path: string, body: unknown, token?: string, key?: string) {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const login = await post('/api/login', {
  email: 'admin@cedar.test',
  password: process.env.SEED_PASSWORD,
});
const merchant = '10000000-0000-4000-8000-000000000001';
const key = randomUUID();
const body = {
  deviceId: process.env.DEVICE_ID ?? '00000000-0000-4000-8000-000000000001',
  amountMinor: '12900',
  currency: 'INR',
  reference: 'Synthetic demonstration',
};
const accepted = await post(
  `/api/merchants/${merchant}/payments`,
  body,
  login.token,
  key,
);
console.log(`Accepted synthetic payment ${accepted.payment.id}; key ${key}.`);
const replay = await post(
  `/api/merchants/${merchant}/payments`,
  body,
  login.token,
  key,
);
if (accepted.payment.id !== replay.payment.id)
  throw new Error('Duplicate payment invariant violated');
const duration = await until(async () => {
  const response = await fetch(
    `${url}/api/merchants/${merchant}/payments/${accepted.payment.id}`,
    {
      headers: { Authorization: `Bearer ${login.token}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) return false;
  const detail = await response.json();
  console.log(
    `Dispatch observation: ${detail.state}; broker acknowledged: ${Boolean(detail.published_at)}; verified receipts: ${detail.receipts.length}`,
  );
  return detail.state === 'completed';
}, 60000);
console.log(
  `Verified synthetic completion after ${duration}ms. Run the isolated fault suite for broker interruption; investigation remains gated on reliability verification.`,
);
