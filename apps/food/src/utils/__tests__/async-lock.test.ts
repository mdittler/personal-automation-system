/**
 * Regression tests for the per-key async promise-chain lock used to
 * serialize read-modify-write sequences against the per-user YAML stores.
 *
 * Added for finding H4: without serialization, two async paths can interleave
 * across awaits and lose each other's mutations.
 */

import { describe, it, expect } from 'vitest';
import { AsyncLock } from '../async-lock.js';

describe('AsyncLock', () => {
	it('serializes runs that share a key', async () => {
		const lock = new AsyncLock();
		const log: string[] = [];

		async function task(name: string, durationMs: number): Promise<void> {
			log.push(`${name}-start`);
			await new Promise((r) => setTimeout(r, durationMs));
			log.push(`${name}-end`);
		}

		// Kick off three tasks on the same key in quick succession.
		const a = lock.run('k', () => task('a', 30));
		const b = lock.run('k', () => task('b', 5));
		const c = lock.run('k', () => task('c', 5));
		await Promise.all([a, b, c]);

		// They must run end-to-end in order: never interleaved.
		expect(log).toEqual([
			'a-start', 'a-end',
			'b-start', 'b-end',
			'c-start', 'c-end',
		]);
	});

	it('runs different keys concurrently', async () => {
		const lock = new AsyncLock();
		const log: string[] = [];
		async function task(name: string, durationMs: number): Promise<void> {
			log.push(`${name}-start`);
			await new Promise((r) => setTimeout(r, durationMs));
			log.push(`${name}-end`);
		}
		await Promise.all([
			lock.run('k1', () => task('a', 30)),
			lock.run('k2', () => task('b', 10)),
		]);
		// 'b' is on a different key and finishes inside 'a', so we expect
		// b-end before a-end (interleaving allowed across keys).
		const aEnd = log.indexOf('a-end');
		const bEnd = log.indexOf('b-end');
		expect(bEnd).toBeLessThan(aEnd);
	});

	it('does not poison the chain when an earlier waiter throws', async () => {
		const lock = new AsyncLock();
		await expect(
			lock.run('k', async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');

		// The next waiter on the same key must still run normally.
		const result = await lock.run('k', async () => 42);
		expect(result).toBe(42);
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
