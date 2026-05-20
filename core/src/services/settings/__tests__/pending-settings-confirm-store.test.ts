/**
 * pending-settings-confirm-store.test.ts
 *
 * Covers:
 * - attach returns entry with generated id, createdAtMs, expiresAt
 * - get is consume-once: returns entry then undefined
 * - peek is non-consuming
 * - has reflects non-expired entries
 * - remove is idempotent
 * - expiresAt <= now → expired (test boundaries: before, at, after)
 * - attach overwrites prior pending for same user
 * - cleanupExpired prunes only expired entries, returns count
 * - injectable clock and idGen work in tests
 */
import { describe, expect, it } from 'vitest';
import {
	SETTINGS_CONFIRM_TTL_MS,
	createPendingSettingsConfirmStore,
} from '../pending-settings-confirm-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _now = 1_000_000;
const fakeClock = () => _now;
let _idCounter = 0;
const fakeIdGen = () => `id${++_idCounter}`;

function makeStore(ttlMs = 60_000) {
	_now = 1_000_000;
	_idCounter = 0;
	return createPendingSettingsConfirmStore({ ttlMs, clock: fakeClock, idGen: fakeIdGen });
}

const BASE_ENTRY = {
	userId: 'u1',
	qualifiedKey: 'food.default_store',
	action: 'set' as const,
	rawValue: 'Whole Foods',
	expectedPhrase: 'I understand the risk',
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — attach', () => {
	it('returns entry with generated id, createdAtMs, expiresAt', () => {
		const store = makeStore();
		const entry = store.attach('u1', BASE_ENTRY);

		expect(entry.id).toBe('id1');
		expect(entry.createdAtMs).toBe(1_000_000);
		expect(entry.expiresAt).toBe(1_000_000 + 60_000);
		expect(entry.userId).toBe('u1');
		expect(entry.qualifiedKey).toBe('food.default_store');
		expect(entry.action).toBe('set');
		expect(entry.rawValue).toBe('Whole Foods');
		expect(entry.expectedPhrase).toBe('I understand the risk');
	});

	it('attach overwrites prior pending for same user', () => {
		const store = makeStore();
		const first = store.attach('u1', BASE_ENTRY);
		const second = store.attach('u1', { ...BASE_ENTRY, rawValue: "Trader Joe's" });

		expect(second.id).toBe('id2');
		expect(second.rawValue).toBe("Trader Joe's");

		// Only the second entry should be retrievable.
		const retrieved = store.get('u1');
		expect(retrieved!.id).toBe('id2');
		expect(retrieved!.rawValue).toBe("Trader Joe's");
	});

	it('stores reset action without rawValue', () => {
		const store = makeStore();
		const entry = store.attach('u1', {
			userId: 'u1',
			qualifiedKey: 'food.default_store',
			action: 'reset',
			expectedPhrase: 'I understand',
		});
		expect(entry.action).toBe('reset');
		expect(entry.rawValue).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// get — consume-once
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — get (consume-once)', () => {
	it('returns entry on first call and undefined on second', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);

		const first = store.get('u1');
		expect(first).toBeDefined();
		expect(first!.qualifiedKey).toBe('food.default_store');

		const second = store.get('u1');
		expect(second).toBeUndefined();
	});

	it('returns undefined when no entry exists', () => {
		const store = makeStore();
		expect(store.get('u1')).toBeUndefined();
	});

	it('returns undefined and removes when expired (expiresAt === now)', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		// Advance clock to exactly expiresAt
		_now = 1_000_000 + 60_000; // expiresAt === now → expired
		expect(store.get('u1')).toBeUndefined();
		// Entry was cleaned up
		expect(store.has('u1')).toBe(false);
	});

	it('returns undefined when expired (expiresAt < now)', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		_now = 1_000_000 + 60_001; // past expiry
		expect(store.get('u1')).toBeUndefined();
	});

	it('returns entry when not yet expired (expiresAt > now)', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		_now = 1_000_000 + 59_999; // just before expiry
		expect(store.get('u1')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// peek — non-consuming
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — peek', () => {
	it('returns entry without removing it', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);

		const first = store.peek('u1');
		expect(first).toBeDefined();
		expect(first!.qualifiedKey).toBe('food.default_store');

		// Entry still present for a second peek
		const second = store.peek('u1');
		expect(second).toBeDefined();

		// And still present for get
		const third = store.get('u1');
		expect(third).toBeDefined();
	});

	it('returns undefined when no entry exists', () => {
		const store = makeStore();
		expect(store.peek('u1')).toBeUndefined();
	});

	it('returns undefined when expired', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		_now = 1_000_000 + 60_000; // expiresAt === now → expired
		expect(store.peek('u1')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// has
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — has', () => {
	it('returns true for non-expired entry', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		expect(store.has('u1')).toBe(true);
	});

	it('returns false when no entry', () => {
		const store = makeStore();
		expect(store.has('u1')).toBe(false);
	});

	it('returns false when entry exactly at expiry (expiresAt <= now)', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		_now = 1_000_000 + 60_000;
		expect(store.has('u1')).toBe(false);
	});

	it('returns false for different user', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		expect(store.has('u2')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — remove', () => {
	it('removes an existing entry', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		store.remove('u1');
		expect(store.has('u1')).toBe(false);
		expect(store.get('u1')).toBeUndefined();
	});

	it('is idempotent — no-op when no entry exists', () => {
		const store = makeStore();
		expect(() => store.remove('u1')).not.toThrow();
		expect(() => store.remove('u1')).not.toThrow();
	});

	it('only removes the target user, not others', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		store.attach('u2', { ...BASE_ENTRY, userId: 'u2' });
		store.remove('u1');
		expect(store.has('u1')).toBe(false);
		expect(store.has('u2')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// cleanupExpired
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — cleanupExpired', () => {
	it('returns 0 when store is empty', () => {
		const store = makeStore();
		expect(store.cleanupExpired()).toBe(0);
	});

	it('returns 0 when no entries are expired', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		store.attach('u2', { ...BASE_ENTRY, userId: 'u2' });
		expect(store.cleanupExpired()).toBe(0);
		// Both still present
		expect(store.has('u1')).toBe(true);
		expect(store.has('u2')).toBe(true);
	});

	it('removes expired entries and returns count', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY); // expiresAt = 1_060_000
		store.attach('u2', { ...BASE_ENTRY, userId: 'u2' }); // same
		store.attach('u3', { ...BASE_ENTRY, userId: 'u3' }); // same

		// Advance clock past expiry for u1 and u2 but NOT u3 (using external now param)
		// Actually cleanupExpired(now) with explicit now
		const count = store.cleanupExpired(1_060_001);
		expect(count).toBe(3); // all three expired

		expect(store.has('u1')).toBe(false);
		expect(store.has('u2')).toBe(false);
		expect(store.has('u3')).toBe(false);
	});

	it('only removes entries whose expiresAt <= passed-in now', () => {
		const store = makeStore();
		// u1: expiresAt = 1_000_000 + 60_000 = 1_060_000
		store.attach('u1', BASE_ENTRY);

		// u2 attached slightly later (different createdAtMs doesn't matter since
		// all use same fakeClock, but let's confirm boundary)
		store.attach('u2', { ...BASE_ENTRY, userId: 'u2' });

		// Only pass now = 1_060_000 (expiresAt === now → expired for both)
		const count = store.cleanupExpired(1_060_000);
		expect(count).toBe(2);
	});

	it('uses clock() when no explicit now provided', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		_now = 1_060_001; // past expiry
		const count = store.cleanupExpired(); // no explicit now
		expect(count).toBe(1);
	});

	it('does not remove entries that have not yet expired', () => {
		const store = makeStore(10_000); // 10s TTL; expiresAt = 1_000_000 + 10_000 = 1_010_000
		store.attach('u1', BASE_ENTRY);
		store.attach('u2', { ...BASE_ENTRY, userId: 'u2' });

		// Pass now = 1_009_999 — strictly before expiresAt (1_010_000), so no entries should expire.
		const count = store.cleanupExpired(1_009_999);
		expect(count).toBe(0);

		// Both entries must still be accessible via peek.
		expect(store.peek('u1')).toBeDefined();
		expect(store.peek('u2')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Expiry boundary tests (detailed)
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — expiry boundary', () => {
	it('now < expiresAt → entry is valid', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY); // expiresAt = 1_060_000
		_now = 1_059_999; // now < expiresAt
		expect(store.peek('u1')).toBeDefined();
	});

	it('now === expiresAt → entry is expired', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY); // expiresAt = 1_060_000
		_now = 1_060_000; // now === expiresAt
		expect(store.peek('u1')).toBeUndefined();
	});

	it('now > expiresAt → entry is expired', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY); // expiresAt = 1_060_000
		_now = 1_060_001; // now > expiresAt
		expect(store.peek('u1')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Injectable clock and idGen
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — injectable clock and idGen', () => {
	it('uses provided clock for TTL calculation', () => {
		let time = 5_000;
		const store = createPendingSettingsConfirmStore({
			ttlMs: 1_000,
			clock: () => time,
		});
		store.attach('u1', BASE_ENTRY);

		// Before expiry
		time = 5_999;
		expect(store.peek('u1')).toBeDefined();

		// At expiry boundary
		time = 6_000;
		expect(store.peek('u1')).toBeUndefined();
	});

	it('uses provided idGen for entry IDs', () => {
		const ids: string[] = [];
		let counter = 0;
		const store = createPendingSettingsConfirmStore({
			idGen: () => `custom-${++counter}`,
			clock: () => 1_000,
		});

		const e1 = store.attach('u1', BASE_ENTRY);
		const e2 = store.attach('u2', { ...BASE_ENTRY, userId: 'u2' });
		expect(e1.id).toBe('custom-1');
		expect(e2.id).toBe('custom-2');
	});

	it('uses default 60s TTL when no ttlMs provided', () => {
		// Verify SETTINGS_CONFIRM_TTL_MS is 60_000
		expect(SETTINGS_CONFIRM_TTL_MS).toBe(60_000);

		let time = 0;
		const store = createPendingSettingsConfirmStore({ clock: () => time });
		store.attach('u1', BASE_ENTRY);

		time = 59_999;
		expect(store.peek('u1')).toBeDefined();

		time = 60_000;
		expect(store.peek('u1')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Multi-user isolation
// ---------------------------------------------------------------------------

describe('PendingSettingsConfirmStore — multi-user isolation', () => {
	it('entries for different users are independent', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		store.attach('u2', { ...BASE_ENTRY, userId: 'u2', rawValue: 'Costco' });

		const e1 = store.get('u1');
		expect(e1!.rawValue).toBe('Whole Foods');

		const e2 = store.get('u2');
		expect(e2!.rawValue).toBe('Costco');
	});

	it('consuming user A entry does not affect user B', () => {
		const store = makeStore();
		store.attach('u1', BASE_ENTRY);
		store.attach('u2', { ...BASE_ENTRY, userId: 'u2' });

		store.get('u1'); // consume u1
		expect(store.has('u2')).toBe(true);
	});
});
