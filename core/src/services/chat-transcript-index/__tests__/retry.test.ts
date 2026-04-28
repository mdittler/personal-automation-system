import { describe, it, expect, vi } from 'vitest';
import { withSqliteRetry } from '../retry.js';

describe('withSqliteRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockReturnValue('ok');
    const result = await withSqliteRetry(fn, { maxAttempts: 3, minJitterMs: 0, maxJitterMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on SQLITE_BUSY and succeeds eventually', async () => {
    let calls = 0;
    const busyErr = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn(() => {
      calls++;
      if (calls < 3) throw busyErr;
      return 'ok';
    });
    const result = await withSqliteRetry(fn, { maxAttempts: 5, minJitterMs: 0, maxJitterMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts and rethrows BUSY', async () => {
    const busyErr = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    const fn = vi.fn(() => { throw busyErr; });
    await expect(withSqliteRetry(fn, { maxAttempts: 3, minJitterMs: 0, maxJitterMs: 0 })).rejects.toThrow('busy');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-BUSY error immediately without retrying', async () => {
    const nonBusy = new Error('constraint violation');
    const fn = vi.fn(() => { throw nonBusy; });
    await expect(withSqliteRetry(fn, { maxAttempts: 5, minJitterMs: 0, maxJitterMs: 0 })).rejects.toThrow('constraint');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on SQLITE_LOCKED', async () => {
    let calls = 0;
    const lockedErr = Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED' });
    const fn = vi.fn(() => {
      calls++;
      if (calls < 2) throw lockedErr;
      return 'done';
    });
    const result = await withSqliteRetry(fn, { maxAttempts: 5, minJitterMs: 0, maxJitterMs: 0 });
    expect(result).toBe('done');
  });
});
