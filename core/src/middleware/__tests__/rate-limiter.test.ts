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
		it('maxAttempts=0 rejects all requests', () => {
			const limiter = new RateLimiter({ maxAttempts: 0, windowMs: 60_000 });
			expect(limiter.isAllowed('user1')).toBe(false);
			expect(limiter.getRemainingAttempts('user1')).toBe(0);
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
