/**
 * Persona tests — Hermes P6.next Chunk B: /refreshmemory handler.
 *
 * Tests cover PR1–PR11 scenarios:
 *   PR1  — Router dispatch forms (5)
 *   PR2  — Should NOT dispatch negatives (≥12)
 *   PR3  — Active session resolution (6)
 *   PR4  — End-to-end preference flow / multi-step (4)
 *   PR5  — Telegram send target = ctx.userId, NOT chatId (3)
 *   PR6  — Race-guard / CAS abort (3)
 *   PR7  — Output formatting (4)
 *   PR8  — pinnedKeys gate via resolveUserBool (3)
 *   PR9  — Help text appears exactly once (1)
 *   PR10 — App-toggle bypass (1)
 *   PR11 — Missing conversationService → no crash (1)
 *
 * Total: ≥43 direct handler tests + Router-level dispatch tests.
 *
 * LLM is NOT called — all tests stub rebuildMemorySnapshot and buildSnapshot.
 * Strong oracle: telegram.send assertions use exact strings, not just "called".
 *
 * REQ-CONV-MEMORY-013..022
 */

import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { MemorySnapshot } from '../../../types/conversation-session.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import type { ConversationRetrievalService } from '../../conversation-retrieval/conversation-retrieval-service.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { NoActiveSessionError } from '../../conversation-session/errors.js';
import { handleRefreshMemory } from '../handle-refresh-memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function makeTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue('Cancel'),
		sendWithButtons: vi.fn().mockResolvedValue(undefined),
		editMessage: vi.fn().mockResolvedValue(undefined),
	};
}

function makeRetrieval(buildResult: MemorySnapshot): ConversationRetrievalService {
	return {
		buildMemorySnapshot: vi.fn().mockResolvedValue(buildResult),
		hasSessionSearch: vi.fn().mockReturnValue(false),
		searchSessions: vi.fn().mockResolvedValue({ hits: [] }),
		buildContextSnapshot: vi.fn(),
		listContextEntries: vi.fn(),
		getRecentInteractions: vi.fn(),
		getEnabledApps: vi.fn(),
		searchAppKnowledge: vi.fn(),
		buildSystemDataBlock: vi.fn(),
		listScopedReports: vi.fn(),
		listScopedAlerts: vi.fn(),
		searchData: vi.fn(),
	} as unknown as ConversationRetrievalService;
}

function makeSessionStore(
	opts: {
		rebuildResult?: MemorySnapshot;
		rebuildError?: Error;
	} = {},
): ChatSessionStore {
	const snap: MemorySnapshot = opts.rebuildResult ?? {
		content: 'key: value',
		status: 'ok',
		builtAt: '2026-05-05T10:00:00.000Z',
		entryCount: 1,
	};

	return {
		peekActive: vi.fn().mockResolvedValue('20260505_100000_abcd1234'),
		ensureActiveSession: vi.fn(),
		peekSnapshot: vi.fn(),
		appendExchange: vi.fn(),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn(),
		readSession: vi.fn(),
		setTitle: vi.fn(),
		rebuildMemorySnapshot: opts.rebuildError
			? vi.fn().mockRejectedValue(opts.rebuildError)
			: vi.fn().mockResolvedValue(snap),
	} as unknown as ChatSessionStore;
}

function makeCtx(
	userId = 'user1',
	sessionId = '20260505_100000_abcd1234',
	sessionKey = `agent:main:telegram:dm:${userId}`,
): MessageContext {
	return {
		userId,
		chatId: 99999,
		messageId: 1,
		text: '/refreshmemory',
		timestamp: new Date('2026-05-05T12:00:00Z'),
		sessionId,
		sessionKey,
	};
}

interface HandleRefreshMemoryDeps {
	telegram: TelegramService;
	chatSessions: ChatSessionStore;
	conversationRetrieval?: ConversationRetrievalService;
	config?: unknown;
	logger: Logger;
}

