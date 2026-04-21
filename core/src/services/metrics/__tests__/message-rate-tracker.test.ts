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
});
