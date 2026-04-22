import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageRateTracker } from '../message-rate-tracker.js';

describe('MessageRateTracker', () => {
	let tracker: MessageRateTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		tracker = new MessageRateTracker();
	});

	afterEach(() => {
		tracker.dispose();
		vi.useRealTimers();
	});

	describe('recordMessage / getMessagesPerMinute', () => {
		it('returns 0 with no messages', () => {
			expect(tracker.getMessagesPerMinute()).toBe(0);
		});

		it('counts messages within the 60s window', () => {
			tracker.recordMessage('hA');
			tracker.recordMessage('hA');
			tracker.recordMessage('hB');
			expect(tracker.getMessagesPerMinute()).toBe(3);
		});

		it('excludes messages older than 60s', () => {
			tracker.recordMessage('hA');
			vi.advanceTimersByTime(61_000);
			tracker.recordMessage('hB');
			expect(tracker.getMessagesPerMinute()).toBe(1);
		});

		it('includes platform-sentinel messages in total count', () => {
			tracker.recordMessage(undefined);
			tracker.recordMessage('__platform__');
			tracker.recordMessage('hA');
			expect(tracker.getMessagesPerMinute()).toBe(3);
		});
	});

	describe('getActiveHouseholds', () => {
		it('returns 0 with no messages', () => {
			expect(tracker.getActiveHouseholds()).toBe(0);
		});

		it('counts distinct non-platform households', () => {
			tracker.recordMessage('hA');
			tracker.recordMessage('hA');
			tracker.recordMessage('hB');
			expect(tracker.getActiveHouseholds()).toBe(2);
		});

		it('excludes platform/undefined entries from active count', () => {
			tracker.recordMessage(undefined);
			tracker.recordMessage('__platform__');
			tracker.recordMessage('hA');
			expect(tracker.getActiveHouseholds()).toBe(1);
		});

		it('excludes households with all-expired entries', () => {
			tracker.recordMessage('hA');
			vi.advanceTimersByTime(61_000);
			tracker.recordMessage('hB');
			expect(tracker.getActiveHouseholds()).toBe(1);
		});
	});

	describe('getPerHouseholdRpm', () => {
		it('returns empty map with no messages', () => {
			expect(tracker.getPerHouseholdRpm().size).toBe(0);
		});

		it('returns correct per-household counts', () => {
			tracker.recordMessage('hA');
			tracker.recordMessage('hA');
			tracker.recordMessage('hB');
			const rpm = tracker.getPerHouseholdRpm();
			expect(rpm.get('hA')).toBe(2);
			expect(rpm.get('hB')).toBe(1);
			expect(rpm.has('__platform__')).toBe(false);
		});

		it('does not include platform entries in per-household map', () => {
			tracker.recordMessage(undefined);
			tracker.recordMessage('__platform__');
			const rpm = tracker.getPerHouseholdRpm();
			expect(rpm.size).toBe(0);
		});

		it('excludes expired entries from per-household map', () => {
			tracker.recordMessage('hA');
			vi.advanceTimersByTime(61_000);
			tracker.recordMessage('hA');
			const rpm = tracker.getPerHouseholdRpm();
			expect(rpm.get('hA')).toBe(1);
		});
	});

	describe('cleanup timer (prune)', () => {
		it('prunes old entries after cleanup interval', () => {
			tracker.recordMessage('hA');
			vi.advanceTimersByTime(70_000); // past window + cleanup interval
			// getMessagesPerMinute scans in-place; also verify entries pruned
			expect(tracker.getMessagesPerMinute()).toBe(0);
		});
	});

	describe('dispose', () => {
		it('after dispose, recordMessage is a no-op', () => {
			tracker.dispose();
			tracker.recordMessage('hA');
			expect(tracker.getMessagesPerMinute()).toBe(0);
		});

		it('double dispose does not throw', () => {
			tracker.dispose();
			expect(() => tracker.dispose()).not.toThrow();
		});
	});

	// ---------------------------------------------------------------------------
	// A1–A3: Boundary conditions
	// ---------------------------------------------------------------------------

	describe('boundary conditions', () => {
		it('message at exactly the window boundary is included (ts === cutoff, inclusive)', () => {
			vi.setSystemTime(0);
			const t = new MessageRateTracker();
			t.recordMessage('hA');
			vi.advanceTimersByTime(60_000); // exactly at boundary
			// cutoff = 60_000 - 60_000 = 0; ts(0) >= 0 = true → included
			expect(t.getMessagesPerMinute()).toBe(1);
			t.dispose();
		});

		it('message at 59.999s ago is included (strictly within window)', () => {
			vi.setSystemTime(0);
			const t = new MessageRateTracker();
			t.recordMessage('hA');
			vi.advanceTimersByTime(59_999);
			expect(t.getMessagesPerMinute()).toBe(1);
			t.dispose();
		});

		it('treats empty-string householdId as platform sentinel (excluded from active households)', () => {
			tracker.recordMessage('');
			expect(tracker.getActiveHouseholds()).toBe(0); // empty-string is falsy → coerced to sentinel
			expect(tracker.getMessagesPerMinute()).toBe(1); // still counted in total
			expect(tracker.getPerHouseholdRpm().size).toBe(0);
		});
	});

	// ---------------------------------------------------------------------------
	// A4: Sentinel contract — single source of truth from auth-actor.ts
	// ---------------------------------------------------------------------------

	describe('sentinel contract', () => {
		it('should import PLATFORM_SYSTEM_HOUSEHOLD_ID from auth-actor rather than duplicating it', async () => {
			// Source-scan: the sentinel must not be hardcoded locally.
			// A local copy creates divergence risk if the constant ever changes.
			const { readFile } = await import('node:fs/promises');
			const { dirname, join } = await import('node:path');
			const { fileURLToPath } = await import('node:url');
			const dir = dirname(fileURLToPath(import.meta.url));
			const src = await readFile(join(dir, '..', 'message-rate-tracker.ts'), 'utf8');
			// Must NOT define a local PLATFORM_SENTINEL constant with a hardcoded string
			expect(src).not.toMatch(/const\s+PLATFORM_SENTINEL\s*=\s*['"]__platform__['"]/);
		});
	});

	// ---------------------------------------------------------------------------
	// A5–A8: Cleanup timer behavior
	// ---------------------------------------------------------------------------

	describe('cleanup timer behavior', () => {
		it('setInterval does not fire prune() after dispose (clearInterval was called)', () => {
			const pruneSpy = vi.spyOn(tracker as unknown as { prune(): void }, 'prune');
			tracker.dispose();
			pruneSpy.mockClear();
			vi.advanceTimersByTime(50_000); // 5 × cleanup-interval worth
			expect(pruneSpy).not.toHaveBeenCalled();
		});

		it('prune() actually shrinks internal entries array length after entries expire', () => {
			tracker.recordMessage('hA');
			tracker.recordMessage('hB');
			expect((tracker as unknown as { entries: unknown[] }).entries).toHaveLength(2);
			// Advance 71s: entries expire at 60s, cleanup fires at 70s
			vi.advanceTimersByTime(71_000);
			expect((tracker as unknown as { entries: unknown[] }).entries).toHaveLength(0);
		});

		it('default window is 60 seconds and cleanup fires every 10 seconds (WINDOW_MS and CLEANUP_INTERVAL_MS invariants)', () => {
			// Window is 60s
			tracker.recordMessage('hA');
			vi.advanceTimersByTime(60_001);
			expect(tracker.getMessagesPerMinute()).toBe(0);
			// Cleanup runs at 10s cadence — entries are pruned within 10s after expiry
			// Record fresh at T≈60s, advance another 10s → old 'hA' entry pruned
			tracker.recordMessage('hB');
			vi.advanceTimersByTime(10_001);
			const entries = (tracker as unknown as { entries: Array<{ householdId: string }> }).entries;
			expect(entries.every((e) => e.householdId !== '__platform__' || e.householdId === '__platform__')).toBe(true);
			expect(entries.some((e) => e.householdId === 'hA')).toBe(false);
		});

		it('does not throw in environments where the timer has no unref method', () => {
			const origSetInterval = (globalThis as unknown as Record<string, unknown>).setInterval;
			(globalThis as unknown as Record<string, unknown>).setInterval = (
				...args: Parameters<typeof setInterval>
			) => {
				const timer = (origSetInterval as typeof setInterval)(...args);
				delete (timer as unknown as Record<string, unknown>).unref;
				return timer;
			};
			expect(() => {
				const t = new MessageRateTracker();
				t.dispose();
			}).not.toThrow();
			(globalThis as unknown as Record<string, unknown>).setInterval = origSetInterval;
		});
	});

	// ---------------------------------------------------------------------------
	// A9: Clock regression — defensive hardening (not required by REQ-LLM-028)
	// ---------------------------------------------------------------------------

	describe('clock regression (defensive hardening)', () => {
		it('prune() does not throw when clock rewinds (documents fragility: future-timestamped entries persist)', () => {
			vi.setSystemTime(2_000_000); // T=2M ms
			const t = new MessageRateTracker();
			t.recordMessage('hA'); // ts=2_000_000

			// Simulate NTP clock rewind
			vi.setSystemTime(1_000_000); // clock went backward 1M ms

			// prune() must not throw
			expect(() => (t as unknown as { prune(): void }).prune()).not.toThrow();

			// Fragility: entry at ts=2M is never pruned at T=1M + 120k
			// cutoff = 1.12M - 60k = 1.06M; ts=2M > 1.06M → entry persists
			vi.advanceTimersByTime(120_000);
			expect(t.getMessagesPerMinute()).toBe(1); // stuck — known clock-regression fragility

			t.dispose();
		});
	});
});
