import { z } from 'zod';
export const configSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://'),
  JWT_SECRET: z.string().min(32),
  MQTT_URL: z.url().default('mqtt://localhost:1883'),
  MQTT_USERNAME: z.string().min(1).default('worker'),
  MQTT_PASSWORD: z.string().min(16),
  WORKER_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('worker-1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LEASE_MS: z.coerce.number().int().min(1000).default(15000),
  PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).default(4000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  COMMAND_TTL_MS: z.coerce.number().int().min(5000).default(300000),
  DEVICE_ID: z.uuid().default('00000000-0000-4000-8000-000000000001'),
  DEVICE_KEY: z.string().min(32),
  DEVICE_VERSION: z.coerce.number().int().positive().default(1),
  SIMULATOR_DB: z.string().default('.runtime/simulator.db'),
  API_URL: z.url().default('http://localhost:3000'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  GENAI_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  GENAI_API_KEY: z.string().optional(),
  GENAI_MODEL: z.string().default('gpt-4.1-mini'),
  FAULT_POINT: z.string().optional(),
  FAULT_TEST: z.enum(['0', '1']).default('0'),
});
export type Config = z.infer<typeof configSchema>;
export function getConfig(): Config {
  const c = configSchema.parse(process.env);
  if (c.GENAI_PROVIDER === 'openai' && !c.GENAI_API_KEY)
    throw new Error('GENAI_API_KEY required');
  if (c.NODE_ENV === 'production' && c.FAULT_TEST === '1')
    throw new Error('Fault injection forbidden in production');
  return c;
}
