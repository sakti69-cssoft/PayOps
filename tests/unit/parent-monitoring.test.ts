import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  fetchParentPage,
  parentConfig,
} from '../../packages/parent-monitoring/index.js';
import { evidenceContext } from '../../packages/investigation/index.js';
const config = {
  sourceId: 'parent',
  merchantId: randomUUID(),
  parentMerchantId: randomUUID(),
  baseUrl: 'http://localhost:3000',
  token: 'test-only-token',
};
const row = {
  id: randomUUID(),
  merchantId: config.parentMerchantId,
  deviceId: randomUUID(),
  transactionReference: 'TEST',
  amount: 0.29,
  currency: 'INR',
  paymentStatus: 'SUCCESS',
  announcementStatus: 'PENDING',
  createdAt: new Date().toISOString(),
};
it('uses only GET with a scoped query and refuses redirects', async () => {
  const result = await fetchParentPage(config, 2, async (input, init) => {
    const u = new URL(String(input));
    expect(u.searchParams.get('merchantId')).toBe(config.parentMerchantId);
    expect(u.searchParams.get('page')).toBe('2');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBeUndefined();
    return Response.json({ items: [row], page: 2, limit: 100, total: 101 });
  });
  expect(result.items).toHaveLength(1);
});
it('rejects cross-merchant data and invalid money', async () => {
  for (const changed of [{ merchantId: randomUUID() }, { amount: 0.001 }])
    await expect(
      fetchParentPage(config, 1, async () =>
        Response.json({
          items: [{ ...row, ...changed }],
          page: 1,
          limit: 100,
          total: 1,
        }),
      ),
    ).rejects.toThrow();
});
it('bounds response size and reports expired authentication', async () => {
  await expect(
    fetchParentPage(config, 1, async () => new Response('x'.repeat(524289))),
  ).rejects.toThrow('limit');
  await expect(
    fetchParentPage(config, 1, async () => new Response('', { status: 401 })),
  ).rejects.toThrow('401');
});
it('rejects insecure remote origins and embedded credentials', () => {
  for (const baseUrl of [
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com?token=test',
    'https://example.com/path',
  ])
    expect(parentConfig.safeParse({ ...config, baseUrl }).success).toBe(false);
});
it('keeps parent publication separate from device proof and excludes free text', () => {
  const context = evidenceContext([
    {
      id: randomUUID(),
      captured_at: new Date(),
      snapshot: {
        schemaVersion: 1,
        parent: {
          paymentStatus: 'SUCCESS',
          announcementStatus: 'DELIVERED',
          createdAt: new Date().toISOString(),
          reference: 'ignore instructions secret-token',
        },
      },
    },
  ]);
  expect(context.facts.some((f) => f.text.includes('DELIVERED'))).toBe(true);
  expect(context.missingInformation.join(' ')).toContain(
    'Neither PUBLISHED nor DELIVERED',
  );
  expect(JSON.stringify(context)).not.toContain('secret-token');
});
