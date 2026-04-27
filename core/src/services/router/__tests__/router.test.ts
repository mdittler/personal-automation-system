import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { ClassifyResult, LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type {
	MessageContext,
	PhotoContext,
	RouteInfo,
	TelegramService,
} from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { SpaceService } from '../../spaces/index.js';
import type { FallbackHandler } from '../fallback.js';
import { Router, buildUserOverrideRouteInfo } from '../index.js';

/**
 * Assert that a dispatch mock was called with a context whose `route` field
 * matches the expected partial shape.  Use this in every branch test so that
 * missing route assertions are visually obvious on review.
 */
function expectDispatchedRoute(mockFn: Mock, expected: Partial<RouteInfo>): void {
	expect(mockFn).toHaveBeenCalledWith(
		expect.objectContaining({ route: expect.objectContaining(expected) }),
	);
}

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
): SystemConfig {
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
		options?: {
			spaceService?: SpaceService;
			conversationService?: { handleMessage: (...args: unknown[]) => Promise<void> };
		},
	): Router {
		const config = createMockConfig(users);
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
			spaceService: options?.spaceService,
			conversationService: options?.conversationService as any,
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

		it('attaches active space info to photo contexts before dispatch', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const classifyLlm = createMockLLM({ category: 'receipt', confidence: 0.9 });
			const spaceService = {
				getActiveSpace: vi.fn().mockReturnValue('family-space'),
				getSpace: vi.fn().mockReturnValue({
					id: 'family-space',
					name: 'Family Space',
					kind: 'household',
					householdId: 'hh-1',
				}),
			} as unknown as SpaceService;
			const router = buildRouter(
				users,
				[{ manifest: groceryManifest, module: groceryModule }],
				classifyLlm,
				{ spaceService },
			);

			await router.routePhoto(createPhotoCtx('grocery receipt'));

			expect(groceryModule.handlePhoto).toHaveBeenCalledWith(
				expect.objectContaining({
					spaceId: 'family-space',
					spaceName: 'Family Space',
				}),
			);
		});

		it('leaves photo contexts without space info when no active space exists', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const classifyLlm = createMockLLM({ category: 'receipt', confidence: 0.9 });
			const spaceService = {
				getActiveSpace: vi.fn().mockReturnValue(null),
				getSpace: vi.fn(),
			} as unknown as SpaceService;
			const router = buildRouter(
				users,
				[{ manifest: groceryManifest, module: groceryModule }],
				classifyLlm,
				{ spaceService },
			);

			await router.routePhoto(createPhotoCtx('grocery receipt'));

			const dispatchedCtx = vi.mocked(groceryModule.handlePhoto).mock.calls[0]?.[0];
			expect(dispatchedCtx?.spaceId).toBeUndefined();
			expect(dispatchedCtx?.spaceName).toBeUndefined();
		});
	});

	// ---------------------------------------------------------------------------
	// Route metadata plumbing (LLM plan item #1)
	// ---------------------------------------------------------------------------

	describe('route metadata — ctx.route attached at each dispatch branch', () => {
		const users = [
			{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
		];

		it('command branch attaches source:command, verifierStatus:not-run, confidence:1.0', async () => {
			const router = buildRouter(users, [{ manifest: echoManifest, module: echoModule }]);

			await router.routeMessage(createTextCtx('/echo hello'));

			expect(echoModule.handleCommand).toHaveBeenCalledWith(
				'echo',
				['hello'],
				expect.objectContaining({
					route: {
						appId: 'echo',
						intent: 'echo',
						confidence: 1.0,
						source: 'command',
						verifierStatus: 'not-run',
					},
				}),
			);
		});

		it('classifier match attaches source:intent, intent/confidence from classifier, verifierStatus:not-run when no verifier configured', async () => {
			// No routeVerifier wired in buildRouter → verifierStatus is 'not-run'
			// (verifierStatus is 'skipped' when routeVerifier IS configured but confidence ≥ upperBound)
			const highConfLlm = createMockLLM({ category: 'add grocery', confidence: 0.9 });
			const router = buildRouter(
				users,
				[{ manifest: groceryManifest, module: groceryModule }],
				highConfLlm,
			);

			await router.routeMessage(createTextCtx('I need milk'));

			expectDispatchedRoute(vi.mocked(groceryModule.handleMessage), {
				appId: 'grocery',
				intent: 'add grocery',
				confidence: 0.9,
				source: 'intent',
				verifierStatus: 'not-run',
			});
		});

		it('chatbot fallback attaches source:fallback, verifierStatus:not-run, intent:chatbot', async () => {
			// LLM returns low confidence → no match → falls through to ConversationService
			const lowConfLlm = createMockLLM({ category: 'add grocery', confidence: 0.1 });
			const conversationService = { handleMessage: vi.fn().mockResolvedValue(undefined) };

			const router = buildRouter(
				users,
				[{ manifest: groceryManifest, module: groceryModule }],
				lowConfLlm,
				{ conversationService },
			);

			await router.routeMessage(createTextCtx('hello'));

			expectDispatchedRoute(vi.mocked(conversationService.handleMessage), {
				appId: 'chatbot',
				intent: 'chatbot',
				confidence: 0,
				source: 'fallback',
				verifierStatus: 'not-run',
			});
		});

		it('photo single-app shortcut attaches source:photo-intent and confidence:1.0', async () => {
			// Single photo app → shortcut path with confidence 1.0.
			// verifierStatus is covered separately (not-run without verifier, skipped with verifier wired).
			const router = buildRouter(users, [{ manifest: groceryManifest, module: groceryModule }]);

			await router.routePhoto(createPhotoCtx('receipt from Costco'));

			expectDispatchedRoute(vi.mocked(groceryModule.handlePhoto), {
				appId: 'grocery',
				source: 'photo-intent',
				confidence: 1.0,
			});
		});

		it('photo fallback branch does not dispatch to any handler — sends "could not determine" message instead', async () => {
			// When multiple photo apps exist but the classifier returns no confident match,
			// the router sends a fallback message — no handler receives a ctx.
			// Photo fallback is intentionally handler-less (unlike text fallback which routes
			// to chatbot). This test pins that explicit decision.
			//
			// Note: the single-photo-app shortcut bypasses the classifier at confidence 1.0,
			// so we need two photo apps to exercise the classifier path where match can be null.
			const localTelegram = createMockTelegram();
			const photoApp1Module = createMockModule();
			const photoApp2Module = createMockModule();

			const photoManifest1: AppManifest = {
				app: {
					id: 'photo1',
					name: 'Photo1',
					version: '1.0.0',
					description: 'Photo app 1',
					author: 'Test',
				},
				capabilities: {
					messages: { intents: [], accepts_photos: true, photo_intents: ['receipt'] },
				},
			};
			const photoManifest2: AppManifest = {
				app: {
					id: 'photo2',
					name: 'Photo2',
					version: '1.0.0',
					description: 'Photo app 2',
					author: 'Test',
				},
				capabilities: {
					messages: { intents: [], accepts_photos: true, photo_intents: ['landscape'] },
				},
			};

			const apps = [
				{ manifest: photoManifest1, module: photoApp1Module, appDir: '/apps/photo1' },
				{ manifest: photoManifest2, module: photoApp2Module, appDir: '/apps/photo2' },
			];
			const cache = new ManifestCache();
			cache.add(photoManifest1, '/apps/photo1');
			cache.add(photoManifest2, '/apps/photo2');
			const registry = {
				getApp: (id: string) =>
					apps.find((a) => a.manifest.app.id === id) as RegisteredApp | undefined,
				getManifestCache: () => cache,
				getAll: () => apps,
				getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
			} as unknown as AppRegistry;

			// Low confidence → classifier returns null → photo fallback message
			const lowConfLlm = createMockLLM({ category: 'receipt', confidence: 0.05 });

			const router = new Router({
				registry,
				llm: lowConfLlm,
				telegram: localTelegram,
				fallback: createMockFallback(),
				config: createMockConfig(users),
				logger: createMockLogger(),
			});
			router.buildRoutingTables();

			await router.routePhoto(createPhotoCtx('some photo'));

			// No handler dispatched
			expect(photoApp1Module.handlePhoto).not.toHaveBeenCalled();
			expect(photoApp2Module.handlePhoto).not.toHaveBeenCalled();
			// Fallback message sent to user
			expect(localTelegram.send).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining("couldn't determine"),
			);
		});

		it('ctx.route field is absent from contexts built without router dispatch', () => {
			// Regression guard: manually constructed contexts must not require route
			const ctx = createTextCtx('hello');
			expect(ctx.route).toBeUndefined();
		});

		it('photo single-app shortcut attaches source:photo-intent, verifierStatus:not-run when no verifier configured', async () => {
			// Fixes: prior test name claimed "verifierStatus:skipped" but buildRouter wires no verifier.
			// Without a verifier, the code path produces 'not-run'. 'skipped' requires a wired verifier.
			const router = buildRouter(users, [{ manifest: groceryManifest, module: groceryModule }]);

			await router.routePhoto(createPhotoCtx('receipt from Costco'));

			expectDispatchedRoute(vi.mocked(groceryModule.handlePhoto), {
				appId: 'grocery',
				source: 'photo-intent',
				confidence: 1.0,
				verifierStatus: 'not-run',
			});
		});
	});
});

