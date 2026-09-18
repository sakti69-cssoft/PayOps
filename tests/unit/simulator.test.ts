import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SimulatorStore } from '../../apps/simulator/store.js';
import { verifyMessage } from '../../packages/security/index.js';
const command = () => ({
  commandId: randomUUID(),
  deviceId: randomUUID(),
  amountMinor: '12500',
  currency: 'INR' as const,
  expiresAt: new Date(Date.now() + 30000).toISOString(),
});
describe('Durable synthetic simulator', () => {
  it('keeps one effect and the original signed receipt across restart and redelivery', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'payops-unit-')), 'sim.db'),
      c = command();
    let store = new SimulatorStore(path);
    const first = store.process(c, 'secret', 1);
    store.close();
    store = new SimulatorStore(path);
    expect(store.process(c, 'rotated', 2)).toEqual(first);
    expect(verifyMessage(first, 'secret')).toBe(true);
    expect(
      store.db.prepare('SELECT sum(effect_count) AS n FROM inbox').get()?.n,
    ).toBe(1);
    expect(store.pending()).toHaveLength(1);
    store.acknowledge(c.commandId);
    expect(store.pending()).toHaveLength(0);
    store.process(c, 'secret', 1);
    expect(store.pending()).toHaveLength(1);
    store.close();
  });
  it('rolls back effect, inbox and evidence together before commit', () => {
    const store = new SimulatorStore(':memory:'),
      c = command();
    expect(() =>
      store.process(c, 'secret', 1, () => {
        throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(store.pending()).toHaveLength(0);
    store.process(c, 'secret', 1);
    expect(
      store.db.prepare('SELECT sum(effect_count) AS n FROM inbox').get()?.n,
    ).toBe(1);
    store.close();
  });
  it('does not apply expired commands and rejects conflicting duplicates', () => {
    const store = new SimulatorStore(':memory:'),
      c = {
        ...command(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
    expect(store.process(c, 'secret', 1).result).toBe('expired');
    expect(
      store.db.prepare('SELECT sum(effect_count) AS n FROM inbox').get()?.n,
    ).toBe(0);
    expect(() =>
      store.process({ ...c, amountMinor: '9' }, 'secret', 1),
    ).toThrow('conflicting_command');
    store.close();
  });
});
