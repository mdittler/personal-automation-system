/**
 * Sliding-window rate limiter.
 *
 * Tracks timestamps per key and enforces a maximum number of
 * events within a rolling time window. Used for Telegram message
 * throttling and GUI login brute-force protection.
 */

export interface RateLimiterOptions {
	/** Maximum events allowed within the window. Must be a positive integer. */
	maxAttempts: number;
	/** Window duration in milliseconds. Must be > 0. */
	windowMs: number;
}

export interface RateLimitCheckResult {
	allowed: boolean;
	/** Record the attempt. Idempotent; re-checks cap at write time. No-op if disposed. */
	commit: () => void;
	limit: { maxAttempts: number; windowMs: number };
}

export class RateLimiter {
	private readonly maxAttempts: number;
	private readonly windowMs: number;
	private readonly entries = new Map<string, number[]>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(options: RateLimiterOptions) {
		const { maxAttempts, windowMs } = options;
		if (!Number.isFinite(maxAttempts) || !Number.isInteger(maxAttempts) || maxAttempts <= 0) {
			throw new Error(`RateLimiter: maxAttempts must be a positive integer, got ${maxAttempts}`);
		}
		if (!Number.isFinite(windowMs) || windowMs <= 0) {
			throw new Error(`RateLimiter: windowMs must be a positive finite number, got ${windowMs}`);
		}
		this.maxAttempts = maxAttempts;
		this.windowMs = windowMs;
	}

	/**
	 * Peek — check if a request would be allowed WITHOUT recording it.
	 * Call commit() on the result to record the attempt.
	 * Throws if disposed.
	 */
	check(key: string): RateLimitCheckResult {
		if (this.disposed) throw new Error('RateLimiter disposed');
		this.purgeExpiredForKey(key);
		const entries = this.entries.get(key) ?? [];
		const allowed = entries.length < this.maxAttempts;
		const committed = { done: false };
		const limit = { maxAttempts: this.maxAttempts, windowMs: this.windowMs };
		const commit = () => {
			if (committed.done) return;
			if (this.disposed) return;
			committed.done = true;
			this.purgeExpiredForKey(key);
			const latest = this.entries.get(key) ?? [];
			if (latest.length >= this.maxAttempts) return;
			latest.push(Date.now());
			this.entries.set(key, latest);
		};
		return { allowed, commit, limit };
	}

	/**
	 * Check if a request is allowed for the given key.
	 * If allowed, records the attempt and returns true.
	 * If rate-limited, returns false.
	 */
	isAllowed(key: string): boolean {
		const now = Date.now();
		const cutoff = now - this.windowMs;

		let timestamps = this.entries.get(key);
		if (timestamps) {
			timestamps = timestamps.filter((t) => t > cutoff);
		} else {
			timestamps = [];
		}

		if (timestamps.length >= this.maxAttempts) {
			this.entries.set(key, timestamps);
			return false;
		}

		timestamps.push(now);
		this.entries.set(key, timestamps);
		return true;
	}

	/**
	 * Get remaining attempts for a key within the current window.
	 */
	getRemainingAttempts(key: string): number {
		const now = Date.now();
		const cutoff = now - this.windowMs;
		const timestamps = this.entries.get(key);
		if (!timestamps) return this.maxAttempts;

		const active = timestamps.filter((t) => t > cutoff);
		return Math.max(0, this.maxAttempts - active.length);
	}

	/**
	 * Reset the rate limit for a specific key.
	 */
	reset(key: string): void {
		this.entries.delete(key);
	}

	/**
	 * Revoke the most recently committed slot for a key.
	 * Used for rollback when a downstream operation fails after rate commit.
	 * No-op if disposed, key unknown, or key has no entries.
	 */
	revokeLastCommit(key: string): void {
		if (this.disposed) return;
		const entries = this.entries.get(key);
		if (!entries || entries.length === 0) return;
		entries.pop();
		if (entries.length === 0) {
			this.entries.delete(key);
		}
	}

	/**
	 * Start periodic cleanup of expired entries to prevent memory leaks.
	 * Call this once at startup.
	 */
	startCleanup(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => {
			this.purgeExpiredAll();
		}, this.windowMs);
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Stop the cleanup timer and clear all entries.
	 */
	dispose(): void {
		this.disposed = true;
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.entries.clear();
	}

	/** Purge expired entries for a single key. Uses strict < so exact-boundary entries expire. */
	private purgeExpiredForKey(key: string): void {
		const entries = this.entries.get(key);
		if (!entries) return;
		const cutoff = Date.now() - this.windowMs;
		const kept = entries.filter((t) => t > cutoff);
		if (kept.length === 0) {
			this.entries.delete(key);
		} else {
			this.entries.set(key, kept);
		}
	}

	/** Remove entries with no timestamps within the current window (global cleanup). */
	private purgeExpiredAll(): void {
		const cutoff = Date.now() - this.windowMs;
		for (const [key, timestamps] of this.entries) {
			const active = timestamps.filter((t) => t > cutoff);
			if (active.length === 0) {
				this.entries.delete(key);
			} else {
				this.entries.set(key, active);
			}
		}
	}
}

/** Rate limiter for Telegram messages: 20 messages per 60 seconds per user. */
export function createTelegramRateLimiter(): RateLimiter {
	return new RateLimiter({ maxAttempts: 20, windowMs: 60_000 });
}

/** Rate limiter for GUI login: 5 attempts per 15 minutes per IP. */
export function createLoginRateLimiter(): RateLimiter {
	return new RateLimiter({ maxAttempts: 5, windowMs: 15 * 60_000 });
}

/** Rate limiter for external API: 100 requests per 60 seconds per IP. */
export function createApiRateLimiter(): RateLimiter {
	return new RateLimiter({ maxAttempts: 100, windowMs: 60_000 });
}
