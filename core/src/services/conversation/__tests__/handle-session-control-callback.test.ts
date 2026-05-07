/**
 * Tests for handleSessionControlCallback.
 *
 * Covers: confirmed / declined / expired-or-stale outcomes,
 * telemetry invocation, elapsedMs computation, fail-open.
 *
 * REQ-CONV-NEWCHAT-010.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleSessionControlCallback } from '../handle-session-control-callback.js';
import { createPendingSessionControlStore } from '../pending-session-control-store.js';
import type { HandleSessionControlCallbackDeps } from '../handle-session-control-callback.js';
import type { MessageContext } from '../../../types/telegram.js';

const SC_YES = 'sc:yes' as const;
const SC_NO = 'sc:no' as const;

function makeCtx(userId = 'u1'): MessageContext {
	return {
		userId,
		text: 'hello',
		timestamp: new Date(),
		chatId: 123,
		messageId: 456,
	};
}

function makeEntry(userId = 'u1', entryId = 'abc123', createdAtMs = 1000) {
	return {
		userId,
		messageText: 'start fresh',
		expiresAt: createdAtMs + 300_000,
		id: entryId,
		createdAtMs,
	};
}

function makeDeps(
	overrides: Partial<HandleSessionControlCallbackDeps> = {},
): HandleSessionControlCallbackDeps {
	return {
		pendingStore: createPendingSessionControlStore({ clock: () => 2000 }),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
		sessionControlLogger: undefined,
		logger: { warn: vi.fn(), info: vi.fn() } as unknown as HandleSessionControlCallbackDeps['logger'],
		clock: () => 6000,
		...overrides,
	};
}

describe('handleSessionControlCallback — confirmed (sc:yes)', () => {
	it('calls handleNewChat and logs confirmed outcome', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		store.attach('u1', makeEntry('u1', 'abc123', 2000));

		const logConfirmation = vi.fn().mockResolvedValue(undefined);
		const sessionControlLogger = { logConfirmation } as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];

		const deps = makeDeps({
			pendingStore: store,
			sessionControlLogger,
			clock: () => 6000,
		});

		const ctx = makeCtx();
		await handleSessionControlCallback(SC_YES, 'abc123', ctx, deps);

		expect(deps.handleNewChat).toHaveBeenCalledWith(ctx);
		expect(logConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u1',
				entryId: 'abc123',
				outcome: 'confirmed',
				elapsedMs: 4000, // 6000 - 2000
			}),
		);
	});

	it('logs "failed" outcome (not "confirmed") when handleNewChat throws (fail-open)', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		store.attach('u1', makeEntry('u1', 'abc123', 2000));

		const logConfirmation = vi.fn().mockResolvedValue(undefined);
		const sessionControlLogger = { logConfirmation } as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];
		const logger = { warn: vi.fn(), info: vi.fn() } as unknown as HandleSessionControlCallbackDeps['logger'];

		const deps = makeDeps({
			pendingStore: store,
			handleNewChat: vi.fn().mockRejectedValue(new Error('session store failure')),
			sessionControlLogger,
			logger,
			clock: () => 6000,
		});

		await expect(handleSessionControlCallback(SC_YES, 'abc123', makeCtx(), deps)).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('session store failure'));
		expect(logConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'failed' }),
		);
	});
});

describe('handleSessionControlCallback — declined (sc:no)', () => {
	it('does NOT call handleNewChat and logs declined outcome', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		store.attach('u1', makeEntry('u1', 'abc123', 2000));

		const logConfirmation = vi.fn().mockResolvedValue(undefined);
		const sessionControlLogger = { logConfirmation } as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];

		const deps = makeDeps({
			pendingStore: store,
			sessionControlLogger,
			clock: () => 5000,
		});

		await handleSessionControlCallback(SC_NO, 'abc123', makeCtx(), deps);

		expect(deps.handleNewChat).not.toHaveBeenCalled();
		expect(logConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u1',
				entryId: 'abc123',
				outcome: 'declined',
				elapsedMs: 3000, // 5000 - 2000
			}),
		);
	});

	it('consumes the pending entry (store empty after sc:no)', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		store.attach('u1', makeEntry('u1', 'abc123', 2000));

		await handleSessionControlCallback(SC_NO, 'abc123', makeCtx(), makeDeps({ pendingStore: store }));

		// Entry should be consumed (get returns undefined)
		expect(store.get('u1')).toBeUndefined();
	});
});

describe('handleSessionControlCallback — expired-or-stale', () => {
	it('logs expired-or-stale when store is empty (race: expired between peek and get)', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 }); // no entry attached
		const logConfirmation = vi.fn().mockResolvedValue(undefined);
		const sessionControlLogger = { logConfirmation } as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];

		const deps = makeDeps({ pendingStore: store, sessionControlLogger });
		await handleSessionControlCallback(SC_YES, 'abc123', makeCtx(), deps);

		expect(deps.handleNewChat).not.toHaveBeenCalled();
		expect(logConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'expired-or-stale', elapsedMs: 0 }),
		);
	});

	it('logs expired-or-stale when entryId nonce mismatches', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		store.attach('u1', makeEntry('u1', 'correct-nonce', 2000));

		const logConfirmation = vi.fn().mockResolvedValue(undefined);
		const sessionControlLogger = { logConfirmation } as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];

		const deps = makeDeps({ pendingStore: store, sessionControlLogger });
		await handleSessionControlCallback(SC_YES, 'wrong-nonce', makeCtx(), deps);

		expect(deps.handleNewChat).not.toHaveBeenCalled();
		expect(logConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'expired-or-stale' }),
		);
	});

	it('does NOT call handleNewChat when expired-or-stale on sc:no either', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		// No entry
		const deps = makeDeps({ pendingStore: store });
		await handleSessionControlCallback(SC_NO, 'abc123', makeCtx(), deps);
		expect(deps.handleNewChat).not.toHaveBeenCalled();
	});
});

describe('handleSessionControlCallback — elapsedMs computation', () => {
	it('computes elapsedMs as (clock() - entry.createdAtMs)', async () => {
		const store = createPendingSessionControlStore({ clock: () => 1000 });
		store.attach('u1', makeEntry('u1', 'n1', 1000));

		const logConfirmation = vi.fn().mockResolvedValue(undefined);
		const sessionControlLogger = { logConfirmation } as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];

		const deps = makeDeps({
			pendingStore: store,
			sessionControlLogger,
			clock: () => 4500,
		});

		await handleSessionControlCallback(SC_YES, 'n1', makeCtx(), deps);

		expect(logConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ elapsedMs: 3500 }), // 4500 - 1000
		);
	});

	it('uses Date.now() for clock when clock dep is omitted', async () => {
		const store = createPendingSessionControlStore({ clock: () => Date.now() });
		const entry = makeEntry('u1', 'n2', Date.now() - 1000);
		store.attach('u1', entry);

		const logConfirmation = vi.fn().mockResolvedValue(undefined);
		const sessionControlLogger = { logConfirmation } as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];

		const deps: HandleSessionControlCallbackDeps = {
			pendingStore: store,
			handleNewChat: vi.fn().mockResolvedValue(undefined),
			sessionControlLogger,
			logger: { warn: vi.fn(), info: vi.fn() } as unknown as HandleSessionControlCallbackDeps['logger'],
			// clock omitted → uses Date.now()
		};

		await handleSessionControlCallback(SC_YES, 'n2', makeCtx(), deps);

		const call = logConfirmation.mock.calls[0][0];
		expect(call.elapsedMs).toBeGreaterThanOrEqual(900);
		expect(call.elapsedMs).toBeLessThan(5000); // sanity: < 5 seconds
	});
});

describe('handleSessionControlCallback — telemetry fail-open', () => {
	it('resolves even when sessionControlLogger.logConfirmation rejects', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		store.attach('u1', makeEntry('u1', 'abc123', 2000));

		const sessionControlLogger = {
			logConfirmation: vi.fn().mockReturnValue(Promise.reject(new Error('log failure'))),
		} as unknown as HandleSessionControlCallbackDeps['sessionControlLogger'];

		const deps = makeDeps({ pendingStore: store, sessionControlLogger });

		await expect(
			handleSessionControlCallback(SC_YES, 'abc123', makeCtx(), deps),
		).resolves.toBeUndefined();
	});

	it('works correctly when no sessionControlLogger is provided', async () => {
		const store = createPendingSessionControlStore({ clock: () => 2000 });
		store.attach('u1', makeEntry('u1', 'abc123', 2000));

		const deps = makeDeps({ pendingStore: store, sessionControlLogger: undefined });
		// Should not throw even with no logger
		await expect(
			handleSessionControlCallback(SC_YES, 'abc123', makeCtx(), deps),
		).resolves.toBeUndefined();
		expect(deps.handleNewChat).toHaveBeenCalled();
	});
});