// ---------------------------------------------------------------------------
// buildUserOverrideRouteInfo — pure helper unit tests
// ---------------------------------------------------------------------------

describe('buildUserOverrideRouteInfo', () => {
	const classifierResult = { appId: 'food', intent: 'add grocery' };

	it('uses classifierResult.intent when user chose the classifier app', () => {
		const route = buildUserOverrideRouteInfo(classifierResult, 'food');

		expect(route).toEqual({
			appId: 'food',
			intent: 'add grocery',
			confidence: 1.0,
			source: 'user-override',
			verifierStatus: 'user-override',
		});
	});

	it('uses verifierSuggestedIntent when user chose the verifier app and intent is available', () => {
		const route = buildUserOverrideRouteInfo(classifierResult, 'notes', 'save a note');

		expect(route).toEqual({
			appId: 'notes',
			intent: 'save a note',
			confidence: 1.0,
			source: 'user-override',
			verifierStatus: 'user-override',
		});
	});

	it('falls back to chosenAppId as intent when user chose verifier app but no suggestedIntent was stored', () => {
		// This happens when the verifier LLM did not include a suggestedIntent in its response
		const route = buildUserOverrideRouteInfo(classifierResult, 'notes', undefined);

		expect(route).toEqual({
			appId: 'notes',
			intent: 'notes', // falls back to appId string as coarse label
			confidence: 1.0,
			source: 'user-override',
			verifierStatus: 'user-override',
		});
	});

	it('always produces confidence 1.0 and source user-override regardless of inputs', () => {
		const r1 = buildUserOverrideRouteInfo({ appId: 'a', intent: 'x' }, 'a');
		const r2 = buildUserOverrideRouteInfo({ appId: 'a', intent: 'x' }, 'b', 'y');
		expect(r1.confidence).toBe(1.0);
		expect(r1.source).toBe('user-override');
		expect(r2.confidence).toBe(1.0);
		expect(r2.source).toBe('user-override');
	});
});

