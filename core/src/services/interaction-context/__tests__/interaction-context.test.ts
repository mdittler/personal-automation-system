import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InteractionContextServiceImpl } from '../index.js';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

describe('InteractionContextService', () => {
	let svc: InteractionContextServiceImpl;

	beforeEach(() => {
		svc = new InteractionContextServiceImpl();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// 1. record() + getRecent() returns entries for the correct user, newest-first
	it('records entries and returns them newest-first', () => {
		svc.record('user1', { appId: 'food', action: 'view-recipe' });
		svc.record('user1', { appId: 'food', action: 'log-meal' });
		svc.record('user1', { appId: 'notes', action: 'create-note' });

		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(3);
		// newest-first: last recorded comes first
		expect(entries[0]!.action).toBe('create-note');
		expect(entries[1]!.action).toBe('log-meal');
		expect(entries[2]!.action).toBe('view-recipe');
	});

	// 2. Buffer caps at 5; when 6th entry added, oldest is evicted
	it('caps buffer at 5 entries, evicting oldest on 6th add', () => {
		for (let i = 1; i <= 6; i++) {
			svc.record('user1', { appId: 'food', action: `action-${i}` });
		}

		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(5);
		// action-1 (oldest) should be gone; action-6 (newest) first
		expect(entries[0]!.action).toBe('action-6');
		expect(entries[4]!.action).toBe('action-2');
		expect(entries.find((e) => e.action === 'action-1')).toBeUndefined();
	});

	// 3. Entries older than 10 minutes are excluded from getRecent()
	it('excludes entries older than 10 minutes', () => {
		vi.useFakeTimers();

		// Record entry at t=0
		svc.record('user1', { appId: 'food', action: 'old-action' });

		// Advance past TTL
		vi.advanceTimersByTime(TTL_MS + 1);

		// Record a fresh entry
		svc.record('user1', { appId: 'food', action: 'fresh-action' });

		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(1);
		expect(entries[0]!.action).toBe('fresh-action');
	});

	// 4. User A cannot see User B's entries (userId isolation)
	it('isolates entries between users', () => {
		svc.record('userA', { appId: 'food', action: 'action-a' });
		svc.record('userB', { appId: 'notes', action: 'action-b' });

		const aEntries = svc.getRecent('userA');
		const bEntries = svc.getRecent('userB');

		expect(aEntries).toHaveLength(1);
		expect(aEntries[0]!.action).toBe('action-a');
		expect(bEntries).toHaveLength(1);
		expect(bEntries[0]!.action).toBe('action-b');

		// Confirm no cross-contamination
		expect(aEntries.find((e) => e.action === 'action-b')).toBeUndefined();
		expect(bEntries.find((e) => e.action === 'action-a')).toBeUndefined();
	});

	// 5. getRecent() on unknown user returns empty array
	it('returns empty array for unknown user', () => {
		const entries = svc.getRecent('nobody');
		expect(entries).toEqual([]);
	});

	// 6. Multiple rapid recordings within TTL all visible
	it('returns all entries recorded within TTL', () => {
		vi.useFakeTimers();

		svc.record('user1', { appId: 'food', action: 'a1' });
		vi.advanceTimersByTime(60_000); // 1 minute
		svc.record('user1', { appId: 'food', action: 'a2' });
		vi.advanceTimersByTime(60_000); // 2 minutes total
		svc.record('user1', { appId: 'food', action: 'a3' });

		// All within 10-min TTL
		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.action)).toEqual(['a3', 'a2', 'a1']);
	});

	// 7. After partial TTL expiry, only expired entries excluded
	it('excludes only the expired entries when TTL is partially elapsed', () => {
		vi.useFakeTimers();

		// Record 3 entries, advance past TTL, then record 2 more
		svc.record('user1', { appId: 'food', action: 'expired-1' });
		svc.record('user1', { appId: 'food', action: 'expired-2' });

		vi.advanceTimersByTime(TTL_MS + 1);

		svc.record('user1', { appId: 'food', action: 'fresh-1' });
		svc.record('user1', { appId: 'food', action: 'fresh-2' });

		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(2);
		expect(entries[0]!.action).toBe('fresh-2');
		expect(entries[1]!.action).toBe('fresh-1');
		expect(entries.find((e) => e.action === 'expired-1')).toBeUndefined();
		expect(entries.find((e) => e.action === 'expired-2')).toBeUndefined();
	});

	// Additional: record() stamps timestamp automatically
	it('stamps timestamp automatically on record()', () => {
		vi.useFakeTimers();
		const now = Date.now();

		svc.record('user1', { appId: 'food', action: 'test' });

		const entries = svc.getRecent('user1');
		expect(entries[0]!.timestamp).toBe(now);
	});

	// Additional: optional fields are preserved
	it('preserves optional fields on InteractionEntry', () => {
		svc.record('user1', {
			appId: 'food',
			action: 'capture-receipt',
			entityType: 'receipt',
			entityId: 'receipt-123',
			filePaths: ['users/user1/food/receipts/2026-04.md'],
			scope: 'user',
			spaceId: undefined,
			metadata: { store: 'Costco' },
		});

		const entries = svc.getRecent('user1');
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;
		expect(entry.appId).toBe('food');
		expect(entry.action).toBe('capture-receipt');
		expect(entry.entityType).toBe('receipt');
		expect(entry.entityId).toBe('receipt-123');
		expect(entry.filePaths).toEqual(['users/user1/food/receipts/2026-04.md']);
		expect(entry.scope).toBe('user');
		expect(entry.metadata).toEqual({ store: 'Costco' });
	});
});
