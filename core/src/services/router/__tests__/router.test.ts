import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { ClassifyResult, LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, PhotoContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
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
		classify: vi.fn().mockResolvedValue(classifyResult ?? { category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createMockConfig(
	users: SystemConfig['users'] = [],
	fallback: 'chatbot' | 'notes' = 'chatbot',
): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		fallback,
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'test' },
		claude: { apiKey: 'test', model: 'test' },
		gui: { authToken: 'test' },
		cloudflare: {},
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

const echoManifest: AppManifest = {
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo', 'repeat'],
			commands: [{ name: '/echo', description: 'Echo a message', args: ['message'] }],
		},
	},
};

const groceryManifest: AppManifest = {
	app: {
		id: 'grocery',
		name: 'Grocery',
		version: '1.0.0',
		description: 'Grocery app',
		author: 'Test',
	},
	capabilities: {
		messages: {
			intents: ['add grocery', 'shopping'],
			commands: [{ name: '/add', description: 'Add item' }],
			accepts_photos: true,
			photo_intents: ['receipt'],
		},
	},
};

function createTextCtx(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

function createPhotoCtx(caption?: string, userId = 'user1'): PhotoContext {
	return {
		userId,
		photo: Buffer.from('fake'),
		caption,
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 1,
		messageId: 1,
	};
}

describe('Router', () => {
	let telegram: TelegramService;
	let llm: LLMService;
	let fallback: FallbackHandler;
	let logger: Logger;
	let echoModule: AppModule;
	let groceryModule: AppModule;

	// Build a mock registry with pre-loaded apps
	function buildRouter(
		users: SystemConfig['users'],
		apps: Array<{ manifest: AppManifest; module: AppModule }>,
		overrideLlm?: LLMService,
		options?: { chatbotApp?: RegisteredApp; fallbackMode?: 'chatbot' | 'notes' },
	): Router {
		const config = createMockConfig(users, options?.fallbackMode ?? 'chatbot');
		const cache = new ManifestCache();
		for (const app of apps) {
			cache.add(app.manifest, `/apps/${app.manifest.app.id}`);
		}

		// Build a mock registry
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
			getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
		} as unknown as AppRegistry;

		const router = new Router({
			registry,
			llm: overrideLlm ?? llm,
			telegram,
			fallback,
			config,
			logger,
			confidenceThreshold: 0.4,
			chatbotApp: options?.chatbotApp,
			fallbackMode: options?.fallbackMode,
		});
		router.buildRoutingTables();
		return router;
	}

	beforeEach(() => {
		telegram = createMockTelegram();
		llm = createMockLLM();
		fallback = createMockFallback();
		logger = createMockLogger();
		echoModule = createMockModule();
		groceryModule = createMockModule();
	});

	describe('routeMessage — commands', () => {
		it('should route /echo to the echo app handleCommand', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, [{ manifest: echoManifest, module: echoModule }]);

			await router.routeMessage(createTextCtx('/echo hello world'));

			expect(echoModule.handleCommand).toHaveBeenCalledWith(
				'echo',
				['hello', 'world'],
				expect.objectContaining({ text: '/echo hello world' }),
			);
		});

		it('should send unknown command message for unregistered commands', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, [{ manifest: echoManifest, module: echoModule }]);

			await router.routeMessage(createTextCtx('/unknown test'));

			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining('Unknown command'),
			);
			expect(echoModule.handleCommand).not.toHaveBeenCalled();
		});

		it('should handle built-in /help command', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, [{ manifest: echoManifest, module: echoModule }]);

			await router.routeMessage(createTextCtx('/help'));

			expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('/echo'));
			expect(echoModule.handleCommand).not.toHaveBeenCalled();
		});

		it('should handle built-in /start command', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, []);

			await router.routeMessage(createTextCtx('/start'));

			expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('Welcome'));
		});
	});

	describe('routeMessage — intent classification', () => {
		it('should classify free text and route to matching app', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const classifyLlm = createMockLLM({ category: 'add grocery', confidence: 0.85 });
			const router = buildRouter(
				users,
				[
					{ manifest: echoManifest, module: echoModule },
					{ manifest: groceryManifest, module: groceryModule },
				],
				classifyLlm,
			);

			await router.routeMessage(createTextCtx('add milk to the list'));

			expect(groceryModule.handleMessage).toHaveBeenCalled();
			expect(echoModule.handleMessage).not.toHaveBeenCalled();
		});

		it('should fall back when classification confidence is low', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const lowConfLlm = createMockLLM({ category: 'echo', confidence: 0.1 });
			const router = buildRouter(
				users,
				[{ manifest: echoManifest, module: echoModule }],
				lowConfLlm,
			);

			await router.routeMessage(createTextCtx('random gibberish'));

			expect(echoModule.handleMessage).not.toHaveBeenCalled();
			expect(fallback.handleUnrecognized).toHaveBeenCalled();
		});
	});

	describe('routeMessage — authorization', () => {
		it('should reject messages from unregistered users', async () => {
			const router = buildRouter([], [{ manifest: echoManifest, module: echoModule }]);

			await router.routeMessage(createTextCtx('/echo hello', 'unknown-user'));

			expect(telegram.send).toHaveBeenCalledWith(
				'unknown-user',
				expect.stringContaining('not authorized'),
			);
			expect(echoModule.handleCommand).not.toHaveBeenCalled();
		});

		it('should deny access to disabled apps', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: false, enabledApps: ['echo'], sharedScopes: [] },
			];
			const router = buildRouter(users, [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: groceryModule },
			]);

			await router.routeMessage(createTextCtx('/add milk'));

			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining("don't have access"),
			);
			expect(groceryModule.handleCommand).not.toHaveBeenCalled();
		});

		it('should allow wildcard (*) app access', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, [{ manifest: groceryManifest, module: groceryModule }]);

			await router.routeMessage(createTextCtx('/add milk'));

			expect(groceryModule.handleCommand).toHaveBeenCalled();
		});
	});

	describe('routeMessage — error isolation', () => {
		it('should catch and log app handler errors', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			// biome-ignore lint/style/noNonNullAssertion: mock setup for test
			vi.mocked(echoModule.handleCommand!).mockRejectedValue(new Error('app crashed'));

			const router = buildRouter(users, [{ manifest: echoManifest, module: echoModule }]);

			// Should NOT throw
			await router.routeMessage(createTextCtx('/echo boom'));

			expect(logger.error).toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('went wrong'));
		});
	});

	describe('routeMessage — chatbot fallback', () => {
		const users = [
			{
				id: 'user1',
				name: 'Test',
				isAdmin: true,
				enabledApps: ['*'] as string[],
				sharedScopes: [] as string[],
			},
		];

		it('dispatches to chatbot app when fallback mode is chatbot', async () => {
			const chatbotModule = createMockModule();
			const chatbotApp: RegisteredApp = {
				manifest: {
					app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: '', author: '' },
					capabilities: { messages: { intents: [] } },
				},
				module: chatbotModule,
				appDir: '/apps/chatbot',
			};
			const lowConfLlm = createMockLLM({ category: 'echo', confidence: 0.1 });
			const router = buildRouter(users, [], lowConfLlm, { chatbotApp, fallbackMode: 'chatbot' });

			await router.routeMessage(createTextCtx('random message'));

			expect(chatbotModule.handleMessage).toHaveBeenCalled();
			expect(fallback.handleUnrecognized).not.toHaveBeenCalled();
		});

		it('uses FallbackHandler when fallback mode is notes', async () => {
			const chatbotModule = createMockModule();
			const chatbotApp: RegisteredApp = {
				manifest: {
					app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: '', author: '' },
					capabilities: { messages: { intents: [] } },
				},
				module: chatbotModule,
				appDir: '/apps/chatbot',
			};
			const lowConfLlm = createMockLLM({ category: 'echo', confidence: 0.1 });
			const router = buildRouter(users, [], lowConfLlm, { chatbotApp, fallbackMode: 'notes' });

			await router.routeMessage(createTextCtx('random message'));

			expect(fallback.handleUnrecognized).toHaveBeenCalled();
			expect(chatbotModule.handleMessage).not.toHaveBeenCalled();
		});

		it('falls back to notes handler when chatbot mode but no chatbot app', async () => {
			const lowConfLlm = createMockLLM({ category: 'echo', confidence: 0.1 });
			const router = buildRouter(users, [], lowConfLlm, { fallbackMode: 'chatbot' });

			await router.routeMessage(createTextCtx('random message'));

			expect(fallback.handleUnrecognized).toHaveBeenCalled();
		});

		it('defaults to chatbot mode when fallbackMode not specified', async () => {
			const chatbotModule = createMockModule();
			const chatbotApp: RegisteredApp = {
				manifest: {
					app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: '', author: '' },
					capabilities: { messages: { intents: [] } },
				},
				module: chatbotModule,
				appDir: '/apps/chatbot',
			};
			const lowConfLlm = createMockLLM({ category: 'echo', confidence: 0.1 });
			// fallbackMode not passed — should default to 'chatbot'
			const config = createMockConfig(users);
			const cache = new ManifestCache();
			const registry = {
				getApp: () => undefined,
				getManifestCache: () => cache,
				getLoadedAppIds: () => [],
			} as unknown as AppRegistry;

			const router = new Router({
				registry,
				llm: lowConfLlm,
				telegram,
				fallback,
				config,
				logger,
				confidenceThreshold: 0.4,
				chatbotApp,
			});
			router.buildRoutingTables();

			await router.routeMessage(createTextCtx('random message'));

			expect(chatbotModule.handleMessage).toHaveBeenCalled();
		});

		it('does NOT dispatch to disabled chatbot app — falls back to notes handler', async () => {
			const chatbotModule = createMockModule();
			const chatbotApp: RegisteredApp = {
				manifest: {
					app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: '', author: '' },
					capabilities: { messages: { intents: [] } },
				},
				module: chatbotModule,
				appDir: '/apps/chatbot',
			};
			// User only has 'echo' enabled — chatbot is NOT in the list
			const restrictedUsers = [
				{
					id: 'user1',
					name: 'Test',
					isAdmin: false,
					enabledApps: ['echo'] as string[],
					sharedScopes: [] as string[],
				},
			];
			const lowConfLlm = createMockLLM({ category: 'echo', confidence: 0.1 });
			const router = buildRouter(restrictedUsers, [], lowConfLlm, {
				chatbotApp,
				fallbackMode: 'chatbot',
			});

			await router.routeMessage(createTextCtx('random message'));

			expect(chatbotModule.handleMessage).not.toHaveBeenCalled();
			expect(fallback.handleUnrecognized).toHaveBeenCalled();
		});

		it('catches chatbot app errors and sends error message', async () => {
			const chatbotModule = createMockModule();
			vi.mocked(chatbotModule.handleMessage).mockRejectedValue(new Error('chatbot crashed'));
			const chatbotApp: RegisteredApp = {
				manifest: {
					app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: '', author: '' },
					capabilities: { messages: { intents: [] } },
				},
				module: chatbotModule,
				appDir: '/apps/chatbot',
			};
			const lowConfLlm = createMockLLM({ category: 'echo', confidence: 0.1 });
			const router = buildRouter(users, [], lowConfLlm, { chatbotApp, fallbackMode: 'chatbot' });

			await router.routeMessage(createTextCtx('random message'));

			expect(logger.error).toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('went wrong'));
		});
	});

	describe('routePhoto', () => {
		it('should route photos to the matching app', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const classifyLlm = createMockLLM({ category: 'receipt', confidence: 0.9 });
			const router = buildRouter(
				users,
				[{ manifest: groceryManifest, module: groceryModule }],
				classifyLlm,
			);

			await router.routePhoto(createPhotoCtx('grocery receipt'));

			expect(groceryModule.handlePhoto).toHaveBeenCalled();
		});

		it('should reject photos from unregistered users', async () => {
			const router = buildRouter([], [{ manifest: groceryManifest, module: groceryModule }]);

			await router.routePhoto(createPhotoCtx(undefined, 'unknown'));

			expect(telegram.send).toHaveBeenCalledWith(
				'unknown',
				expect.stringContaining('not authorized'),
			);
		});

		it('should handle no photo apps gracefully', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, [
				{ manifest: echoManifest, module: echoModule }, // no photo support
			]);

			await router.routePhoto(createPhotoCtx());

			expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('No apps'));
		});
	});
});
