import { getConfig } from '../../packages/config.js';
import { createPool } from '../../packages/database/index.js';
import { acceptPayment } from '../../apps/api/service.js';
const config = getConfig(),
  pool = createPool(config.DATABASE_URL);
try {
  await acceptPayment(
    pool,
    config,
    process.env.TEST_MERCHANT!,
    process.env.TEST_KEY!,
    {
      deviceId: config.DEVICE_ID,
      amountMinor: '9900',
      currency: 'INR',
      reference: 'Fault probe',
    },
  );
} finally {
  await pool.end();
}
