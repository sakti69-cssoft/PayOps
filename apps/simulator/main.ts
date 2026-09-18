import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from '../../packages/config.js';
import { commandSchema } from '../../packages/contracts/index.js';
import { signMessage } from '../../packages/security/index.js';
import { connectBroker } from '../../packages/mqtt.js';
import { log } from '../../packages/observability/index.js';
import { fault } from '../../packages/fault.js';
import { SimulatorStore } from './store.js';
const config = getConfig(),
  store = new SimulatorStore(config.SIMULATOR_DB),
  client = connectBroker(
    config.MQTT_URL,
    config.DEVICE_ID,
    config.MQTT_PASSWORD,
    `sim-${config.DEVICE_ID}`,
  );
let stopping = false,
  lastHeartbeat = 0;
client.on('connect', () => {
  void client.subscribeAsync(`devices/${config.DEVICE_ID}/commands`, {
    qos: 1,
  });
});
client.on('message', (_topic, buffer) => {
  try {
    const command = commandSchema.parse(JSON.parse(buffer.toString()));
    if (command.deviceId !== config.DEVICE_ID) throw new Error('wrong_device');
    fault(config, 'simulator-before-processing');
    store.process(command, config.DEVICE_KEY, config.DEVICE_VERSION, () =>
      fault(config, 'simulator-before-commit'),
    );
    fault(config, 'simulator-after-completion');
  } catch {
    log.warn({ event: 'simulator.command_rejected' });
  }
});
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, () => {
    stopping = true;
  });
while (!stopping) {
  for (const receipt of store.pending()) {
    try {
      const response = await fetch(config.API_URL + '/api/device-evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receipt),
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        fault(config, 'simulator-before-ack');
        store.acknowledge(receipt.commandId!);
      }
    } catch {
      log.warn({ event: 'simulator.receipt_retry' });
    }
  }
  if (Date.now() - lastHeartbeat > 5000) {
    const unsigned = {
      kind: 'heartbeat' as const,
      deviceId: config.DEVICE_ID,
      credentialVersion: config.DEVICE_VERSION,
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    try {
      await fetch(config.API_URL + '/api/device-evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...unsigned,
          signature: signMessage(unsigned, config.DEVICE_KEY),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      log.warn({ event: 'simulator.heartbeat_retry' });
    }
    lastHeartbeat = Date.now();
  }
  await sleep(500);
}
await client.endAsync();
store.close();
