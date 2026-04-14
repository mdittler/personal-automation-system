/**
 * Router context-aware promotion tests (Task 5a).
 *
 * Tests the low-confidence promotion path: when classify() returns null (below
 * threshold), the router checks recent interaction context. If a recent context
 * entry matches the low-confidence appId AND a routeVerifier is configured,
 * the message enters the verifier flow.
 *
 * Safety invariant: low-confidence results NEVER direct-route. They can only
 * proceed through the verifier.
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { ClassifyResult, LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { InteractionContextService, InteractionEntry } from '../../interaction-context/index.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';
import type { RouteVerifier, VerifyAction } from '../route-verifier.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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
		sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 99 }),
	} as unknown as TelegramService;
}

/**
 * Create an LLM mock that:
 * - Returns the given HIGH-confidence result when called first (for normal classify)
 * - Returns a LOW-confidence result when called second (for classifyWithLowConfidence)
 *
 * The second call returns the lowConfidenceResult regardless of the confidenceThreshold gate.
 */
function createMockLLMWithLowConfidence(
	highResult: ClassifyResult,
	lowResult: ClassifyResult,
): LLMService {
	const classify = vi.fn().mockResolvedValueOnce(highResult).mockResolvedValueOnce(lowResult);
	return {
		complete: vi.fn(),
		classify,
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

/**
 * Creates an LLM that always returns the same result (used for high-confidence or
 * exact-threshold tests).
 */
function createMockLLM(result: ClassifyResult): LLMService {
	return {
		complete: vi.fn(),
		classify: vi.fn().mockResolvedValue(result),
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

function createMockConfig(users: SystemConfig['users'] = []): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		fallback: 'chatbot',
		telegram: { botToken: 'test' },
		claude: { apiKey: 'test', model: 'test' },
		gui: { authToken: 'test' },
		api: { token: 'test' },
		cloudflare: {},
		webhooks: [],
		n8n: { dispatchUrl: '' },
		routing: { verification: { enabled: true, upperBound: 0.7 } },
		users,
	};
}

function createMockModule(): AppModule {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleCommand: vi.fn().mockResolvedValue(undefined),
		handlePhoto: vi.fn().mockResolvedValue(undefined),
	};
}

function createMockFallback(): FallbackHandler {
	return {
		handleUnrecognized: vi.fn().mockResolvedValue(undefined),
	} as unknown as FallbackHandler;
}

function createMockVerifier(result: VerifyAction): RouteVerifier {
	return { verify: vi.fn().mockResolvedValue(result) } as unknown as RouteVerifier;
}

function createThrowingVerifier(): RouteVerifier {
	return {
		verify: vi.fn().mockRejectedValue(new Error('verifier exploded')),
	} as unknown as RouteVerifier;
}

function createMockInteractionContext(entries: InteractionEntry[]): InteractionContextService {
	return {
		record: vi.fn(),
		getRecent: vi.fn().mockReturnValue(entries),
	};
}

// ---------------------------------------------------------------------------
// Test manifests
// ---------------------------------------------------------------------------

const foodManifest: AppManifest = {
	app: { id: 'food', name: 'Food', version: '1.0.0', description: 'Food management', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['log meal', 'grocery list', 'recipe'],
		},
	},
};

