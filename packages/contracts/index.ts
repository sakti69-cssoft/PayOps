import { z } from 'zod';
export const paymentInput = z
  .object({
    deviceId: z.uuid(),
    amountMinor: z.string().regex(/^[1-9][0-9]{0,11}$/),
    currency: z.enum(['INR', 'USD', 'EUR']),
    reference: z.string().trim().min(1).max(120),
  })
  .strict();
export const commandSchema = z
  .object({
    commandId: z.uuid(),
    deviceId: z.uuid(),
    amountMinor: z.string().regex(/^[1-9][0-9]{0,11}$/),
    currency: z.enum(['INR', 'USD', 'EUR']),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const evidenceMessage = z
  .object({
    kind: z.enum(['receipt', 'heartbeat']),
    deviceId: z.uuid(),
    credentialVersion: z.number().int().positive(),
    messageId: z.uuid(),
    timestamp: z.iso.datetime(),
    commandId: z.uuid().optional(),
    result: z.enum(['completed', 'expired']).optional(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.kind === 'receipt' && (!m.commandId || !m.result))
      ctx.addIssue({
        code: 'custom',
        message: 'Receipt needs command and result',
      });
    if (m.kind === 'heartbeat' && (m.commandId || m.result))
      ctx.addIssue({
        code: 'custom',
        message: 'Heartbeat cannot contain a result',
      });
  });
export type SignedMessage = z.infer<typeof evidenceMessage>;
export type Command = z.infer<typeof commandSchema>;
export type Role = 'reader' | 'operator' | 'merchant-admin';
export const transitions = {
  pending: ['published', 'completed', 'expired', 'unknown'],
  published: ['completed', 'expired', 'unknown'],
  unknown: ['completed', 'expired'],
  expired: ['completed'],
  completed: [],
} as const;
export function canTransition(from: keyof typeof transitions, to: string) {
  return (transitions[from] as readonly string[]).includes(to);
}
export function retryDelay(attempt: number, random = Math.random) {
  return Math.floor(
    Math.min(30000, 500 * 2 ** Math.min(attempt, 10)) * (0.5 + random() / 2),
  );
}
