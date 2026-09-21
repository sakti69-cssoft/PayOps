import { createPool } from '../packages/database/index.js';
import {
  parentConfig,
  syncParent,
} from '../packages/parent-monitoring/index.js';
const config = parentConfig.parse({
  sourceId: process.env.PARENT_SOURCE_ID ?? 'soundbox-parent',
  merchantId: process.env.PAYOPS_MERCHANT_ID,
  parentMerchantId: process.env.PARENT_MERCHANT_ID,
  baseUrl: process.env.PARENT_API_URL,
  token: process.env.PARENT_API_TOKEN,
});
const pool = createPool(process.env.DATABASE_URL!);
let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});
try {
  do {
    try {
      const result = await syncParent(pool, config);
      console.log(JSON.stringify(result));
      if (process.argv.includes('--once') && result.status !== 'ok')
        process.exitCode = 1;
    } catch {
      console.error(
        'Parent sync failed. Existing observations remain available. Check source configuration and credentials.',
      );
      if (process.argv.includes('--once')) process.exitCode = 1;
    }
    if (process.argv.includes('--once') || stopped) break;
    for (let i = 0; i < 15 && !stopped; i++)
      await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!stopped);
} finally {
  await pool.end();
}
