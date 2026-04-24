import { describe, expect, it } from 'vitest';
import {
	enterRequestContext,
	getCurrentHouseholdId,
	getCurrentUserId,
	requestContext,
} from '../request-context.js';

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

describe('sessionId (via run)', () => {
	it('returns undefined when store is present but sessionId is omitted', () => {
		const seen = requestContext.run({ userId: 'alice' }, () => requestContext.getStore()?.sessionId);
		expect(seen).toBeUndefined();
	});

	it('returns undefined when sessionId is explicitly undefined', () => {
		const seen = requestContext.run(
			{ userId: 'alice', sessionId: undefined },
			() => requestContext.getStore()?.sessionId,
		);
		expect(seen).toBeUndefined();
	});

	it('exposes sessionId set by run()', () => {
		const seen = requestContext.run(
			{ userId: 'alice', sessionId: '20260423_121530_a1b2c3d4' },
			() => requestContext.getStore()?.sessionId,
		);
		expect(seen).toBe('20260423_121530_a1b2c3d4');
	});

	it('sessionId is independent of userId and householdId', () => {
		const seen = requestContext.run(
			{ userId: 'bob', householdId: 'hh-jones', sessionId: 'sess-1' },
			() => ({
				u: getCurrentUserId(),
				h: getCurrentHouseholdId(),
				s: requestContext.getStore()?.sessionId,
			}),
		);
		expect(seen).toEqual({ u: 'bob', h: 'hh-jones', s: 'sess-1' });
	});

	it('inner run() overrides sessionId', () => {
		const seen = requestContext.run(
			{ userId: 'u', sessionId: 'sess-outer' },
			() =>
				requestContext.run(
					{ userId: 'u', sessionId: 'sess-inner' },
					() => requestContext.getStore()?.sessionId,
				),
		);
		expect(seen).toBe('sess-inner');
	});

	it('inner run() with sessionId: undefined shadows the outer sessionId', () => {
		const seen = requestContext.run(
			{ userId: 'u', sessionId: 'sess-outer' },
			() =>
				requestContext.run(
					{ userId: 'u', sessionId: undefined },
					() => requestContext.getStore()?.sessionId,
				),
		);
		expect(seen).toBeUndefined();
	});

	it('propagates sessionId through awaited async boundaries', async () => {
		async function deep(): Promise<string | undefined> {
			await Promise.resolve();
			await new Promise((r) => setTimeout(r, 1));
			return requestContext.getStore()?.sessionId;
		}
		const seen = await requestContext.run(
			{ userId: 'u', sessionId: 'sess-async' },
			() => deep(),
		);
		expect(seen).toBe('sess-async');
	});

	it('does not leak sessionId across sibling run() calls', async () => {
		const results: Array<string | undefined> = [];
		await Promise.all([
			requestContext.run({ userId: 'u1', sessionId: 'sess-a' }, async () => {
				await Promise.resolve();
				results.push(requestContext.getStore()?.sessionId);
			}),
			requestContext.run({ userId: 'u2', sessionId: 'sess-b' }, async () => {
				await Promise.resolve();
				results.push(requestContext.getStore()?.sessionId);
			}),
		]);
		expect(results.sort()).toEqual(['sess-a', 'sess-b']);
	});

	it('preserves arbitrary string sessionIds verbatim (validation is consumer responsibility)', () => {
		const suspicious = ['', '../../etc/passwd', 'id with space', 'unicode-Ω'];
		for (const sid of suspicious) {
			const seen = requestContext.run(
				{ userId: 'u', sessionId: sid },
				() => requestContext.getStore()?.sessionId,
			);
			expect(seen).toBe(sid);
		}
	});
});

describe('sessionId (via enterRequestContext — Fastify hook path)', () => {
	it('exposes sessionId set via enterRequestContext within the same async scope', async () => {
		const seen = await requestContext.run({}, async () => {
			enterRequestContext({ userId: 'alice', sessionId: 'sess-enter' });
			return requestContext.getStore()?.sessionId;
		});
		expect(seen).toBe('sess-enter');
	});

	it('enterRequestContext with sessionId propagates through awaited boundaries', async () => {
		const seen = await requestContext.run({}, async () => {
			enterRequestContext({ userId: 'u', sessionId: 'sess-enter-async' });
			await Promise.resolve();
			await new Promise((r) => setTimeout(r, 1));
			return requestContext.getStore()?.sessionId;
		});
		expect(seen).toBe('sess-enter-async');
	});

	it('enterRequestContext with sessionId omitted leaves sessionId undefined', async () => {
		const seen = await requestContext.run({}, async () => {
			enterRequestContext({ userId: 'u' });
			return requestContext.getStore()?.sessionId;
		});
		expect(seen).toBeUndefined();
	});
});

describe('getCurrentHouseholdId', () => {
	it('returns undefined outside any run() scope', () => {
		expect(getCurrentHouseholdId()).toBeUndefined();
	});

	it('returns undefined when store is present but householdId is omitted', () => {
		const seen = requestContext.run({ userId: 'alice' }, () => getCurrentHouseholdId());
		expect(seen).toBeUndefined();
	});

	it('returns undefined when store is present but householdId is explicitly undefined', () => {
		const seen = requestContext.run({ userId: 'alice', householdId: undefined }, () =>
			getCurrentHouseholdId(),
		);
		expect(seen).toBeUndefined();
	});

	it('exposes householdId set by run()', () => {
		const seen = requestContext.run(
			{ userId: 'alice', householdId: 'hh-smith' },
			() => getCurrentHouseholdId(),
		);
		expect(seen).toBe('hh-smith');
	});

	it('householdId and userId are independent — both readable in same scope', () => {
		const [uid, hhid] = requestContext.run(
			{ userId: 'bob', householdId: 'hh-jones' },
			() => [getCurrentUserId(), getCurrentHouseholdId()] as const,
		);
		expect(uid).toBe('bob');
		expect(hhid).toBe('hh-jones');
	});

	it('inner run() overrides householdId', () => {
		const seen = requestContext.run({ userId: 'outer', householdId: 'hh-outer' }, () =>
			requestContext.run({ userId: 'inner', householdId: 'hh-inner' }, () =>
				getCurrentHouseholdId(),
			),
		);
		expect(seen).toBe('hh-inner');
	});

	it('does not leak householdId across sibling run() calls', async () => {
		const results: Array<string | undefined> = [];
		await Promise.all([
			requestContext.run({ userId: 'u1', householdId: 'hh-a' }, async () => {
				await Promise.resolve();
				results.push(getCurrentHouseholdId());
			}),
			requestContext.run({ userId: 'u2', householdId: 'hh-b' }, async () => {
				await Promise.resolve();
				results.push(getCurrentHouseholdId());
			}),
		]);
		expect(results.sort()).toEqual(['hh-a', 'hh-b']);
	});
});
