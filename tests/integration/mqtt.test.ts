import { describe, it, expect } from 'vitest';
import mqtt, { type MqttClient, type IPublishPacket } from 'mqtt';
import { randomUUID } from 'node:crypto';
import { publish } from '../../apps/worker/dispatch.js';
const url = process.env.TEST_MQTT_URL;
function connected(client: MqttClient) {
  return new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
}
if (!url) throw new Error('TEST_MQTT_URL required; run npm run integration');
describe('Real Mosquitto authorization and QoS', () => {
  it('accepts authorized QoS1 commands without retaining them and denies foreign subscriptions', async () => {
    const device = '00000000-0000-4000-8000-000000000001';
    const subscriber = mqtt.connect(url, {
      username: device,
      password: 'test-device-password',
      protocolVersion: 5,
      clientId: 'acl-' + randomUUID(),
      reconnectPeriod: 0,
    });
    const worker = mqtt.connect(url, {
      username: 'worker',
      password: 'test-worker-password',
      protocolVersion: 5,
      clientId: 'acl-worker-' + randomUUID(),
      reconnectPeriod: 0,
    });
    try {
      await Promise.all([connected(subscriber), connected(worker)]);
      await subscriber.subscribeAsync(`devices/${device}/commands`, { qos: 1 });
      const delivery = new Promise<[string, Buffer, IPublishPacket]>(
        (resolve) =>
          subscriber.once('message', (topic, payload, packet) =>
            resolve([topic, payload, packet]),
          ),
      );
      await publish(
        worker,
        `devices/${device}/commands`,
        '{"test":true}',
        3000,
        5,
      );
      const [, payload, packet] = await delivery;
      expect(String(payload)).toBe('{"test":true}');
      expect(packet.retain).toBe(false);
      await subscriber.subscribeAsync('devices/foreign/commands', { qos: 1 });
      let leaked = false;
      subscriber.on('message', (topic) => {
        if (topic === 'devices/foreign/commands') leaked = true;
      });
      await publish(
        worker,
        'devices/foreign/commands',
        'foreign-secret',
        3000,
        5,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(leaked).toBe(false);
    } finally {
      await Promise.all([subscriber.endAsync(true), worker.endAsync(true)]);
    }
  });
  it('rejects anonymous clients', async () => {
    const client = mqtt.connect(url, {
      protocolVersion: 5,
      clientId: 'anonymous-' + randomUUID(),
      reconnectPeriod: 0,
    });
    try {
      const error = await new Promise<Error>((resolve) =>
        client.once('error', resolve),
      );
      expect(error).toBeInstanceOf(Error);
    } finally {
      await client.endAsync(true);
    }
  });
});