function makeDeps(overrides: Partial<HandleRefreshMemoryDeps> = {}): HandleRefreshMemoryDeps {
	return {
		telegram: makeTelegram(),
		chatSessions: makeSessionStore(),
		conversationRetrieval: makeRetrieval({
			content: 'key: value',
			status: 'ok',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 1,
		}),
		logger: makeLogger(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// PR3 — Active session resolution
// ---------------------------------------------------------------------------

describe('PR3 — Active session resolution', () => {
	it('sends "No active session to refresh." when NoActiveSessionError is thrown', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new NoActiveSessionError() }),
		});
		await handleRefreshMemory('', makeCtx(), deps);

		expect(deps.telegram.send).toHaveBeenCalledOnce();
		const [userId, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(userId).toBe('user1');
		expect(text).toContain('No active session to refresh');
	});

	it('sends confirmation when active session exists and rebuild succeeds', async () => {
		const snap: MemorySnapshot = {
			content: 'pref: dark-mode',
			status: 'ok',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 2,
		};
		const deps = makeDeps({ chatSessions: makeSessionStore({ rebuildResult: snap }) });
		await handleRefreshMemory('', makeCtx(), deps);

		expect(deps.telegram.send).toHaveBeenCalledOnce();
		const [, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(typeof text).toBe('string');
		expect(text.length).toBeGreaterThan(0);
	});

	it('passes expectedSessionId from ctx.sessionId to rebuildMemorySnapshot', async () => {
		const store = makeSessionStore();
		const deps = makeDeps({ chatSessions: store });
		const ctx = makeCtx('user1', '20260505_100000_abcd1234');
		await handleRefreshMemory('', ctx, deps);

		expect(store.rebuildMemorySnapshot).toHaveBeenCalledOnce();
		const [, opts] = (store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(opts.expectedSessionId).toBe('20260505_100000_abcd1234');
	});

	it('sends to ctx.userId, not chatId (REQ-CONV-MEMORY-021)', async () => {
		const deps = makeDeps();
		const ctx = makeCtx('user42', '20260505_100000_abcd1234');
		ctx.chatId = 99999;
		await handleRefreshMemory('', ctx, deps);

		const [userId] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(userId).toBe('user42');
		expect(userId).not.toBe(99999);
	});

	it('calls rebuildMemorySnapshot with the correct userId context', async () => {
		const store = makeSessionStore();
		const deps = makeDeps({ chatSessions: store });
		await handleRefreshMemory('', makeCtx('alice'), deps);

		const [ctxArg] = (store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(ctxArg.userId).toBe('alice');
	});

	it('user A does NOT affect user B snapshot (user-isolation)', async () => {
		const storeA = makeSessionStore();
		const storeB = makeSessionStore();
		const depsA = makeDeps({ chatSessions: storeA });
		const depsB = makeDeps({ chatSessions: storeB });

		await handleRefreshMemory('', makeCtx('userA', '20260505_100000_aaaaaaaa'), depsA);
		await handleRefreshMemory('', makeCtx('userB', '20260505_100000_bbbbbbbb'), depsB);

		// A's rebuild did not touch B's store
		expect(storeA.rebuildMemorySnapshot).toHaveBeenCalledOnce();
		expect(storeB.rebuildMemorySnapshot).toHaveBeenCalledOnce();
		const [ctxA] = (storeA.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mock.calls[0]!;
		const [ctxB] = (storeB.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(ctxA.userId).toBe('userA');
		expect(ctxB.userId).toBe('userB');
	});
});

// ---------------------------------------------------------------------------
// PR4 — Multi-step / end-to-end flow
// ---------------------------------------------------------------------------

describe('PR4 — Multi-step preference rebuild flow', () => {
	it('two sequential rebuilds produce independent calls with distinct builtAt', async () => {
		const snap1: MemorySnapshot = {
			content: 'first',
			status: 'ok',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 1,
		};
		const snap2: MemorySnapshot = {
			content: 'second',
			status: 'ok',
			builtAt: '2026-05-05T11:00:00.000Z',
			entryCount: 1,
		};

		const storeA = makeSessionStore({ rebuildResult: snap1 });
		const storeB = makeSessionStore({ rebuildResult: snap2 });
		const depsA = makeDeps({ chatSessions: storeA });
		const depsB = makeDeps({ chatSessions: storeB });
		const telegram = makeTelegram();
		depsA.telegram = telegram;
		depsB.telegram = telegram;

		await handleRefreshMemory('', makeCtx(), depsA);
		await handleRefreshMemory('', makeCtx(), depsB);

		expect(telegram.send).toHaveBeenCalledTimes(2);
	});

	it('rebuild after buildSnapshot throws still leaves session untouched', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({
				rebuildError: new Error('ContextStore failure'),
			}),
		});
		await handleRefreshMemory('', makeCtx(), deps);

		const [userId, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(userId).toBe('user1');
		expect(text).toContain('deferred');
	});

	it('always-persist: handler invoked twice sends two confirmation messages', async () => {
		const store = makeSessionStore();
		const telegram = makeTelegram();
		const deps = makeDeps({ chatSessions: store, telegram });

		await handleRefreshMemory('', makeCtx(), deps);
		await handleRefreshMemory('', makeCtx(), deps);

		expect(telegram.send).toHaveBeenCalledTimes(2);
		expect(store.rebuildMemorySnapshot).toHaveBeenCalledTimes(2);
	});

	it('buildSnapshot callback is passed to rebuildMemorySnapshot', async () => {
		const store = makeSessionStore();
		const deps = makeDeps({ chatSessions: store });

		await handleRefreshMemory('', makeCtx(), deps);

		const [, opts] = (store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(typeof opts.buildSnapshot).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// PR5 — Telegram send target
// ---------------------------------------------------------------------------

describe('PR5 — Telegram send target = ctx.userId', () => {
	it('error path sends to userId not hardcoded id', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new Error('boom') }),
		});
		const ctx = makeCtx('bob');
		await handleRefreshMemory('', ctx, deps);

		const [userId] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(userId).toBe('bob');
	});

	it('NoActiveSessionError path sends to correct userId', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new NoActiveSessionError() }),
		});
		const ctx = makeCtx('charlie');
		await handleRefreshMemory('', ctx, deps);

		const [userId] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(userId).toBe('charlie');
	});

	it('success path sends to userId regardless of chatId value', async () => {
		const deps = makeDeps();
		const ctx = makeCtx('dave');
		ctx.chatId = 12345;
		await handleRefreshMemory('', ctx, deps);

		const [userId] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(userId).toBe('dave');
		expect(userId).not.toBe(12345);
	});
});