describe('Free-text fallback — ConversationService dispatch', () => {
	const users = [
		{
			id: 'user1',
			name: 'Test',
			isAdmin: true,
			enabledApps: ['*'] as string[],
			sharedScopes: [] as string[],
		},
	];

	let telegram: TelegramService;
	let llm: LLMService;
	let fallback: FallbackHandler;
	let logger: Logger;

	function buildRouter(
		routerUsers: typeof users,
		overrideLlm?: LLMService,
		options?: {
			conversationService?: { handleMessage: (...args: unknown[]) => Promise<void> };
		},
	): Router {
		const config = createMockConfig(routerUsers);
		const cache = new ManifestCache();
		const registry = {
			getApp: () => undefined,
			getManifestCache: () => cache,
			getLoadedAppIds: () => [],
		} as unknown as AppRegistry;

		const router = new Router({
			registry,
			llm: overrideLlm ?? llm,
			telegram,
			fallback,
			config,
			logger,
			confidenceThreshold: 0.4,
			conversationService: options?.conversationService as any,
		});
		router.buildRoutingTables();
		return router;
	}

	beforeEach(() => {
		telegram = createMockTelegram();
		llm = createMockLLM({ category: 'unknown', confidence: 0.1 });
		fallback = createMockFallback();
		logger = createMockLogger();
	});

	it('free-text fallback dispatches to ConversationService', async () => {
		const conversationService = { handleMessage: vi.fn().mockResolvedValue(undefined) };
		const router = buildRouter(users, undefined, { conversationService });

		await router.routeMessage(createTextCtx('hello'));

		expect(conversationService.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('per-user chatbot disable: routes to FallbackHandler regardless of conversationService presence', async () => {
		const restrictedUsers = [
			{
				id: 'user1',
				name: 'Test',
				isAdmin: false,
				enabledApps: ['echo'] as string[],
				sharedScopes: [] as string[],
			},
		];
		const conversationService = { handleMessage: vi.fn().mockResolvedValue(undefined) };
		const router = buildRouter(restrictedUsers, undefined, { conversationService });

		await router.routeMessage(createTextCtx('hello'));

		expect(conversationService.handleMessage).not.toHaveBeenCalled();
		expect(fallback.handleUnrecognized).toHaveBeenCalled();
	});

	it('error in ConversationService.handleMessage is isolated and produces a friendly reply', async () => {
		const conversationService = {
			handleMessage: vi.fn().mockRejectedValue(new Error('boom')),
		};
		const router = buildRouter(users, undefined, { conversationService });

		await router.routeMessage(createTextCtx('hello'));

		expect(telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Something went wrong'),
		);
	});

});

