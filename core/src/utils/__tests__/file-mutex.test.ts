import { describe, expect, it } from 'vitest';

// We test the module-level singleton functions via re-import isolation isn't
// possible in ESM without a factory. Instead we test observable behavior:
// since both functions share a single AsyncLock, we can rely on the ordering
// guarantees proven by AsyncLock's own tests. Here we focus on the public API
// contracts: serialization, parallelism, error recovery, multi-lock ordering,
// and key deduplication.

// Because `withFileLock` and `withMultiFileLock` share a module-level lock
// singleton, tests that care about isolation use distinct key prefixes.

import { withFileLock, withMultiFileLock } from '../file-mutex.js';

describe('withFileLock', () => {
	it('serializes concurrent operations on the same key', async () => {
		const key = '/data/test/same-key-serialize';
		const order: number[] = [];

		const p1 = withFileLock(key, async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push(1);
		});
		const p2 = withFileLock(key, async () => {
			order.push(2);
		});

		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
	});

	it('allows concurrent operations on different keys', async () => {
		const order: string[] = [];

		const p1 = withFileLock('/data/test/parallel-key-a', async () => {
			await new Promise((r) => setTimeout(r, 30));
			order.push('a');
		});
		const p2 = withFileLock('/data/test/parallel-key-b', async () => {
			order.push('b');
		});

		await Promise.all([p1, p2]);
		// 'b' is on a different key and resolves before 'a' finishes
		expect(order).toEqual(['b', 'a']);
	});

	it('does not poison the queue on error', async () => {
		const key = '/data/test/error-recovery';

		await expect(
			withFileLock(key, async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');

		// Next operation on the same key must still run
		const result = await withFileLock(key, async () => 'recovered');
		expect(result).toBe('recovered');
	});
});

describe('withMultiFileLock', () => {
	it('acquires locks in sorted order regardless of input order', async () => {
		// We prove sorted acquisition by showing that reversed-order inputs
		// produce the same serialization as sorted-order inputs (no deadlock,
		// same result). We use keys that sort in a known order.
		const keyA = '/data/test/multi-a';
		const keyB = '/data/test/multi-b';
		const results: string[] = [];

		// Launch two concurrent multi-locks with keys in opposite orders.
		// Both should complete without deadlock.
		await Promise.all([
			withMultiFileLock([keyB, keyA], async () => {
				results.push('first');
			}),
			withMultiFileLock([keyA, keyB], async () => {
				results.push('second');
			}),
		]);

		expect(results).toHaveLength(2);
		expect(results).toContain('first');
		expect(results).toContain('second');
	});

	it('deduplicates keys — passing the same key twice does not deadlock', async () => {
		const key = '/data/test/dedup-key';
		const result = await withMultiFileLock([key, key], async () => 'ok');
		expect(result).toBe('ok');
	});

	it('error in fn does not poison the queue', async () => {
		const keyA = '/data/test/multi-err-a';
		const keyB = '/data/test/multi-err-b';

		await expect(
			withMultiFileLock([keyA, keyB], async () => {
				throw new Error('multi-boom');
			}),
		).rejects.toThrow('multi-boom');

		// Both keys must be usable after the error
		const r1 = await withFileLock(keyA, async () => 'a-ok');
		const r2 = await withFileLock(keyB, async () => 'b-ok');
		expect(r1).toBe('a-ok');
		expect(r2).toBe('b-ok');
	});
});
