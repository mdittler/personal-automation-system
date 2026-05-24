/**
 * Shared Router test harness. Lifted from `router-multi-intent.test.ts` so
 * the multi-intent split, reply-buffer integration, and natural-language
 * persona test files can all drive the same construction path.
 *
 * Keeping a single factory means the wiring for `registry`, `messageSegmenter`,
 * `classify` mock plumbing, and conversationService injection stays consistent
 * across every test file that exercises Router internals — no test bypasses
 * the production wiring path Router needs.
 */

import type { Logger } from 'pino';
import { type Mock, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { ConversationService } from '../../conversation/conversation-service.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

// ─── Mock factories ─────────────────────────────────────────────────────────

export function createMockLogger(): Logger {
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

export function createMockTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
		sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
		editMessage: vi.fn().mockResolvedValue(undefined),
	} as unknown as TelegramService;
}

export function createMockLLM(): LLMService {
	return {
		complete: vi.fn(),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

export function createMockModule(): AppModule {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleCommand: vi.fn().mockResolvedValue(undefined),
		handlePhoto: vi.fn().mockResolvedValue(undefined),
	};
}

export function createMockFallback(): FallbackHandler {
	return {
		handleUnrecognized: vi.fn().mockResolvedValue(undefined),
	} as unknown as FallbackHandler;
}

export function createConfig(users: SystemConfig['users']): SystemConfig {
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
		users,
	} as SystemConfig;
}

// ─── Standard manifests ─────────────────────────────────────────────────────

export const echoManifest: AppManifest = {
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo something back to the user'],
			commands: [],
		},
	},
};

export const groceryManifest: AppManifest = {
	app: {
		id: 'grocery',
		name: 'Grocery',
		version: '1.0.0',
		description: 'Grocery app',
		author: 'Test',
	},
	capabilities: {
		messages: {
			intents: ['add an item to the grocery list'],
			commands: [],
		},
	},
};

export function createTextCtx(text: string, userId = 'u1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ─── Router builder ─────────────────────────────────────────────────────────

export interface BuildOptions {
	multiIntentSplit?: boolean;
	preFilter?: Mock<(text: string) => boolean>;
	segment?: Mock<(text: string, deps: unknown) => Promise<string[]>>;
	classifyResults?: Array<{ appId: string; intent: string; confidence: number } | null>;
	users?: SystemConfig['users'];
	apps?: Array<{ manifest: AppManifest; module: AppModule }>;
	includeSegmenter?: boolean;
	/** Override the telegram instance the Router holds (the "real" transport). */
	telegram?: TelegramService;
	/** Inject a ConversationService stub for dispatchConversation pinning. */
	conversationService?: ConversationService;
}

export interface BuiltRouter {
	router: Router;
	telegram: TelegramService;
	llm: LLMService;
	fallback: FallbackHandler;
	logger: Logger;
	echoModule: AppModule;
	groceryModule: AppModule;
	preFilter: Mock<(text: string) => boolean>;
	segment: Mock<(text: string, deps: unknown) => Promise<string[]>>;
}

export function buildRouter(opts: BuildOptions = {}): BuiltRouter {
	const telegram = opts.telegram ?? createMockTelegram();
	const llm = createMockLLM();
	const fallback = createMockFallback();
	const logger = createMockLogger();
	const echoModule = createMockModule();
	const groceryModule = createMockModule();

	const users = opts.users ?? [
		{ id: 'u1', name: 'Tester', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
	];
	const apps = opts.apps ?? [
		{ manifest: echoManifest, module: echoModule },
		{ manifest: groceryManifest, module: groceryModule },
	];

	const cache = new ManifestCache();
	for (const a of apps) cache.add(a.manifest, `/apps/${a.manifest.app.id}`);

	const registry = {
		getApp: (id: string) => {
			const a = apps.find((x) => x.manifest.app.id === id);
			if (!a) return undefined;
			return {
				manifest: a.manifest,
				module: a.module,
				appDir: `/apps/${id}`,
			} as RegisteredApp;
		},
		getManifestCache: () => cache,
		getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
	} as unknown as AppRegistry;

	if (opts.classifyResults) {
		let i = 0;
		(llm.classify as Mock).mockImplementation(async () => {
			const r = opts.classifyResults?.[i++];
			if (!r) return { category: 'unknown', confidence: 0.1 };
			return { category: r.intent, confidence: r.confidence };
		});
	}

	const preFilter = opts.preFilter ?? vi.fn((_text: string) => true);
	const segment = opts.segment ?? vi.fn(async (text: string) => [text]);

	const router = new Router({
		registry,
		llm,
		telegram,
		fallback,
		config: createConfig(users),
		logger,
		confidenceThreshold: 0.4,
		multiIntentSplit: opts.multiIntentSplit ?? true,
		messageSegmenter: opts.includeSegmenter === false ? undefined : { preFilter, segment },
		conversationService: opts.conversationService,
	});
	router.buildRoutingTables();

	return {
		router,
		telegram,
		llm,
		fallback,
		logger,
		echoModule,
		groceryModule,
		preFilter,
		segment,
	};
}
