import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import type { SignedMessage } from '../contracts/index.js';
const scrypt = promisify(scryptCallback);
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
      .join(',') +
    '}'
  );
}
export function fingerprint(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function signMessage(
  value: Omit<SignedMessage, 'signature'>,
  key: string,
) {
  return createHmac('sha256', key)
    .update('payops:evidence:v1\n' + canonical(value))
    .digest('hex');
}
export function verifyMessage(value: SignedMessage, key: string) {
  const { signature, ...payload } = value;
  const expected = Buffer.from(signMessage(payload, key), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password: string, stored: string) {
  const [, salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export async function issueToken(userId: string, secret: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('payops')
    .setAudience('payops-api')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}
export async function verifyToken(token: string, secret: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    issuer: 'payops',
    audience: 'payops-api',
    requiredClaims: ['sub', 'iat', 'exp'],
    maxTokenAge: '1h',
  });
  if (
    !payload.sub ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.sub,
    )
  )
    throw new Error('Invalid token subject');
  return payload.sub;
}
