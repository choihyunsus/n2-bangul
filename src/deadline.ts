// Bounded host calls propagate cancellation and discard late, uncooperative callback results.
import { z } from 'zod';
export class DeadlineExceeded extends Error {}
export async function deadline<T>(
  parent: AbortSignal,
  milliseconds: number,
  operation: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  z.int().min(1).max(3600000).parse(milliseconds);
  parent.throwIfAborted();
  const controller = new AbortController(),
    signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new DeadlineExceeded('Host operation deadline exceeded')),
    milliseconds,
  );
  let listener: () => void = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    });
    const result = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation(signal);
      }),
      aborted,
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', listener);
    controller.abort(new Error('Host invocation ended'));
  }
}
