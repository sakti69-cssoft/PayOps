import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  canonical,
  fingerprint,
  signMessage,
  verifyMessage,
  hashPassword,
  checkPassword,
  issueToken,
  verifyToken,
} from '../../packages/security/index.js';
import {
  commandSchema,
  evidenceMessage,
  canTransition,
  retryDelay,
} from '../../packages/contracts/index.js';
describe('Security and contracts', () => {
  it('uses stable recursive canonicalization and semantic fingerprints', () => {
    expect(canonical({ b: 2, a: { z: 1, b: 2 } })).toBe(
      '{"a":{"b":2,"z":1},"b":2}',
    );
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
  });
  it('rejects tampering, wrong keys and malformed signatures', () => {
    const payload = {
      kind: 'heartbeat' as const,
      deviceId: randomUUID(),
      messageId: randomUUID(),
      credentialVersion: 1,
      timestamp: new Date().toISOString(),
    };
    const m = { ...payload, signature: signMessage(payload, 'secret') };
    expect(verifyMessage(m, 'secret')).toBe(true);
    expect(verifyMessage({ ...m, credentialVersion: 2 }, 'secret')).toBe(false);
    expect(verifyMessage(m, 'wrong')).toBe(false);
    expect(verifyMessage({ ...m, signature: 'aa' }, 'secret')).toBe(false);
  });
  it('hashes salted passwords and rejects incorrect passwords', async () => {
    const a = await hashPassword('test-password'),
      b = await hashPassword('test-password');
    expect(a).not.toBe(b);
    expect(await checkPassword('test-password', a)).toBe(true);
    expect(await checkPassword('wrong', a)).toBe(false);
  });
  it('validates JWT signature and subject', async () => {
    const id = randomUUID(),
      secret = 'x'.repeat(40);
    const token = await issueToken(id, secret);
    expect(await verifyToken(token, secret)).toBe(id);
    await expect(verifyToken(token, 'y'.repeat(40))).rejects.toThrow();
  });
  it('rejects invalid amounts, receipt shapes and unexpected command fields', () => {
    expect(
      commandSchema.safeParse({
        commandId: randomUUID(),
        deviceId: randomUUID(),
        amountMinor: '0.5',
        currency: 'INR',
        expiresAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
    expect(
      evidenceMessage.safeParse({
        kind: 'receipt',
        deviceId: randomUUID(),
        messageId: randomUUID(),
        credentialVersion: 1,
        timestamp: new Date().toISOString(),
        signature: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });
  it('never regresses completed state and bounds retry jitter', () => {
    expect(canTransition('completed', 'published')).toBe(false);
    expect(canTransition('pending', 'completed')).toBe(true);
    for (let i = 0; i < 100; i++) {
      expect(retryDelay(i, () => 1)).toBeLessThanOrEqual(30000);
      expect(retryDelay(i, () => 0)).toBeGreaterThan(0);
    }
  });
});
