import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(secret: string, data: Buffer | string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Constant-time compare. `===` stops at the first difference, so its timing
 * tells an attacker how much of a forged signature was right.
 */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
