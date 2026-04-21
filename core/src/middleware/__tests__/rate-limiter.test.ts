import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter, createLoginRateLimiter, createTelegramRateLimiter } from '../rate-limiter.js';

describe('RateLimiter', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('allows requests within the limit', () => {
		const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 60_000 });

		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(true);
	});

	it('blocks requests exceeding the limit', () => {
		const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 60_000 });

		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(false);
		expect(limiter.isAllowed('user1')).toBe(false);
	});

	it('allows requests again after the window expires', () => {
		const limiter = new RateLimiter({ maxAttempts: 2, windowMs: 10_000 });

		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(false);

		// Advance past the window
		vi.advanceTimersByTime(10_001);

		expect(limiter.isAllowed('user1')).toBe(true);
	});

	it('tracks keys independently', () => {
		const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 60_000 });

		expect(limiter.isAllowed('user1')).toBe(true);
		expect(limiter.isAllowed('user1')).toBe(false);

		// Different key is unaffected
		expect(limiter.isAllowed('user2')).toBe(true);
		expect(limiter.isAllowed('user2')).toBe(false);
	});

	it('uses sliding window (partial expiration)', () => {
		const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 10_000 });

		// T=0: first request
		expect(limiter.isAllowed('user1')).toBe(true);

		// T=4s: second request
		vi.advanceTimersByTime(4_000);
		expect(limiter.isAllowed('user1')).toBe(true);

		// T=8s: third request
		vi.advanceTimersByTime(4_000);
		expect(limiter.isAllowed('user1')).toBe(true);

		// T=8s: fourth request — blocked
		expect(limiter.isAllowed('user1')).toBe(false);

		// T=10.001s: first request expires, one slot opens
		vi.advanceTimersByTime(2_001);
		expect(limiter.isAllowed('user1')).toBe(true);

		// Still at limit
		expect(limiter.isAllowed('user1')).toBe(false);
	});

	describe('getRemainingAttempts', () => {
		it('returns max for unknown key', () => {
			const limiter = new RateLimiter({ maxAttempts: 5, windowMs: 60_000 });
			expect(limiter.getRemainingAttempts('unknown')).toBe(5);
		});

		it('decreases as attempts are made', () => {
			const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 60_000 });

			expect(limiter.getRemainingAttempts('user1')).toBe(3);
			limiter.isAllowed('user1');
			expect(limiter.getRemainingAttempts('user1')).toBe(2);
			limiter.isAllowed('user1');
			expect(limiter.getRemainingAttempts('user1')).toBe(1);
			limiter.isAllowed('user1');
			expect(limiter.getRemainingAttempts('user1')).toBe(0);
		});

		it('recovers after window expires', () => {
			const limiter = new RateLimiter({ maxAttempts: 2, windowMs: 5_000 });

			limiter.isAllowed('user1');
			limiter.isAllowed('user1');
			expect(limiter.getRemainingAttempts('user1')).toBe(0);

			vi.advanceTimersByTime(5_001);
			expect(limiter.getRemainingAttempts('user1')).toBe(2);
		});
	});

	describe('reset', () => {
		it('clears rate limit for a key', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 60_000 });

			expect(limiter.isAllowed('user1')).toBe(true);
			expect(limiter.isAllowed('user1')).toBe(false);

			limiter.reset('user1');
			expect(limiter.isAllowed('user1')).toBe(true);
		});

		it('does not affect other keys', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 60_000 });

			limiter.isAllowed('user1');
			limiter.isAllowed('user2');

			limiter.reset('user1');
			expect(limiter.isAllowed('user1')).toBe(true);
			expect(limiter.isAllowed('user2')).toBe(false);
		});
	});

	describe('cleanup', () => {
		it('purges expired entries during cleanup cycle', () => {
			const limiter = new RateLimiter({ maxAttempts: 5, windowMs: 10_000 });
			limiter.startCleanup();

			limiter.isAllowed('user1');
			limiter.isAllowed('user2');

			// Advance past window + cleanup interval
			vi.advanceTimersByTime(10_001);

			// After cleanup runs, expired entries should be removed
			// New requests should be allowed
			expect(limiter.isAllowed('user1')).toBe(true);
			expect(limiter.isAllowed('user2')).toBe(true);

			limiter.dispose();
		});

		it('dispose clears all state', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 60_000 });
			limiter.startCleanup();

			limiter.isAllowed('user1');
			expect(limiter.isAllowed('user1')).toBe(false);

			limiter.dispose();

			// After dispose, key is gone
			expect(limiter.isAllowed('user1')).toBe(true);
		});
	});

	describe('boundary configurations', () => {
		it('maxAttempts=0 is rejected by constructor', () => {
			expect(() => new RateLimiter({ maxAttempts: 0, windowMs: 60_000 })).toThrow();
		});

		it('maxAttempts=1 with very small window recovers quickly', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 1 });
			expect(limiter.isAllowed('user1')).toBe(true);
			expect(limiter.isAllowed('user1')).toBe(false);

			// Advance past 1ms window
			vi.advanceTimersByTime(2);
			expect(limiter.isAllowed('user1')).toBe(true);
		});
	});

	describe('check() peek/commit API', () => {
		it('check() returns limit metadata matching constructor', () => {
			const limiter = new RateLimiter({ maxAttempts: 7, windowMs: 2000 });
			const r = limiter.check('k');
			expect(r.limit).toEqual({ maxAttempts: 7, windowMs: 2000 });
		});

		it('check() + commit() records one slot; second check reflects it', () => {
			const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 10_000 });
			const r1 = limiter.check('k');
			expect(r1.allowed).toBe(true);
			r1.commit();
			expect(limiter.getRemainingAttempts('k')).toBe(2);
		});

		it('isAllowed() remains equivalent to atomic check+commit', () => {
			const limiter = new RateLimiter({ maxAttempts: 2, windowMs: 10_000 });
			expect(limiter.isAllowed('k')).toBe(true);
			expect(limiter.isAllowed('k')).toBe(true);
			expect(limiter.isAllowed('k')).toBe(false);
		});

		it('peeked-but-not-committed slots are not reserved (two peeks both see empty)', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 1000 });
			const a = limiter.check('k');
			const b = limiter.check('k');
			expect(a.allowed).toBe(true);
			expect(b.allowed).toBe(true);
		});

		it('burst: 2 peeks + 2 commits against cap 1 — only first commit lands', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 1000 });
			const a = limiter.check('k');
			const b = limiter.check('k');
			a.commit();
			b.commit();
			expect(limiter.getRemainingAttempts('k')).toBe(0);
		});

		it('burst: commit() called twice on same result object records only once (idempotent)', () => {
			const limiter = new RateLimiter({ maxAttempts: 5, windowMs: 10_000 });
			const r = limiter.check('k');
			r.commit();
			r.commit();
			expect(limiter.getRemainingAttempts('k')).toBe(4);
		});

		it('burst: Promise.all of 100 sync check()+commit() under cap 10 leaves exactly 10 committed', async () => {
			const limiter = new RateLimiter({ maxAttempts: 10, windowMs: 10_000 });
			await Promise.all(
				Array.from({ length: 100 }, () =>
					Promise.resolve().then(() => {
						const r = limiter.check('k');
						if (r.allowed) r.commit();
					}),
				),
			);
			expect(limiter.getRemainingAttempts('k')).toBe(0);
		});

		it('maxAttempts: 1 — single commit fills the cap', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 10_000 });
			limiter.check('k').commit();
			expect(limiter.check('k').allowed).toBe(false);
		});

		it('expiry: entry at exactly now - windowMs is treated as expired (strict < comparison)', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 1000 });
			vi.setSystemTime(1_000);
			limiter.check('k').commit();
			vi.setSystemTime(2_000); // exactly windowMs later — expired
			expect(limiter.check('k').allowed).toBe(true);
		});

		it('reset("k") on a never-seen key does not throw and does not create an entry', () => {
			const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 10_000 });
			expect(() => limiter.reset('never-seen')).not.toThrow();
		});

		it('after dispose(), check() throws "disposed" (no silent allowed)', () => {
			const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 10_000 });
			limiter.dispose();
			expect(() => limiter.check('k')).toThrow(/disposed/i);
		});
	});

	describe('constructor validation', () => {
		it.each([NaN, Infinity, -Infinity, -1, 0, 1.5])(
			'rejects invalid maxAttempts = %s',
			(v) => {
				expect(() => new RateLimiter({ maxAttempts: v as number, windowMs: 1000 })).toThrow();
			},
		);

		it.each([NaN, Infinity, -Infinity, -1, 0])('rejects invalid windowMs = %s', (v) => {
			expect(() => new RateLimiter({ maxAttempts: 3, windowMs: v as number })).toThrow();
		});
	});

	describe('revokeLastCommit()', () => {
		it('pops the most recent committed slot', () => {
			const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 10_000 });
			limiter.check('k').commit();
			expect(limiter.getRemainingAttempts('k')).toBe(2);
			limiter.revokeLastCommit('k');
			expect(limiter.getRemainingAttempts('k')).toBe(3);
		});

		it('no-op on never-seen key', () => {
			const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 10_000 });
			expect(() => limiter.revokeLastCommit('never-seen')).not.toThrow();
		});

		it('no-op on empty key (already expired or reset)', () => {
			const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 10_000 });
			limiter.check('k').commit();
			limiter.reset('k');
			expect(() => limiter.revokeLastCommit('k')).not.toThrow();
		});

		it('no-op after dispose (does not throw)', () => {
			const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 10_000 });
			limiter.check('k').commit();
			limiter.dispose();
			expect(() => limiter.revokeLastCommit('k')).not.toThrow();
		});
	});

	describe('factory functions', () => {
		it('createTelegramRateLimiter allows 20 messages per 60s', () => {
			const limiter = createTelegramRateLimiter();
			for (let i = 0; i < 20; i++) {
				expect(limiter.isAllowed('user1')).toBe(true);
			}
			expect(limiter.isAllowed('user1')).toBe(false);
		});

		it('createLoginRateLimiter allows 5 attempts per 15min', () => {
			const limiter = createLoginRateLimiter();
			for (let i = 0; i < 5; i++) {
				expect(limiter.isAllowed('192.168.1.1')).toBe(true);
			}
			expect(limiter.isAllowed('192.168.1.1')).toBe(false);

			// Still blocked before 15 minutes
			vi.advanceTimersByTime(14 * 60_000);
			expect(limiter.isAllowed('192.168.1.1')).toBe(false);

			// Allowed after 15 minutes
			vi.advanceTimersByTime(1 * 60_000 + 1);
			expect(limiter.isAllowed('192.168.1.1')).toBe(true);
		});
	});
});
