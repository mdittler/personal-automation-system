/**
 * PendingSettingsConfirmStore — in-memory TTL store for dangerous-setting confirm flow.
 *
 * When the user issues `/settings <category> <key> <value>` (or `/settings reset ...`)
 * for a dangerous=true setting, we do NOT write immediately. Instead we:
 *   1. Validate the value.
 *   2. Store a pending entry here.
 *   3. Reply with the danger confirmation prompt.
 *   4. Wait for `/settings confirm <phrase>`.
 *
 * Entries expire after 60 seconds (DEFAULT TTL) — short by design to minimise
 * the window for replay attacks.
 */

import { randomBytes } from 'node:crypto';

/** Default TTL for pending settings confirmations (60 seconds). */
export const SETTINGS_CONFIRM_TTL_MS = 60_000;

export type PendingSettingsAction = 'set' | 'reset';

export interface PendingSettingsConfirmEntry {
	/** Opaque nonce — checked by the confirm handler to prevent stale entries. */
	id: string;
	userId: string;
	/** `${appId}.${key}` — uniquely identifies the setting being changed. */
	qualifiedKey: string;
	action: PendingSettingsAction;
	/** Present iff action === 'set'. The pre-validated raw string from the user. */
	rawValue?: string;
	/** The phrase from def.dangerConfirmPrompt. User must type this exactly. */
	expectedPhrase: string;
	/** ms epoch; expiresAt <= now → expired. */
	expiresAt: number;
	/** Wall-clock ms at creation — used to compute elapsedMs in telemetry. */
	createdAtMs: number;
}

export interface PendingSettingsConfirmStore {
	/**
	 * Attach a new pending entry for a user, overwriting any existing entry.
	 * Returns the created entry (with id, createdAtMs, expiresAt filled in).
	 */
	attach(
		userId: string,
		entry: Omit<PendingSettingsConfirmEntry, 'id' | 'createdAtMs' | 'expiresAt'>,
	): PendingSettingsConfirmEntry;

	/**
	 * Retrieve and REMOVE the pending entry for a user (consume-once).
	 * Returns undefined if absent or expired.
	 */
	get(userId: string): PendingSettingsConfirmEntry | undefined;

	/**
	 * Non-consuming read — returns the pending entry without removing it.
	 * Returns undefined if absent or expired.
	 */
	peek(userId: string): PendingSettingsConfirmEntry | undefined;

	/** Check if a non-expired entry exists (does NOT remove it). */
	has(userId: string): boolean;

	/** Remove any pending entry for a user. No-op if absent. */
	remove(userId: string): void;

	/**
	 * Remove all expired entries from the store.
	 * @param now - Optional override for "current time" (ms). Defaults to Date.now().
	 * @returns The number of entries that were cleaned up.
	 */
	cleanupExpired(now?: number): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPendingSettingsConfirmStore(opts?: {
	ttlMs?: number;
	clock?: () => number;
	idGen?: () => string;
}): PendingSettingsConfirmStore {
	const ttlMs = opts?.ttlMs ?? SETTINGS_CONFIRM_TTL_MS;
	const clock = opts?.clock ?? (() => Date.now());
	const idGen = opts?.idGen ?? (() => randomBytes(4).toString('hex'));

	const store = new Map<string, PendingSettingsConfirmEntry>();

	function isExpired(entry: PendingSettingsConfirmEntry): boolean {
		return entry.expiresAt <= clock();
	}

	return {
		attach(userId, fields) {
			const now = clock();
			const entry: PendingSettingsConfirmEntry = {
				...fields,
				userId,
				id: idGen(),
				createdAtMs: now,
				expiresAt: now + ttlMs,
			};
			store.set(userId, entry);
			return entry;
		},

		get(userId) {
			const entry = store.get(userId);
			if (!entry) return undefined;
			if (isExpired(entry)) {
				store.delete(userId);
				return undefined;
			}
			// Consume-once: remove before returning.
			store.delete(userId);
			return entry;
		},

		peek(userId) {
			const entry = store.get(userId);
			if (!entry) return undefined;
			if (isExpired(entry)) {
				store.delete(userId);
				return undefined;
			}
			// Non-consuming — do NOT delete.
			return entry;
		},

		has(userId) {
			const entry = store.get(userId);
			if (!entry) return false;
			return !isExpired(entry);
		},

		remove(userId) {
			store.delete(userId);
		},

		cleanupExpired(now?) {
			const checkTime = now ?? clock();
			let count = 0;
			for (const [userId, entry] of store) {
				if (entry.expiresAt <= checkTime) {
					store.delete(userId);
					count++;
				}
			}
			return count;
		},
	};
}
