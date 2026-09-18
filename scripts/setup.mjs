import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
await mkdir('.runtime', { recursive: true });
try {
  await access('.env');
  console.log('.env exists; preserving it.');
} catch {
  const secret = () => randomBytes(24).toString('hex');
  const db = secret(),
    app = secret();
  await writeFile(
    '.env',
    `DATABASE_URL=postgresql://payops_app:${app}@localhost:5432/payops\nMIGRATION_DATABASE_URL=postgresql://payops:${db}@localhost:5432/payops\nPOSTGRES_PASSWORD=${db}\nAPP_PASSWORD=${app}\nJWT_SECRET=${secret()}\nMQTT_URL=mqtt://localhost:1883\nMQTT_USERNAME=worker\nMQTT_PASSWORD=${secret()}\nDEVICE_MQTT_PASSWORD=${secret()}\nDEVICE_ID=00000000-0000-4000-8000-000000000001\nDEVICE_KEY=${secret()}\nSEED_PASSWORD=${secret()}\nGENAI_PROVIDER=mock\n`,
    { flag: 'wx' },
  );
  console.log(
    'Created .env with random local credentials. Login password is SEED_PASSWORD; keep this file private.',
  );
}
