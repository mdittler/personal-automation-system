import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../retry.js';

describe('withRetry', () => {
	it('returns result on first success', async () => {
		const fn = vi.fn().mockResolvedValue('hello');

		const result = await withRetry(fn, { maxRetries: 3 });

		expect(result).toBe('hello');
		expect(fn).toHaveBeenCalledOnce();
	});

	it('retries on failure and succeeds eventually', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('fail 1'))
			.mockRejectedValueOnce(new Error('fail 2'))
			.mockResolvedValue('success');

		const result = await withRetry(fn, {
			maxRetries: 3,
			initialDelayMs: 1,
			backoffMultiplier: 1,
		});

		expect(result).toBe('success');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('throws last error when all retries exhausted', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('always fails'));

		await expect(
			withRetry(fn, {
				maxRetries: 2,
				initialDelayMs: 1,
				backoffMultiplier: 1,
			}),
		).rejects.toThrow('always fails');

		expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
	});

	it('handles non-Error thrown values', async () => {
		const fn = vi.fn().mockRejectedValue('string error');

		await expect(
			withRetry(fn, {
				maxRetries: 0,
				initialDelayMs: 1,
			}),
		).rejects.toThrow('string error');
	});

	it('defaults to 3 retries', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(withRetry(fn, { initialDelayMs: 1, backoffMultiplier: 1 })).rejects.toThrow();

		expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
	});

	it('does not retry when maxRetries is 0', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow();

		expect(fn).toHaveBeenCalledOnce();
	});

	it('clamps negative maxRetries to 0', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('fail'));

		await expect(withRetry(fn, { maxRetries: -5 })).rejects.toThrow();

		// -5 clamped to 0 → only one attempt, no retries
		expect(fn).toHaveBeenCalledOnce();
	});

	it('clamps negative initialDelayMs to 0', async () => {
		const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

		const result = await withRetry(fn, {
			maxRetries: 1,
			initialDelayMs: -100,
			backoffMultiplier: 1,
		});

		expect(result).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
