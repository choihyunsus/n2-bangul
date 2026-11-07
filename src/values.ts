// Validate bounded UTF-8 task data before model calls, JSON persistence and delivery.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export function utf8(maximum: number) {
  return z
    .string()
    .max(maximum)
    .refine(
      (value) =>
        !value.includes('\0') &&
        Buffer.byteLength(value) <= maximum &&
        Buffer.from(value).toString('utf8') === value,
      'Expected bounded, well-formed UTF-8 text',
    );
}
export const identity = utf8(128)
  .min(1)
  .regex(/^[^\s\p{Cc}]+$/u);
export const line = (maximum: number) =>
  utf8(maximum).refine(
    (value) => !!value.trim() && !/\p{Cc}/u.test(value),
    'Expected nonempty single-line text',
  );
export const timestamp = z.int().min(0).max(253402300799999);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function encode(value: unknown, maximum = 262144): string {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum)
    throw new Error('JSON exceeds its byte limit');
  return text;
}
export function parseJson(value: unknown, maximum = 262144): unknown {
  return JSON.parse(utf8(maximum).parse(value));
}