const notesManifest: AppManifest = {
	app: { id: 'notes', name: 'Notes', version: '1.0.0', description: 'Note taking', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['add note', 'view note'],
		},
	},
};

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function createTextCtx(text: string, userId = '123'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

function makeRecentEntry(appId: string): InteractionEntry {
	return {
		appId,
		action: 'view',
		timestamp: Date.now() - 60_000, // 1 minute ago
	};
}

// ---------------------------------------------------------------------------
// Test user
// ---------------------------------------------------------------------------

const testUser = {
	id: '123',
	name: 'test',
	isAdmin: false,
	enabledApps: ['*'] as string[],
	sharedScopes: [] as string[],
};

// ---------------------------------------------------------------------------
// Router builder
// ---------------------------------------------------------------------------

function buildRouter(
	apps: Array<{ manifest: AppManifest; module: AppModule }>,
	llm: LLMService,
	options?: {
		verifier?: RouteVerifier;
		interactionContext?: InteractionContextService;
		fallback?: FallbackHandler;
		chatbotApp?: RegisteredApp;
	},
): Router {
	const config = createMockConfig([testUser]);
	const cache = new ManifestCache();
	for (const app of apps) {
		cache.add(app.manifest, `/apps/${app.manifest.app.id}`);
	}

	const registry = {
		getApp: (id: string) => {
			const app = apps.find((a) => a.manifest.app.id === id);
			if (!app) return undefined;
			return {
				manifest: app.manifest,
				module: app.module,
				appDir: `/apps/${id}`,
			} as RegisteredApp;
		},
		getManifestCache: () => cache,
		getAll: () =>
			apps.map((a) => ({
				manifest: a.manifest,
				module: a.module,
				appDir: `/apps/${a.manifest.app.id}`,
			})),
		getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
	} as unknown as AppRegistry;

	return new Router({
		registry,
		llm,
		telegram: createMockTelegram(),
		fallback: options?.fallback ?? createMockFallback(),
		config,
		logger: createMockLogger(),
		fallbackMode: 'notes',
		routeVerifier: options?.verifier,
		interactionContext: options?.interactionContext,
		chatbotApp: options?.chatbotApp,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Router context-aware promotion (Task 5a)', () => {
	let foodModule: AppModule;
	let notesModule: AppModule;

	beforeEach(() => {
		foodModule = createMockModule();
		notesModule = createMockModule();
	});

	it('TC1: low-confidence match + matching interaction context + verifier confirms → routed to app', async () => {
		// First classify call (normal path) returns below-threshold confidence
		// Second classify call (classifyWithLowConfidence) returns the food intent
		const llm = createMockLLMWithLowConfidence(
			{ category: 'log meal', confidence: 0.1 }, // normal path — below 0.4 → returns null
			{ category: 'log meal', confidence: 0.25 }, // low-confidence path returns raw result
		);

		const verifier = createMockVerifier({ action: 'route', appId: 'food' });
		const interactionContext = createMockInteractionContext([makeRecentEntry('food')]);

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ verifier, interactionContext },
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('show me that recipe'));

		expect(verifier.verify).toHaveBeenCalledOnce();
		expect(foodModule.handleMessage).toHaveBeenCalledOnce();
		expect(notesModule.handleMessage).not.toHaveBeenCalled();
	});

	it('TC2: low-confidence match + matching context + verifier disagrees → chatbot fallback', async () => {
		const llm = createMockLLMWithLowConfidence(
			{ category: 'log meal', confidence: 0.1 },
			{ category: 'log meal', confidence: 0.25 },
		);

		const verifier = createMockVerifier({ action: 'route', appId: 'notes' });
		const interactionContext = createMockInteractionContext([makeRecentEntry('food')]);
		const fallback = createMockFallback();

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ verifier, interactionContext, fallback },
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('show me that recipe'));

		// Verifier suggested notes (a different appId from the low-confidence result food)
		// → falls through to fallback (chatbot)
		expect(verifier.verify).toHaveBeenCalledOnce();
		expect(foodModule.handleMessage).not.toHaveBeenCalled();
		expect(notesModule.handleMessage).not.toHaveBeenCalled();
		expect(fallback.handleUnrecognized).toHaveBeenCalledOnce();
	});

	it('TC3: low-confidence match + matching context + verifier throws → chatbot fallback (no crash)', async () => {
		const llm = createMockLLMWithLowConfidence(
			{ category: 'log meal', confidence: 0.1 },
			{ category: 'log meal', confidence: 0.25 },
		);

		const verifier = createThrowingVerifier();
		const interactionContext = createMockInteractionContext([makeRecentEntry('food')]);
		const fallback = createMockFallback();

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ verifier, interactionContext, fallback },
		);
		router.buildRoutingTables();

		// Should not throw
		await expect(router.routeMessage(createTextCtx('show me that recipe'))).resolves.toBeUndefined();

		expect(foodModule.handleMessage).not.toHaveBeenCalled();
		expect(fallback.handleUnrecognized).toHaveBeenCalledOnce();
	});

	it('TC4: low-confidence match + NO interaction context → chatbot (unchanged behavior)', async () => {
		// Normal classify returns below-threshold
		const llm = createMockLLM({ category: 'log meal', confidence: 0.1 });
		const fallback = createMockFallback();

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ fallback },
			// No interactionContext
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('show me that recipe'));

		expect(foodModule.handleMessage).not.toHaveBeenCalled();
		expect(fallback.handleUnrecognized).toHaveBeenCalledOnce();
	});

	it('TC5: low-confidence match + context for DIFFERENT appId → chatbot (context-mismatch path)', async () => {
		// Normal classify returns below-threshold (→ null), low-conf path returns food
		const llm = createMockLLMWithLowConfidence(
			{ category: 'log meal', confidence: 0.1 },   // normal: below threshold → null
			{ category: 'log meal', confidence: 0.25 },  // low-conf: food
		);

		// Context is for 'notes', not 'food' — mismatch should prevent verifier call
		const interactionContext = createMockInteractionContext([makeRecentEntry('notes')]);
		const fallback = createMockFallback();
		// Verifier is present so tryContextPromotion is actually entered, but the
		// appId mismatch check happens before verify() is called.
		const verifier = createMockVerifier({ action: 'route', appId: 'food' });

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ verifier, interactionContext, fallback },
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('show me that recipe'));

		// Context mismatch → verifier must NOT be called, falls through to chatbot
		expect(verifier.verify).not.toHaveBeenCalled();
		expect(foodModule.handleMessage).not.toHaveBeenCalled();
		expect(notesModule.handleMessage).not.toHaveBeenCalled();
		expect(fallback.handleUnrecognized).toHaveBeenCalledOnce();
	});

	it('TC6: no verifier configured + context match → chatbot (safe default)', async () => {
		const llm = createMockLLMWithLowConfidence(
			{ category: 'log meal', confidence: 0.1 },
			{ category: 'log meal', confidence: 0.25 },
		);

		const interactionContext = createMockInteractionContext([makeRecentEntry('food')]);
		const fallback = createMockFallback();

		// No verifier!
		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ interactionContext, fallback },
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('show me that recipe'));

		expect(foodModule.handleMessage).not.toHaveBeenCalled();
		expect(fallback.handleUnrecognized).toHaveBeenCalledOnce();
	});

	it('TC7: high-confidence match (≥0.4) + context → normal routing (context promotion not triggered)', async () => {
		// High confidence → normal routing, classify() does NOT return null
		const llm = createMockLLM({ category: 'log meal', confidence: 0.85 });
		const interactionContext = createMockInteractionContext([makeRecentEntry('food')]);

		// Verifier would confirm if called (but shouldn't be called for high-confidence)
		const verifier = createMockVerifier({ action: 'route', appId: 'food' });

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ verifier, interactionContext },
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('log my dinner'));

		// Direct route (high confidence above verificationUpperBound 0.7)
		expect(verifier.verify).not.toHaveBeenCalled();
		expect(foodModule.handleMessage).toHaveBeenCalledOnce();
	});

	it('TC8: verifier receives recentInteractions context string when context exists', async () => {
		const llm = createMockLLMWithLowConfidence(
			{ category: 'log meal', confidence: 0.1 },
			{ category: 'log meal', confidence: 0.25 },
		);

		const verifier = createMockVerifier({ action: 'route', appId: 'food' });
		const interactionContext = createMockInteractionContext([makeRecentEntry('food')]);

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ verifier, interactionContext },
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('show me those costs'));

		// The verifier should have been called — verify that recentInteractions was passed
		expect(verifier.verify).toHaveBeenCalledOnce();
		const verifyArgs = (verifier.verify as ReturnType<typeof vi.fn>).mock.calls[0];
		// verify(ctx, classifierResult, photoPath, enabledApps, recentInteractions)
		// recentInteractions is the 5th argument
		const recentInteractionsArg = verifyArgs[4];
		expect(typeof recentInteractionsArg).toBe('string');
		expect(recentInteractionsArg).toContain('food');
	});

	it('TC9: verifier held response → return (not fallback to chatbot)', async () => {
		const llm = createMockLLMWithLowConfidence(
			{ category: 'log meal', confidence: 0.1 },
			{ category: 'log meal', confidence: 0.25 },
		);

		const verifier = createMockVerifier({ action: 'held' });
		const interactionContext = createMockInteractionContext([makeRecentEntry('food')]);
		const fallback = createMockFallback();

		const router = buildRouter(
			[
				{ manifest: foodManifest, module: foodModule },
				{ manifest: notesManifest, module: notesModule },
			],
			llm,
			{ verifier, interactionContext, fallback },
		);
		router.buildRoutingTables();

		await router.routeMessage(createTextCtx('show me those costs'));

		// Held → just return, don't fall through to chatbot
		expect(fallback.handleUnrecognized).not.toHaveBeenCalled();
		expect(foodModule.handleMessage).not.toHaveBeenCalled();
	});
});
