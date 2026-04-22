/**
 * Rolling 60-second message rate tracker.
 *
 * Records one timestamp entry per incoming message (attributed to a household).
 * All reads scan the live ring buffer — no separate aggregation state.
 * A cleanup timer prunes entries older than the window every 10 seconds.
 */

import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../../types/auth-actor.js';

const WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 10_000;

interface Entry {
	ts: number;
	householdId: string;
}

export class MessageRateTracker {
	private readonly entries: Entry[] = [];
	private readonly cleanupTimer: ReturnType<typeof setInterval>;
	private disposed = false;

	constructor() {
		this.cleanupTimer = setInterval(() => this.prune(), CLEANUP_INTERVAL_MS);
		// Allow process to exit even if this timer is running
		if (typeof this.cleanupTimer.unref === 'function') {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Record a message for the given household.
	 * Platform/undefined householdIds are stored under a sentinel so they don't
	 * inflate activeHouseholds() counts.
	 */
	recordMessage(householdId?: string): void {
		if (this.disposed) return;
		const hhId = householdId && householdId !== PLATFORM_SYSTEM_HOUSEHOLD_ID ? householdId : PLATFORM_SYSTEM_HOUSEHOLD_ID;
		this.entries.push({ ts: Date.now(), householdId: hhId });
	}

	/** Number of distinct non-platform households with activity in the last 60s. */
	getActiveHouseholds(): number {
		const cutoff = Date.now() - WINDOW_MS;
		const seen = new Set<string>();
		for (const e of this.entries) {
			if (e.ts >= cutoff && e.householdId !== PLATFORM_SYSTEM_HOUSEHOLD_ID) {
				seen.add(e.householdId);
			}
		}
		return seen.size;
	}

	/** Total messages recorded in the last 60s (all households including platform). */
	getMessagesPerMinute(): number {
		const cutoff = Date.now() - WINDOW_MS;
		let count = 0;
		for (const e of this.entries) {
			if (e.ts >= cutoff) count++;
		}
		return count;
	}

	/** Per-household message counts in the last 60s (excludes platform entries). */
	getPerHouseholdRpm(): Map<string, number> {
		const cutoff = Date.now() - WINDOW_MS;
		const result = new Map<string, number>();
		for (const e of this.entries) {
			if (e.ts >= cutoff && e.householdId !== PLATFORM_SYSTEM_HOUSEHOLD_ID) {
				result.set(e.householdId, (result.get(e.householdId) ?? 0) + 1);
			}
		}
		return result;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.cleanupTimer);
		this.entries.length = 0;
	}

	private prune(): void {
		const cutoff = Date.now() - WINDOW_MS;
		let i = 0;
		while (i < this.entries.length && (this.entries[i]?.ts ?? 0) < cutoff) {
			i++;
		}
		if (i > 0) this.entries.splice(0, i);
	}
}
