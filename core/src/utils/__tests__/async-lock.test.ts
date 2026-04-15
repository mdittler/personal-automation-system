import { describe, expect, it } from 'vitest';
import { AsyncLock } from '../async-lock.js';

describe('AsyncLock', () => {
	it('serializes operations on the same key', async () => {
		const lock = new AsyncLock();
		const order: number[] = [];

		const p1 = lock.run('k', async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push(1);
		});
		const p2 = lock.run('k', async () => {
			order.push(2);
		});

		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
	});

	it('allows concurrent operations on different keys', async () => {
		const lock = new AsyncLock();
		const order: string[] = [];

		const p1 = lock.run('a', async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push('a');
		});
		const p2 = lock.run('b', async () => {
			order.push('b');
		});

		await Promise.all([p1, p2]);
		expect(order).toEqual(['b', 'a']);
	});

	it('does not poison the chain on error', async () => {
		const lock = new AsyncLock();

		await expect(
			lock.run('k', async () => {
				throw new Error('fail');
			}),
		).rejects.toThrow('fail');

		const result = await lock.run('k', async () => 'ok');
		expect(result).toBe('ok');
	});

	it('serializes mutations against shared mutable state', async () => {
		const lock = new AsyncLock();
		let counter = 0;
		async function rmw(): Promise<void> {
			const v = counter;
			await new Promise((r) => setTimeout(r, 5));
			counter = v + 1;
		}
		await Promise.all(
			Array.from({ length: 20 }, () => lock.run('counter', rmw)),
		);
		// Without the lock the interleaved RMW would lose updates and the
		// final counter would be < 20. With the lock it's exactly 20.
		expect(counter).toBe(20);
	});
});
