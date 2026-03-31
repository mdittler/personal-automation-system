/**
 * Sliding-window rate limiter.
 *
 * Tracks timestamps per key and enforces a maximum number of
 * events within a rolling time window. Used for Telegram message
 * throttling and GUI login brute-force protection.
 */

export interface RateLimiterOptions {
	/** Maximum events allowed within the window. */
	maxAttempts: number;
	/** Window duration in milliseconds. */
	windowMs: number;
}

export class RateLimiter {
	private readonly maxAttempts: number;
	private readonly windowMs: number;
	private readonly entries = new Map<string, number[]>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(options: RateLimiterOptions) {
		this.maxAttempts = options.maxAttempts;
		this.windowMs = options.windowMs;
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
			// Remove expired timestamps
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
	 * Start periodic cleanup of expired entries to prevent memory leaks.
	 * Call this once at startup.
	 */
	startCleanup(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => {
			this.purgeExpired();
		}, this.windowMs);
		// Don't block process exit
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Stop the cleanup timer and clear all entries.
	 */
	dispose(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.entries.clear();
	}

	/** Remove entries with no timestamps within the current window. */
	private purgeExpired(): void {
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
