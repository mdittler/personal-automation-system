import { describe, expect, it } from 'vitest';
import {
	type PendingSessionControlEntry,
	createPendingEntry,
	createPendingSessionControlStore,
} from '../pending-session-control-store.js';

describe('PendingSessionControlStore', () => {
	it('attach then get returns the entry', () => {
		const store = createPendingSessionControlStore({
			clock: () => 1000,
			ttlMs: 5000,
		});

		const entry: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'start new chat',
			expiresAt: 6000,
			id: 'nonce1',
			createdAtMs: 1000,
		};

		store.attach('user1', entry);
		const retrieved = store.get('user1');

		expect(retrieved).toEqual(entry);
	});

	it('get removes the entry (consume-once) — second get returns undefined', () => {
		const store = createPendingSessionControlStore({
			clock: () => 1000,
			ttlMs: 5000,
		});

		const entry: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'start new chat',
			expiresAt: 6000,
			id: 'nonce1',
			createdAtMs: 1000,
		};

		store.attach('user1', entry);
		const first = store.get('user1');
		const second = store.get('user1');

		expect(first).toEqual(entry);
		expect(second).toBeUndefined();
	});

	it('has returns true for valid entry, false for absent', () => {
		const store = createPendingSessionControlStore({
			clock: () => 1000,
			ttlMs: 5000,
		});

		const entry: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'start new chat',
			expiresAt: 6000,
			id: 'nonce1',
			createdAtMs: 1000,
		};

		store.attach('user1', entry);
		expect(store.has('user1')).toBe(true);
		expect(store.has('user2')).toBe(false);
	});

	it('has returns false for expired entry (without removing it)', () => {
		let now = 1000;
		const store = createPendingSessionControlStore({
			clock: () => now,
			ttlMs: 5000,
		});

		const entry: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'start new chat',
			expiresAt: 6000,
			id: 'nonce1',
			createdAtMs: 1000,
		};

		store.attach('user1', entry);
		expect(store.has('user1')).toBe(true);

		// Advance time past expiry
		now = 6001;
		expect(store.has('user1')).toBe(false);

		// Verify get also returns undefined (entry still exists in store, but is expired)
		const retrieved = store.get('user1');
		expect(retrieved).toBeUndefined();
	});

	it('get returns undefined for expired entry', () => {
		let now = 1000;
		const store = createPendingSessionControlStore({
			clock: () => now,
			ttlMs: 5000,
		});

		const entry: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'start new chat',
			expiresAt: 6000,
			id: 'nonce1',
			createdAtMs: 1000,
		};

		store.attach('user1', entry);

		// Advance time past expiry
		now = 6001;
		const retrieved = store.get('user1');

		expect(retrieved).toBeUndefined();
	});

	it('remove deletes the entry — has returns false', () => {
		const store = createPendingSessionControlStore({
			clock: () => 1000,
			ttlMs: 5000,
		});

		const entry: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'start new chat',
			expiresAt: 6000,
			id: 'nonce1',
			createdAtMs: 1000,
		};

		store.attach('user1', entry);
		expect(store.has('user1')).toBe(true);

		store.remove('user1');
		expect(store.has('user1')).toBe(false);
	});

	it('attach overwrites existing entry (same userId, different messageText)', () => {
		const store = createPendingSessionControlStore({
			clock: () => 1000,
			ttlMs: 5000,
		});

		const entry1: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'first message',
			expiresAt: 6000,
			id: 'nonce1',
			createdAtMs: 1000,
		};

		const entry2: PendingSessionControlEntry = {
			userId: 'user1',
			messageText: 'second message',
			expiresAt: 7000,
			id: 'nonce2',
			createdAtMs: 2000,
		};

		store.attach('user1', entry1);
		store.attach('user1', entry2);

		const retrieved = store.get('user1');
		expect(retrieved).toEqual(entry2);
		expect(retrieved?.messageText).toBe('second message');
	});

	it('createPendingEntry sets correct expiresAt relative to clock', () => {
		const clock = () => 1000;
		const ttlMs = 5000;

		const entry = createPendingEntry('user1', 'test message', { clock, ttlMs, id: 'nonce1' });

		expect(entry.userId).toBe('user1');
		expect(entry.messageText).toBe('test message');
		expect(entry.expiresAt).toBe(6000); // 1000 + 5000
	});

	it('createPendingEntry sets createdAtMs from clock', () => {
		const clock = () => 2500;
		const entry = createPendingEntry('user1', 'hello', { clock, id: 'nonce2' });
		expect(entry.createdAtMs).toBe(2500);
	});
});
