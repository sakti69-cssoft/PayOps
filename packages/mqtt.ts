import mqtt from 'mqtt';
import { log } from './observability/index.js';
export function connectBroker(
  url: string,
  username: string,
  password: string,
  id: string,
) {
  const client = mqtt.connect(url, {
    username,
    password,
    clientId: id,
    protocolVersion: 5,
    clean: false,
    properties: { sessionExpiryInterval: 300 },
    reconnectPeriod: 1000,
    connectTimeout: 4000,
    queueQoSZero: false,
  });
  client.on('error', () => log.warn({ event: 'mqtt.connection_error' }));
  client.on('reconnect', () => {
    client.options.reconnectPeriod =
      Math.min(30000, (client.options.reconnectPeriod ?? 1000) * 1.5) *
      (0.75 + Math.random() / 4);
  });
  client.on('connect', () => {
    client.options.reconnectPeriod = 1000;
  });
  return client;
}
