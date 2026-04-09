import { describe, expect, it } from 'vitest';
import { getCurrentUserId, requestContext } from '../request-context.js';

describe('requestContext', () => {
	it('returns undefined outside any run() scope', () => {
		expect(getCurrentUserId()).toBeUndefined();
	});

	it('exposes userId set by run()', () => {
		const seen = requestContext.run({ userId: 'alice' }, () => getCurrentUserId());
		expect(seen).toBe('alice');
	});

	it('returns undefined when store is present but userId is omitted', () => {
		const seen = requestContext.run({}, () => getCurrentUserId());
		expect(seen).toBeUndefined();
	});

	it('inner run() overrides outer run()', () => {
		const seen = requestContext.run({ userId: 'outer' }, () => {
			return requestContext.run({ userId: 'inner' }, () => getCurrentUserId());
		});
		expect(seen).toBe('inner');
	});

	it('restores outer context after inner run() exits', () => {
		const outerSeen = requestContext.run({ userId: 'outer' }, () => {
			requestContext.run({ userId: 'inner' }, () => getCurrentUserId());
			return getCurrentUserId();
		});
		expect(outerSeen).toBe('outer');
	});

	it('propagates through awaited async boundaries', async () => {
		async function deep(): Promise<string | undefined> {
			await Promise.resolve();
			await new Promise((r) => setTimeout(r, 1));
			return getCurrentUserId();
		}
		const seen = await requestContext.run({ userId: 'bob' }, () => deep());
		expect(seen).toBe('bob');
	});

	it('does not leak across sibling run() calls', async () => {
		const results: Array<string | undefined> = [];
		await Promise.all([
			requestContext.run({ userId: 'u1' }, async () => {
				await Promise.resolve();
				results.push(getCurrentUserId());
			}),
			requestContext.run({ userId: 'u2' }, async () => {
				await Promise.resolve();
				results.push(getCurrentUserId());
			}),
		]);
		expect(results.sort()).toEqual(['u1', 'u2']);
	});
});
