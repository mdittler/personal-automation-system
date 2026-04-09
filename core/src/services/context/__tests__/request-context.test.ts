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

	// ─── Edge cases ────────────────────────────────────────────────────

	it('inner run() with userId: undefined shadows the outer userId', () => {
		// A dispatch site that enters a sub-scope without a user (e.g. a
		// background health-check triggered inside a message handler) must
		// be able to *clear* the user context, not inherit it. Otherwise
		// infrastructure code would silently read per-user config under the
		// wrong identity.
		const inner = requestContext.run({ userId: 'outer' }, () => {
			return requestContext.run({ userId: undefined }, () => getCurrentUserId());
		});
		expect(inner).toBeUndefined();
	});

	it('preserves arbitrary string userIds verbatim (validation is a consumer responsibility)', () => {
		// The ALS is dumb data storage — it must not mutate or pre-validate
		// userIds. Consumers (AppConfigService, LLM cost tracker, etc.) are
		// responsible for format validation before using the value as e.g.
		// a filesystem path component.
		const suspicious = [
			'',
			'../../etc/passwd',
			'user with space',
			'unicode-Ω',
			'"; rm -rf /',
		];
		for (const uid of suspicious) {
			const seen = requestContext.run({ userId: uid }, () => getCurrentUserId());
			expect(seen).toBe(uid);
		}
	});
});