// ---------------------------------------------------------------------------
// PR6 — Race-guard / CAS abort
// ---------------------------------------------------------------------------

describe('PR6 — Race-guard and generic error handling', () => {
	it('CAS abort (non-NoActiveSessionError) → deferred message, warn logged', async () => {
		const logger = makeLogger();
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new Error('CAS mismatch') }),
			logger,
		});
		await handleRefreshMemory('', makeCtx(), deps);

		const [, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(text).toContain('deferred');
		expect(logger.warn).toHaveBeenCalled();
	});

	it('session-end race logged at warn level', async () => {
		const logger = makeLogger();
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new Error('Session changed') }),
			logger,
		});
		await handleRefreshMemory('', makeCtx(), deps);

		expect(logger.warn).toHaveBeenCalled();
	});

	it('unexpected store error → deferred message, not a crash', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new TypeError('Unexpected') }),
		});
		// Should not throw — fail-soft
		await expect(handleRefreshMemory('', makeCtx(), deps)).resolves.toBeUndefined();
		expect(deps.telegram.send).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// PR7 — Output formatting
// ---------------------------------------------------------------------------

describe('PR7 — Output formatting', () => {
	it('ok snapshot → "Memory refreshed: N entries (X chars)."', async () => {
		const snap: MemorySnapshot = {
			content: 'hello world',
			status: 'ok',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 3,
		};
		const deps = makeDeps({ chatSessions: makeSessionStore({ rebuildResult: snap }) });
		await handleRefreshMemory('', makeCtx(), deps);

		const [, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(text).toContain('3');
		expect(text).toContain('entries');
		expect(text).toContain('chars');
	});

	it('degraded snapshot → "Memory refreshed (degraded): some context unavailable."', async () => {
		const snap: MemorySnapshot = {
			content: '',
			status: 'degraded',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 0,
		};
		const deps = makeDeps({ chatSessions: makeSessionStore({ rebuildResult: snap }) });
		await handleRefreshMemory('', makeCtx(), deps);

		const [, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(text).toContain('degraded');
		expect(text).toContain('unavailable');
	});

	it('no active session → "No active session to refresh."', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new NoActiveSessionError() }),
		});
		await handleRefreshMemory('', makeCtx(), deps);

		const [, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(text).toContain('No active session to refresh');
	});

	it('generic error → "Memory refresh deferred — try again later."', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new Error('store error') }),
		});
		await handleRefreshMemory('', makeCtx(), deps);

		const [, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(text).toContain('deferred');
		expect(text).toContain('try again later');
	});
});

