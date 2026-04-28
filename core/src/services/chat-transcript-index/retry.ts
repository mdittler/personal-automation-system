import type { RetryOpts } from './types.js';

function isBusy(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
  }
  return false;
}

function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function withSqliteRetry<T>(
  fn: () => T,
  opts: RetryOpts = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 15;
  const minJitterMs = opts.minJitterMs ?? 20;
  const maxJitterMs = opts.maxJitterMs ?? 150;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err) || attempt === maxAttempts) throw err;
      lastErr = err;
      const delay = jitter(minJitterMs, maxJitterMs);
      await new Promise<void>((res) => setTimeout(res, delay));
    }
  }
}
