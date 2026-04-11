/**
 * Tiny per-key promise-chain lock used to serialize read-modify-write
 * sequences against shared stores.
 *
 * Usage:
 *   const lock = new AsyncLock();
 *   await lock.run('key', async () => {
 *     const data = await readFile(store);
 *     mutate(data);
 *     await writeFile(store, data);
 *   });
 *
 * Locks are scoped to the lock instance, so per-store singletons are typical.
 * The chain is cleared once the last waiter resolves to avoid map growth.
 */

export class AsyncLock {
	private readonly chains = new Map<string, Promise<unknown>>();

	async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		// Always chain off the previous promise's settlement (success OR failure)
		// so a thrown error in one waiter does not poison the rest.
		const next = prev.catch(() => undefined).then(() => fn());
		this.chains.set(key, next);
		try {
			return await next;
		} finally {
			// Only clear the chain if we are still the tail. Otherwise leave it
			// in place so newer waiters keep their ordering.
			if (this.chains.get(key) === next) {
				this.chains.delete(key);
			}
		}
	}
}
