/**
 * InteractionContextService — in-memory per-user interaction tracking.
 *
 * Records the last N interactions per user with a TTL. Used for contextual
 * follow-ups: e.g., after a receipt photo is captured, "show me those costs"
 * can resolve to the correct data file using recent interaction context.
 *
 * Design decisions:
 * - In-memory only (no persistence). Restarts clear the buffer.
 * - Circular buffer of 5 entries per user (oldest evicted on 6th add).
 * - 10-minute TTL: getRecent() filters stale entries before returning.
 * - getRecent() returns entries newest-first.
 * - Strict userId isolation — User A cannot see User B's entries.
 */

/** A single recorded interaction event. */
export interface InteractionEntry {
	/** The app that generated this interaction (e.g. 'food', 'notes'). */
	appId: string;
	/** What the user/app did (e.g. 'capture-receipt', 'view-recipe'). */
	action: string;
	/** Semantic type of the primary entity involved (e.g. 'receipt', 'recipe'). */
	entityType?: string;
	/** Stable identifier for the primary entity. */
	entityId?: string;
	/** Canonical data file paths written or referenced during this interaction. */
	filePaths?: string[];
	/** Data scope of the interaction. */
	scope?: 'user' | 'shared' | 'space';
	/** Space ID when scope is 'space'. */
	spaceId?: string;
	/** Arbitrary key/value metadata for downstream context resolution. */
	metadata?: Record<string, string>;
	/** Unix timestamp (ms) when this entry was recorded. Set by record(). */
	timestamp: number;
}

/** Public interface for the interaction context service. */
export interface InteractionContextService {
	/**
	 * Record a new interaction for the given user.
	 * Timestamp is stamped automatically.
	 * When the buffer reaches 6 entries, the oldest is evicted.
	 */
	record(userId: string, entry: Omit<InteractionEntry, 'timestamp'>): void;

	/**
	 * Return recent interactions for the given user, newest-first.
	 * Entries older than 10 minutes are excluded.
	 * Returns an empty array for unknown users.
	 */
	getRecent(userId: string): InteractionEntry[];
}

/** Maximum number of entries retained per user (circular buffer size). */
const BUFFER_SIZE = 5;
/** Entry time-to-live in milliseconds (10 minutes). */
const TTL_MS = 10 * 60 * 1000;

export class InteractionContextServiceImpl implements InteractionContextService {
	/** Per-user circular buffers. Entries are stored oldest-first internally. */
	private readonly store = new Map<string, InteractionEntry[]>();

	record(userId: string, entry: Omit<InteractionEntry, 'timestamp'>): void {
		const stamped: InteractionEntry = { ...entry, timestamp: Date.now() };

		let buffer = this.store.get(userId);
		if (!buffer) {
			buffer = [];
			this.store.set(userId, buffer);
		}

		buffer.push(stamped);

		// Evict oldest if buffer exceeds capacity
		if (buffer.length > BUFFER_SIZE) {
			buffer.shift();
		}
	}

	getRecent(userId: string): InteractionEntry[] {
		const buffer = this.store.get(userId);
		if (!buffer || buffer.length === 0) {
			return [];
		}

		const cutoff = Date.now() - TTL_MS;

		// Filter expired entries and return newest-first
		return buffer.filter((e) => e.timestamp > cutoff).toReversed();
	}
}
