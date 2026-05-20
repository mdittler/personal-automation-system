/**
 * Tests for Router SessionControlLogger telemetry wiring.
 *
 * Verifies that handleSessionControlHook emits a classification entry for every
 * zone branch (high-confidence, grey-zone, below-threshold, wrong-intent) and
 * that the shared entryId ties the classification log to the pending entry.
 *
 * REQ-CONV-NEWCHAT-009.
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache } from '../../app-registry/index.js';
import type { PendingSessionControlStore } from '../../conversation/pending-session-control-store.js';
import type { SessionControlResult } from '../../conversation/session-control-classifier.js';
import type { SessionControlLogger } from '../../conversation/session-control-logger.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockLogger(): Logger {
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

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
		sendWithButtons: vi.fn().mockResolvedValue({ messageId: 99, chatId: 1 }),
		editMessage: vi.fn().mockResolvedValue(undefined),
	};
}

function createMockLLM(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue('hi'),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'test' },
		claude: { apiKey: 'test', model: 'test' },
		gui: { authToken: 'test' },
		cloudflare: {},
		users: [{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
	};
}

function createMockPendingStore(): PendingSessionControlStore {
	return {
		attach: vi.fn(),
		get: vi.fn().mockReturnValue(undefined),
		has: vi.fn().mockReturnValue(false),
		peek: vi.fn().mockReturnValue(undefined),
		remove: vi.fn(),
	};
}

function makeSessionControlLogger(): SessionControlLogger {
	return {
		logClassification: vi.fn().mockResolvedValue(undefined),
		logConfirmation: vi.fn().mockResolvedValue(undefined),
	} as unknown as SessionControlLogger;
}

function makeConversationService() {
	return {
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
		handleTitle: vi.fn().mockResolvedValue(undefined),
	};
}

const emptyRegistry = {
	getApp: () => undefined,
	getManifestCache: () => new ManifestCache(),
	getAll: () => [],
	getLoadedAppIds: () => [],
} as unknown as AppRegistry;

function buildRouter(opts: {
	classifierResult: SessionControlResult;
	sessionControlLogger?: SessionControlLogger;
	pendingStore?: PendingSessionControlStore;
}) {
	const classifierMock = vi.fn().mockResolvedValue(opts.classifierResult);
	const conv = makeConversationService();
	const pendingStore = opts.pendingStore ?? createMockPendingStore();

	const router = new Router({
		registry: emptyRegistry,
		llm: createMockLLM(),
		telegram: createMockTelegram(),
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config: createConfig(),
		logger: createMockLogger(),
		conversationService: conv as any,
		sessionControlClassifier: classifierMock,
		pendingSessionControl: pendingStore,
		sessionControlLogger: opts.sessionControlLogger,
	});
	router.buildRoutingTables();
	return { router, classifierMock, conv, pendingStore };
}

function msg(text = 'start fresh', userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Router session-control telemetry — zone branches', () => {
	let scLogger: SessionControlLogger;

	beforeEach(() => {
		scLogger = makeSessionControlLogger();
	});

	it('wrong-intent: logClassification called with zone=wrong-intent, llm result, unmatched preFilter', async () => {
		const result: SessionControlResult = {
			intent: 'continue',
			confidence: 0.9,
			reason: 'not a new session',
			source: 'llm',
		};
		const { router } = buildRouter({ classifierResult: result, sessionControlLogger: scLogger });
		await router.routeMessage(msg());

		expect(scLogger.logClassification).toHaveBeenCalledOnce();
		const call = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.zone).toBe('wrong-intent');
		expect(call.preFilter).toBe('unmatched');
		expect(call.llm).not.toBe('skipped');
		expect(call.llm).toMatchObject({ intent: 'continue', source: 'llm' });
		expect(call.entryId).toBeUndefined();
	});

	it('below-threshold: logClassification called with zone=below-threshold', async () => {
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.2,
			reason: 'weak signal',
			source: 'llm',
		};
		const { router } = buildRouter({ classifierResult: result, sessionControlLogger: scLogger });
		await router.routeMessage(msg());

		expect(scLogger.logClassification).toHaveBeenCalledOnce();
		const call = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.zone).toBe('below-threshold');
		expect(call.entryId).toBeUndefined();
	});

	it('high-confidence (llm): logClassification called with zone=high-confidence, entryId absent', async () => {
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.9,
			reason: 'strong signal',
			source: 'llm',
		};
		const { router } = buildRouter({ classifierResult: result, sessionControlLogger: scLogger });
		await router.routeMessage(msg());

		expect(scLogger.logClassification).toHaveBeenCalledOnce();
		const call = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.zone).toBe('high-confidence');
		expect(call.entryId).toBeUndefined();
		expect(call.llm).toMatchObject({ source: 'llm' });
	});

	it('high-confidence (prefilter): llm=skipped, preFilter=matched', async () => {
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 1.0,
			reason: 'keyword match',
			source: 'prefilter',
		};
		const { router } = buildRouter({ classifierResult: result, sessionControlLogger: scLogger });
		await router.routeMessage(msg());

		expect(scLogger.logClassification).toHaveBeenCalledOnce();
		const call = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.zone).toBe('high-confidence');
		expect(call.preFilter).toBe('matched');
		expect(call.llm).toBe('skipped');
	});

	it('grey-zone: logClassification called with zone=grey-zone, entryId present', async () => {
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.55,
			reason: 'ambiguous',
			source: 'llm',
		};
		const { router } = buildRouter({ classifierResult: result, sessionControlLogger: scLogger });
		await router.routeMessage(msg());

		expect(scLogger.logClassification).toHaveBeenCalledOnce();
		const call = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.zone).toBe('grey-zone');
		expect(call.entryId).toBeDefined();
		expect(typeof call.entryId).toBe('string');
		expect(call.entryId!.length).toBeGreaterThan(0);
	});

	it('grey-zone: entryId on classification matches entryId on pending entry', async () => {
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.55,
			reason: 'ambiguous',
			source: 'llm',
		};
		const pendingStore = createMockPendingStore();
		const { router } = buildRouter({
			classifierResult: result,
			sessionControlLogger: scLogger,
			pendingStore,
		});
		await router.routeMessage(msg());

		const logCall = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const attachCall = (pendingStore.attach as ReturnType<typeof vi.fn>).mock.calls[0];
		const attachedEntry = attachCall[1]; // second arg is the entry

		expect(logCall.entryId).toBe(attachedEntry.id);
	});
});

describe('Router session-control telemetry — metadata fields', () => {
	it('includes userId, messageText, and a timestamp', async () => {
		const scLogger = makeSessionControlLogger();
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.2,
			reason: 'weak',
			source: 'llm',
		};
		const { router } = buildRouter({ classifierResult: result, sessionControlLogger: scLogger });
		const message = msg('let me start over', 'user1');
		await router.routeMessage(message);

		const call = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.userId).toBe('user1');
		expect(call.messageText).toBe('let me start over');
		expect(call.timestamp).toBeInstanceOf(Date);
	});

	it('records latencyMs as a non-negative number', async () => {
		const scLogger = makeSessionControlLogger();
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.2,
			reason: 'weak',
			source: 'llm',
		};
		const { router } = buildRouter({ classifierResult: result, sessionControlLogger: scLogger });
		await router.routeMessage(msg());

		const call = (scLogger.logClassification as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(typeof call.latencyMs).toBe('number');
		expect(call.latencyMs).toBeGreaterThanOrEqual(0);
	});
});

describe('Router session-control telemetry — fail-open cases', () => {
	it('no sessionControlLogger provided → no crash, normal routing continues', async () => {
		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.9,
			reason: 'strong',
			source: 'llm',
		};
		const { router, conv } = buildRouter({
			classifierResult: result,
			sessionControlLogger: undefined,
		});
		await expect(router.routeMessage(msg())).resolves.toBeUndefined();
		// High-confidence still dispatches handleNewChat even without logger
		expect(conv.handleNewChat).toHaveBeenCalledOnce();
	});

	it('logClassification rejects → does not crash, routing result unaffected', async () => {
		const failLogger = {
			logClassification: vi.fn().mockReturnValue(Promise.reject(new Error('disk full'))),
			logConfirmation: vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionControlLogger;

		const result: SessionControlResult = {
			intent: 'new_session',
			confidence: 0.9,
			reason: 'strong',
			source: 'llm',
		};
		const { router, conv } = buildRouter({
			classifierResult: result,
			sessionControlLogger: failLogger,
		});
		await expect(router.routeMessage(msg())).resolves.toBeUndefined();
		expect(conv.handleNewChat).toHaveBeenCalledOnce();
	});

	it('classifier throws → logClassification NOT called, returns false', async () => {
		const scLogger = makeSessionControlLogger();
		const classifierMock = vi.fn().mockRejectedValue(new Error('LLM timeout'));
		const conv = makeConversationService();

		const router = new Router({
			registry: emptyRegistry,
			llm: createMockLLM(),
			telegram: createMockTelegram(),
			fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
			config: createConfig(),
			logger: createMockLogger(),
			conversationService: conv as any,
			sessionControlClassifier: classifierMock,
			pendingSessionControl: createMockPendingStore(),
			sessionControlLogger: scLogger,
		});
		router.buildRoutingTables();

		await router.routeMessage(msg());

		expect(scLogger.logClassification).not.toHaveBeenCalled();
	});
});
