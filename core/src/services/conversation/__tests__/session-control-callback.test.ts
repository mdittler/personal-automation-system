/**
 * Integration tests for the sc:yes / sc:no callback handler logic.
 *
 * These tests exercise the round-trip:
 *   1. A PendingSessionControlEntry is attached to the store.
 *   2. sc:yes is processed — get(userId) consumes the entry, handleNewChat is called.
 *   3. sc:no is processed — remove(userId) is called, no handleNewChat.
 *   4. An expired entry — get(userId) returns undefined, expired-message path taken.
 *
 * The tests are isolated from grammy by exercising the store + mocked service directly,
 * mirroring exactly what the compose-runtime callback handler does.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	createPendingSessionControlStore,
	createPendingEntry,
	type PendingSessionControlEntry,
} from '../pending-session-control-store.js';
import type { MessageContext } from '../../../types/telegram.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeEntry(
	userId: string,
	clock: () => number,
	ttlMs = 5 * 60 * 1000,
): PendingSessionControlEntry {
	return createPendingEntry(userId, 'start fresh please', { clock, ttlMs });
}

function makeCtx(userId: string): MessageContext {
	return {
		userId,
		text: 'start fresh please',
		timestamp: new Date(),
		chatId: 12345,
		messageId: 1,
	};
}

// ── sc:yes — valid (non-expired) entry ───────────────────────────────────────

describe('session-control callback: sc:yes', () => {
	it('consumes the entry and calls handleNewChat when entry is valid', async () => {
		const userId = 'user-1';
		let now = 1000;
		const clock = () => now;
		const store = createPendingSessionControlStore({ clock });

		// Attach a pending entry
		store.attach(userId, makeEntry(userId, clock));

		// Simulate sc:yes processing
		const handleNewChat = vi.fn().mockResolvedValue(undefined);
		const expiredReplies: string[] = [];

		const entry = store.get(userId); // consume-once
		if (!entry) {
			expiredReplies.push('That confirmation has expired. Please try again.');
		} else {
			const ctx = makeCtx(userId);
			await handleNewChat([], ctx);
		}

		expect(entry).toBeDefined();
		expect(handleNewChat).toHaveBeenCalledTimes(1);
		expect(expiredReplies).toHaveLength(0);

		// Entry must be gone (consumed)
		expect(store.has(userId)).toBe(false);
	});
});

// ── sc:yes — expired entry ───────────────────────────────────────────────────

describe('session-control callback: sc:yes expired', () => {
	it('sends expired message and skips handleNewChat when entry is expired', async () => {
		const userId = 'user-2';
		let now = 1000;
		const clock = () => now;
		const store = createPendingSessionControlStore({ clock, ttlMs: 1000 });

		// Attach entry, then advance clock past TTL
		store.attach(userId, makeEntry(userId, clock, 1000));
		now = 2001; // past TTL

		// Simulate sc:yes processing
		const handleNewChat = vi.fn().mockResolvedValue(undefined);
		const expiredReplies: string[] = [];

		const entry = store.get(userId); // should be expired → undefined
		if (!entry) {
			expiredReplies.push('That confirmation has expired. Please try again.');
		} else {
			const ctx = makeCtx(userId);
			await handleNewChat([], ctx);
		}

		expect(entry).toBeUndefined();
		expect(handleNewChat).not.toHaveBeenCalled();
		expect(expiredReplies).toEqual(['That confirmation has expired. Please try again.']);
	});
});

// ── sc:no — remove entry ─────────────────────────────────────────────────────

describe('session-control callback: sc:no', () => {
	it('removes the entry and does not call handleNewChat', async () => {
		const userId = 'user-3';
		const clock = () => 1000;
		const store = createPendingSessionControlStore({ clock });

		// Attach a pending entry
		store.attach(userId, makeEntry(userId, clock));
		expect(store.has(userId)).toBe(true);

		// Simulate sc:no processing
		const handleNewChat = vi.fn().mockResolvedValue(undefined);
		const continuingReplies: string[] = [];

		store.remove(userId);
		continuingReplies.push('OK, continuing your current conversation.');

		expect(handleNewChat).not.toHaveBeenCalled();
		expect(store.has(userId)).toBe(false);
		expect(continuingReplies).toEqual(['OK, continuing your current conversation.']);
	});
});

// ── sc:yes — missing entry (no pending at all) ────────────────────────────────

describe('session-control callback: sc:yes with no pending entry', () => {
	it('sends expired message when no entry was ever attached', async () => {
		const userId = 'user-4';
		const store = createPendingSessionControlStore();

		// No attach — entry does not exist
		const handleNewChat = vi.fn().mockResolvedValue(undefined);
		const expiredReplies: string[] = [];

		const entry = store.get(userId);
		if (!entry) {
			expiredReplies.push('That confirmation has expired. Please try again.');
		} else {
			await handleNewChat([], makeCtx(userId));
		}

		expect(entry).toBeUndefined();
		expect(handleNewChat).not.toHaveBeenCalled();
		expect(expiredReplies).toEqual(['That confirmation has expired. Please try again.']);
	});
});
