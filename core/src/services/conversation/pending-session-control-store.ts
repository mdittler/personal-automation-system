/**
 * PendingSessionControlStore — in-memory TTL store for grey-zone `/newchat` confirmations.
 *
 * When the system detects high-confidence "new session" intent, it immediately starts a new chat.
 * When confidence is in the grey zone (0.4–0.7), it shows inline Telegram buttons asking for
 * confirmation. This store tracks pending confirmations so that when the user clicks a button,
 * the system knows what action to take.
 */

export interface PendingSessionControlEntry {
  userId: string;
  messageText: string;  // the original text that triggered the grey-zone
  expiresAt: number;    // Date.now() ms timestamp
}

export interface PendingSessionControlStore {
  /** Store a pending confirmation for a user. Overwrites any existing entry. */
  attach(userId: string, entry: PendingSessionControlEntry): void;
  /** Retrieve and REMOVE the pending entry for a user (consume-once). Returns undefined if absent or expired. */
  get(userId: string): PendingSessionControlEntry | undefined;
  /** Check if a non-expired entry exists for a user (does NOT remove it). */
  has(userId: string): boolean;
  /** Remove any pending entry for a user. No-op if absent. */
  remove(userId: string): void;
  /**
   * Returns the first non-expired pending entry for the user.
   * Removes expired entries as a side effect.
   * Does NOT consume the entry (peek-only).
   * Returns undefined if none exists or all are expired.
   */
  resolveForUser(userId: string): PendingSessionControlEntry | undefined;
}

export interface PendingSessionControlStoreDeps {
  /** Returns current time in ms. Injectable for testing. Default: Date.now */
  clock?: () => number;
  /** TTL in milliseconds. Default: 5 * 60 * 1000 (5 minutes) */
  ttlMs?: number;
}

/**
 * Create a pending session control entry.
 */
export function createPendingEntry(
  userId: string,
  messageText: string,
  deps: { clock: () => number; ttlMs: number }
): PendingSessionControlEntry {
  return {
    userId,
    messageText,
    expiresAt: deps.clock() + deps.ttlMs,
  };
}

/**
 * In-memory implementation of PendingSessionControlStore.
 * Uses a Map<string, PendingSessionControlEntry> keyed by userId.
 */
class InMemoryPendingSessionControlStore implements PendingSessionControlStore {
  private store: Map<string, PendingSessionControlEntry> = new Map();
  private clock: () => number;
  private ttlMs: number;

  constructor(deps?: PendingSessionControlStoreDeps) {
    this.clock = deps?.clock ?? (() => Date.now());
    this.ttlMs = deps?.ttlMs ?? 5 * 60 * 1000; // 5 minutes default
  }

  attach(userId: string, entry: PendingSessionControlEntry): void {
    this.store.set(userId, entry);
  }

  get(userId: string): PendingSessionControlEntry | undefined {
    const entry = this.store.get(userId);
    if (!entry) {
      return undefined;
    }
    // Check if expired
    if (entry.expiresAt <= this.clock()) {
      // Expired: remove and return undefined
      this.store.delete(userId);
      return undefined;
    }
    // Valid: remove (consume-once) and return
    this.store.delete(userId);
    return entry;
  }

  has(userId: string): boolean {
    const entry = this.store.get(userId);
    if (!entry) {
      return false;
    }
    // Check if expired (do NOT remove, just check)
    return entry.expiresAt > this.clock();
  }

  remove(userId: string): void {
    this.store.delete(userId);
  }

  resolveForUser(userId: string): PendingSessionControlEntry | undefined {
    const entry = this.store.get(userId);
    if (!entry) {
      return undefined;
    }
    // Check if expired
    if (entry.expiresAt <= this.clock()) {
      // Expired: remove and return undefined
      this.store.delete(userId);
      return undefined;
    }
    // Valid: return WITHOUT removing (peek-only)
    return entry;
  }
}

/**
 * Factory to create a PendingSessionControlStore.
 */
export function createPendingSessionControlStore(
  deps?: PendingSessionControlStoreDeps
): PendingSessionControlStore {
  return new InMemoryPendingSessionControlStore(deps);
}