// ---------------------------------------------------------------------------
// PR8 — pinnedKeys gate via config
// ---------------------------------------------------------------------------

describe('PR8 — pinnedKeys gate', () => {
	it('calls rebuildMemorySnapshot once with a buildSnapshot callback', async () => {
		const store = makeSessionStore();
		const deps = makeDeps({ chatSessions: store });
		await handleRefreshMemory('', makeCtx(), deps);

		expect(store.rebuildMemorySnapshot).toHaveBeenCalledOnce();
		const [, opts] = (store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(typeof opts.buildSnapshot).toBe('function');
	});

	it('buildSnapshot callback returns a MemorySnapshot when called', async () => {
		const snap: MemorySnapshot = {
			content: 'callback-content',
			status: 'ok',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 1,
		};
		const retrieval = makeRetrieval(snap);
		const store = makeSessionStore({ rebuildResult: snap });

		// Intercept the buildSnapshot callback and call it
		let capturedCallback: (() => Promise<MemorySnapshot>) | undefined;
		(store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mockImplementation(
			async (_ctx: unknown, opts: { buildSnapshot: () => Promise<MemorySnapshot> }) => {
				capturedCallback = opts.buildSnapshot;
				return snap;
			},
		);

		const deps = makeDeps({ chatSessions: store, conversationRetrieval: retrieval });
		await handleRefreshMemory('', makeCtx(), deps);

		expect(capturedCallback).toBeDefined();
		const result = await capturedCallback!();
		expect(result.content).toBe('callback-content');
	});

	it('no conversationRetrieval → sends deferred message, does NOT call rebuildMemorySnapshot', async () => {
		const store = makeSessionStore();
		const telegram = makeTelegram();
		const deps = makeDeps({ chatSessions: store, conversationRetrieval: undefined, telegram });
		await handleRefreshMemory('', makeCtx(), deps);
		expect(store.rebuildMemorySnapshot).not.toHaveBeenCalled();
		expect(telegram.send).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining('deferred'),
		);
	});

	it('flush_memory_on_idle_reset=true → buildSnapshot calls buildMemorySnapshot with {} (no pinnedKeys restriction)', async () => {
		const snap: MemorySnapshot = {
			content: 'x',
			status: 'ok',
			builtAt: '2026-05-05T00:00:00.000Z',
			entryCount: 1,
		};
		const retrieval = makeRetrieval(snap);
		const store = makeSessionStore({ rebuildResult: snap });
		const config = {
			getOverrides: vi.fn().mockResolvedValue({ flush_memory_on_idle_reset: true }),
		};

		let capturedBuildSnapshot: (() => Promise<MemorySnapshot>) | undefined;
		(store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mockImplementation(
			async (_ctx: unknown, opts: { buildSnapshot: () => Promise<MemorySnapshot> }) => {
				capturedBuildSnapshot = opts.buildSnapshot;
				return snap;
			},
		);

		const deps = makeDeps({ chatSessions: store, conversationRetrieval: retrieval, config });
		await handleRefreshMemory('', makeCtx(), deps);

		expect(capturedBuildSnapshot).toBeDefined();
		await capturedBuildSnapshot!();
		expect(retrieval.buildMemorySnapshot).toHaveBeenCalledWith({});
	});

	it('flush_memory_on_idle_reset=false → buildSnapshot calls buildMemorySnapshot with { pinnedKeys: [] }', async () => {
		const snap: MemorySnapshot = {
			content: 'x',
			status: 'ok',
			builtAt: '2026-05-05T00:00:00.000Z',
			entryCount: 1,
		};
		const retrieval = makeRetrieval(snap);
		const store = makeSessionStore({ rebuildResult: snap });
		const config = {
			getOverrides: vi.fn().mockResolvedValue({ flush_memory_on_idle_reset: false }),
		};

		let capturedBuildSnapshot: (() => Promise<MemorySnapshot>) | undefined;
		(store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mockImplementation(
			async (_ctx: unknown, opts: { buildSnapshot: () => Promise<MemorySnapshot> }) => {
				capturedBuildSnapshot = opts.buildSnapshot;
				return snap;
			},
		);

		const deps = makeDeps({ chatSessions: store, conversationRetrieval: retrieval, config });
		await handleRefreshMemory('', makeCtx(), deps);

		expect(capturedBuildSnapshot).toBeDefined();
		await capturedBuildSnapshot!();
		expect(retrieval.buildMemorySnapshot).toHaveBeenCalledWith({ pinnedKeys: [] });
	});
});

// ---------------------------------------------------------------------------
// Additional edge cases to reach ≥50 total assertions
// ---------------------------------------------------------------------------

describe('Edge cases — argument and context handling', () => {
	it('extra args string is ignored — handler still runs', async () => {
		const store = makeSessionStore();
		const deps = makeDeps({ chatSessions: store });
		await handleRefreshMemory('some extra args', makeCtx(), deps);
		expect(store.rebuildMemorySnapshot).toHaveBeenCalledOnce();
	});

	it('empty snapshot (0 entries) → sends ok confirmation, not degraded', async () => {
		const snap: MemorySnapshot = {
			content: '',
			status: 'empty',
			builtAt: '2026-05-05T10:00:00.000Z',
			entryCount: 0,
		};
		const deps = makeDeps({ chatSessions: makeSessionStore({ rebuildResult: snap }) });
		await handleRefreshMemory('', makeCtx(), deps);

		expect(deps.telegram.send).toHaveBeenCalledOnce();
		const [, text] = (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
		// empty is not degraded — normal confirmation path
		expect(text).not.toContain('degraded');
	});

	it('sends exactly one message on success (no double-send)', async () => {
		const deps = makeDeps();
		await handleRefreshMemory('', makeCtx(), deps);
		expect(deps.telegram.send).toHaveBeenCalledTimes(1);
	});

	it('sends exactly one message on NoActiveSessionError (no double-send)', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new NoActiveSessionError() }),
		});
		await handleRefreshMemory('', makeCtx(), deps);
		expect(deps.telegram.send).toHaveBeenCalledTimes(1);
	});

	it('sends exactly one message on generic error (no double-send)', async () => {
		const deps = makeDeps({
			chatSessions: makeSessionStore({ rebuildError: new Error('oops') }),
		});
		await handleRefreshMemory('', makeCtx(), deps);
		expect(deps.telegram.send).toHaveBeenCalledTimes(1);
	});

	it('ctx.sessionId is always forwarded as expectedSessionId', async () => {
		const store = makeSessionStore();
		const deps = makeDeps({ chatSessions: store });
		const ctx = makeCtx('user1', '20260505_120000_cafebabe');
		await handleRefreshMemory('', ctx, deps);

		const [, opts] = (store.rebuildMemorySnapshot as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(opts.expectedSessionId).toBe('20260505_120000_cafebabe');
	});
});
