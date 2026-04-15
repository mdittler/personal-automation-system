import { AsyncLock } from './async-lock.js';

const lock = new AsyncLock();

/**
 * In-process RMW mutex keyed by canonical data path.
 * Sufficient for single-process deployment. NOT a cross-process flock.
 *
 * Acquire before the first read in a read-modify-write sequence.
 * Release happens automatically when fn() resolves/rejects.
 */
export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	return lock.run(key, fn);
}

/**
 * Acquire multiple file locks in canonical sorted order (prevents deadlocks).
 * Use when a single operation touches multiple stores.
 * If keys is empty, fn() runs immediately with no lock held.
 */
export function withMultiFileLock<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
	const sorted = [...new Set(keys)].sort();
	const acquire = (i: number): Promise<T> => {
		if (i >= sorted.length) return fn();
		// sorted[i] is always defined here — guarded by i < sorted.length
		return lock.run(sorted[i]!, () => acquire(i + 1));
	};
	return acquire(0);
}
