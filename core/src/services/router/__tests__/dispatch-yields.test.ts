/**
 * TDD Batch 3 — Phase 2: dispatchMessage yields to fallback when handler returns {handled: false}.
 *
 * RED: dispatchMessage ignores the return value of handleMessage.
 * GREEN: dispatchMessage calls sendToFallback when handleMessage returns {handled: false}.
 */
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { ClassifyResult, LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { ManifestCache, type AppRegistry, type RegisteredApp } from '../../app-registry/index.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

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
	};
}

function createMockLLM(classifyResult?: ClassifyResult): LLMService {
	return {
		complete: vi.fn(),
		classify: vi
			.fn()
			.mockResolvedValue(classifyResult ?? { category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createMockFallback(): FallbackHandler {
	return {
		handleUnrecognized: vi.fn().mockResolvedValue(undefined),
	} as unknown as FallbackHandler;
}

function createMockModule(): AppModule {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleCommand: vi.fn().mockResolvedValue(undefined),
		handlePhoto: vi.fn().mockResolvedValue(undefined),
	};
}

const echoManifest: AppManifest = {
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo', 'repeat'],
		},
	},
};

function createTextCtx(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

function buildRouter(
	echoModule: AppModule,
	overrideLlm: LLMService,
	telegram: TelegramService,
	fallback: FallbackHandler,
	logger: Logger,
): Router {
	const config: SystemConfig = {
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
	const cache = new ManifestCache();
	cache.add(echoManifest, '/apps/echo');

	const registry = {
		getApp: (id: string) => {
			if (id !== 'echo') return undefined;
			return { manifest: echoManifest, module: echoModule, appDir: '/apps/echo' } as RegisteredApp;
		},
		getManifestCache: () => cache,
		getLoadedAppIds: () => ['echo'],
	} as unknown as AppRegistry;

	const router = new Router({
		registry,
		llm: overrideLlm,
		telegram,
		fallback,
		config,
		logger,
		confidenceThreshold: 0.4,
	});
	router.buildRoutingTables();
	return router;
}

describe('dispatchMessage HandlerResult contract', () => {
	let telegram: TelegramService;
	let fallback: FallbackHandler;
	let logger: Logger;

	beforeEach(() => {
		telegram = createMockTelegram();
		fallback = createMockFallback();
		logger = createMockLogger();
	});

	// ── RED test ────────────────────────────────────────────────────────────────
	it('calls fallback when handleMessage returns {handled: false}', async () => {
		const echoModule = createMockModule();
		vi.mocked(echoModule.handleMessage).mockResolvedValue({ handled: false });

		const highConfLLM = createMockLLM({ category: 'echo', confidence: 0.95 });
		const router = buildRouter(echoModule, highConfLLM, telegram, fallback, logger);

		await router.routeMessage(createTextCtx('echo something'));

		// Without the HandlerResult fix this call never happens — RED test fails.
		expect(fallback.handleUnrecognized).toHaveBeenCalledTimes(1);
		expect(fallback.handleUnrecognized).toHaveBeenCalledWith(
			expect.objectContaining({ text: 'echo something' }),
			telegram,
		);
	});

	// ── Regression guards ────────────────────────────────────────────────────────
	it('does NOT call fallback when handleMessage returns void (legacy contract)', async () => {
		const echoModule = createMockModule();
		vi.mocked(echoModule.handleMessage).mockResolvedValue(undefined);

		const highConfLLM = createMockLLM({ category: 'echo', confidence: 0.95 });
		const router = buildRouter(echoModule, highConfLLM, telegram, fallback, logger);

		await router.routeMessage(createTextCtx('echo something'));

		expect(fallback.handleUnrecognized).not.toHaveBeenCalled();
	});

	it('does NOT call fallback when handleMessage returns {handled: true}', async () => {
		const echoModule = createMockModule();
		vi.mocked(echoModule.handleMessage).mockResolvedValue({ handled: true });

		const highConfLLM = createMockLLM({ category: 'echo', confidence: 0.95 });
		const router = buildRouter(echoModule, highConfLLM, telegram, fallback, logger);

		await router.routeMessage(createTextCtx('echo something'));

		expect(fallback.handleUnrecognized).not.toHaveBeenCalled();
	});

	it('does NOT call fallback when handleMessage throws (error isolation path)', async () => {
		const echoModule = createMockModule();
		vi.mocked(echoModule.handleMessage).mockRejectedValue(new Error('handler error'));

		const highConfLLM = createMockLLM({ category: 'echo', confidence: 0.95 });
		const router = buildRouter(echoModule, highConfLLM, telegram, fallback, logger);

		await router.routeMessage(createTextCtx('echo something'));

		// Error isolation: sends "Something went wrong", does NOT call fallback
		expect(telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Something went wrong'),
		);
		expect(fallback.handleUnrecognized).not.toHaveBeenCalled();
	});
})
