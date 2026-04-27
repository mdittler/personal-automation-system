/**
 * Router verification tests — grey-zone confidence disambiguation.
 *
 * Tests the optional RouteVerifier integration added to the Router.
 * Covers text and photo routing with and without a verifier configured.
 */

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
import type { AppToggleStore } from '../../app-toggle/index.js';
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
	};
}

function createMockLLM(classifyResult?: ClassifyResult): LLMService {
	return {
		complete: vi.fn(),
		classify: vi.fn().mockResolvedValue(classifyResult ?? { category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
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

/** Assert that a dispatch mock received a context whose route matches the expected partial shape. */
function expectDispatchedRoute(mockFn: Mock, expected: Partial<RouteInfo>): void {
	expect(mockFn).toHaveBeenCalledWith(
		expect.objectContaining({ route: expect.objectContaining(expected) }),
	);
}

// ---------------------------------------------------------------------------
// Test manifests
// ---------------------------------------------------------------------------

const echoManifest: AppManifest = {
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo', 'repeat'],
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
			accepts_photos: true,
			photo_intents: ['receipt'],
		},
	},
};

// Second photo app — needed to test grey-zone verification (single-app skips LLM entirely)
const photoManifest2: AppManifest = {
	app: {
		id: 'photos',
		name: 'Photos',
		version: '1.0.0',
		description: 'Photo archiving app',
		author: 'Test',
	},
	capabilities: {
		messages: {
			accepts_photos: true,
			photo_intents: ['landscape', 'portrait'],
		},
	},
};

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function createTextCtx(text: string, userId = '123'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

function createPhotoCtx(caption?: string, userId = '123'): PhotoContext {
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

// ---------------------------------------------------------------------------
// Router builder
// ---------------------------------------------------------------------------

const testUser = {
	id: '123',
	name: 'test',
	isAdmin: false,
	enabledApps: ['*'] as string[],
	sharedScopes: [] as string[],
};

function buildRouter(
	apps: Array<{ manifest: AppManifest; module: AppModule }>,
	llm: LLMService,
	verifier?: RouteVerifier,
	verificationUpperBound?: number,
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
		getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
	} as unknown as AppRegistry;

	const router = new Router({
		registry,
		llm,
		telegram: createMockTelegram(),
		fallback: createMockFallback(),
		config,
		logger: createMockLogger(),
		confidenceThreshold: 0.4,
		routeVerifier: verifier,
		verificationUpperBound,
	});
	router.buildRoutingTables();
	return router;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Router — grey-zone verification', () => {
	let echoModule: AppModule;

	beforeEach(() => {
		echoModule = createMockModule();
	});

	describe('routeMessage', () => {
		it('calls verifier when confidence is in grey zone (0.4–0.7)', async () => {
			// Confidence 0.55 — above threshold (0.4) but below upper bound (0.7)
			const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'echo',
				intent: 'echo',
				confidence: 0.55,
				verifierStatus: 'agreed',
			});

			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				greyZoneLlm,
				verifier,
			);

			await router.routeMessage(createTextCtx('something ambiguous'));

			expect(verifier.verify).toHaveBeenCalledOnce();
			expect(echoModule.handleMessage).toHaveBeenCalledOnce();
		});

		it('skips verifier when confidence is above upper bound (0.85)', async () => {
			// Confidence 0.85 — above upper bound (0.7), should skip verification
			const highConfLlm = createMockLLM({ category: 'echo', confidence: 0.85 });
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'echo',
				intent: 'echo',
				confidence: 0.85,
				verifierStatus: 'agreed',
			});

			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				highConfLlm,
				verifier,
			);

			await router.routeMessage(createTextCtx('echo this clearly'));

			expect(verifier.verify).not.toHaveBeenCalled();
			expect(echoModule.handleMessage).toHaveBeenCalledOnce();
		});

		it('does not dispatch when verifier returns held', async () => {
			const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });
			const verifier = createMockVerifier({ action: 'held' });

			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				greyZoneLlm,
				verifier,
			);

			await router.routeMessage(createTextCtx('ambiguous message'));

			expect(verifier.verify).toHaveBeenCalledOnce();
			expect(echoModule.handleMessage).not.toHaveBeenCalled();
		});

		it('works normally without a verifier configured (backward compatibility)', async () => {
			// High confidence, no verifier — should dispatch directly
			const highConfLlm = createMockLLM({ category: 'echo', confidence: 0.85 });

			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				highConfLlm,
				// no verifier
			);

			await router.routeMessage(createTextCtx('echo this'));

			expect(echoModule.handleMessage).toHaveBeenCalledOnce();
		});

		it('works normally without a verifier at grey-zone confidence (backward compatibility)', async () => {
			// Grey-zone confidence but no verifier — should still dispatch
			const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });

			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				greyZoneLlm,
				// no verifier
			);

			await router.routeMessage(createTextCtx('something ambiguous'));

			expect(echoModule.handleMessage).toHaveBeenCalledOnce();
		});

		it('rejects verifier-selected app when user does not have access', async () => {
			// User has echo enabled but NOT grocery
			const restrictedUser = {
				id: '123',
				name: 'test',
				isAdmin: false,
				enabledApps: ['echo'],
				sharedScopes: [] as string[],
			};
			const config = createMockConfig([restrictedUser]);
			const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });
			const groceryModule = createMockModule();
			// Verifier disagrees with classifier and picks grocery
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'grocery',
				intent: 'grocery',
				confidence: 0.55,
				verifierStatus: 'agreed',
			});

			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(groceryManifest, '/apps/grocery');

			const apps = [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: groceryModule },
			];
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

			const telegram = createMockTelegram();
			const router = new Router({
				registry,
				llm: greyZoneLlm,
				telegram,
				fallback: createMockFallback(),
				config,
				logger: createMockLogger(),
				confidenceThreshold: 0.4,
				routeVerifier: verifier,
			});
			router.buildRoutingTables();

			await router.routeMessage(createTextCtx('something ambiguous'));

			// Verifier was called
			expect(verifier.verify).toHaveBeenCalledOnce();
			// Grocery handler NOT called (user doesn't have access)
			expect(groceryModule.handleMessage).not.toHaveBeenCalled();
			// User told they don't have access
			expect(telegram.send).toHaveBeenCalledWith(
				'123',
				expect.stringContaining("don't have access"),
			);
		});

		it('excludes appToggle-overridden apps from verifier enabledApps', async () => {
			// User has enabledApps: ['*'] but grocery is explicitly toggled off
			const userWithWildcard = {
				id: '123',
				name: 'test',
				isAdmin: false,
				enabledApps: ['*'] as string[],
				sharedScopes: [] as string[],
			};
			const config = createMockConfig([userWithWildcard]);
			const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });
			const groceryModule = createMockModule();

			// appToggle says grocery is off for this user
			const appToggle: AppToggleStore = {
				isEnabled: vi.fn(async (_userId, appId, defaults) => {
					if (appId === 'grocery') return false;
					return defaults.includes('*') || defaults.includes(appId);
				}),
				getOverrides: vi.fn(async () => ({ grocery: false })),
			} as unknown as AppToggleStore;

			const verifier = createMockVerifier({
				action: 'route',
				appId: 'echo',
				intent: 'echo',
				confidence: 0.55,
				verifierStatus: 'agreed',
			});
			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			cache.add(groceryManifest, '/apps/grocery');

			const apps = [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: groceryModule },
			];
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
				getAll: () =>
					apps.map((a) => ({
						manifest: a.manifest,
						module: a.module,
						appDir: `/apps/${a.manifest.app.id}`,
					})),
				getManifestCache: () => cache,
				getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
			} as unknown as AppRegistry;

			const router = new Router({
				registry,
				llm: greyZoneLlm,
				telegram: createMockTelegram(),
				fallback: createMockFallback(),
				config,
				logger: createMockLogger(),
				confidenceThreshold: 0.4,
				routeVerifier: verifier,
				appToggle,
			});
			router.buildRoutingTables();

			await router.routeMessage(createTextCtx('something ambiguous'));

			// Verifier should have been called with enabledApps that excludes grocery
			expect(verifier.verify).toHaveBeenCalledOnce();
			const verifyCall = vi.mocked(verifier.verify).mock.calls[0]!;
			const passedEnabledApps = verifyCall[3] as string[];
			expect(passedEnabledApps).not.toContain('grocery');
			expect(passedEnabledApps).toContain('echo');
		});
	});

	describe('routePhoto', () => {
		let groceryModule: AppModule;
		let photoModule2: AppModule;

		beforeEach(() => {
			groceryModule = createMockModule();
			photoModule2 = createMockModule();
		});

		it('calls verifier when photo confidence is in grey zone (multiple photo apps)', async () => {
			// Grey-zone verification only applies when multiple apps compete for photos.
			// With a single photo app, the classifier routes directly at confidence 1.0 (no LLM).
			const greyZoneLlm = createMockLLM({ category: 'receipt', confidence: 0.55 });
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'grocery',
				intent: 'receipt',
				confidence: 0.55,
				verifierStatus: 'agreed',
			});

			const router = buildRouter(
				[
					{ manifest: groceryManifest, module: groceryModule },
					{ manifest: photoManifest2, module: photoModule2 },
				],
				greyZoneLlm,
				verifier,
			);

			await router.routePhoto(createPhotoCtx('grocery receipt here'));

			expect(verifier.verify).toHaveBeenCalledOnce();
			expect(groceryModule.handlePhoto).toHaveBeenCalledOnce();
		});

		it('skips verifier for photo when confidence is above upper bound (multiple photo apps)', async () => {
			const highConfLlm = createMockLLM({ category: 'receipt', confidence: 0.9 });
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'grocery',
				intent: 'receipt',
				confidence: 0.9,
				verifierStatus: 'agreed',
			});

			const router = buildRouter(
				[
					{ manifest: groceryManifest, module: groceryModule },
					{ manifest: photoManifest2, module: photoModule2 },
				],
				highConfLlm,
				verifier,
			);

			await router.routePhoto(createPhotoCtx('grocery receipt'));

			expect(verifier.verify).not.toHaveBeenCalled();
			expect(groceryModule.handlePhoto).toHaveBeenCalledOnce();
		});

		it('single photo app routes directly without LLM (confidence 1.0, no verification)', async () => {
			// When only one app accepts photos, the classifier skips LLM entirely.
			// This means confidence is always 1.0 and verifier is never invoked.
			const anyLlm = createMockLLM({ category: 'receipt', confidence: 0.55 });
			const verifier = createMockVerifier({ action: 'held' });

			const router = buildRouter(
				[{ manifest: groceryManifest, module: groceryModule }],
				anyLlm,
				verifier,
			);

			await router.routePhoto(createPhotoCtx('grocery receipt here'));

			// Verifier not called — confidence is 1.0 (above upper bound)
			expect(verifier.verify).not.toHaveBeenCalled();
			// Photo dispatched directly
			expect(groceryModule.handlePhoto).toHaveBeenCalledOnce();
		});

		it('does not dispatch photo when verifier returns held (multiple photo apps)', async () => {
			const greyZoneLlm = createMockLLM({ category: 'receipt', confidence: 0.55 });
			const verifier = createMockVerifier({ action: 'held' });

			const router = buildRouter(
				[
					{ manifest: groceryManifest, module: groceryModule },
					{ manifest: photoManifest2, module: photoModule2 },
				],
				greyZoneLlm,
				verifier,
			);

			await router.routePhoto(createPhotoCtx('some receipt'));

			expect(verifier.verify).toHaveBeenCalledOnce();
			expect(groceryModule.handlePhoto).not.toHaveBeenCalled();
		});

		it('rejects verifier-selected photo app when user does not have access', async () => {
			const restrictedUser = {
				id: '123',
				name: 'test',
				isAdmin: false,
				enabledApps: ['photos'],
				sharedScopes: [] as string[],
			};
			const config = createMockConfig([restrictedUser]);
			const greyZoneLlm = createMockLLM({ category: 'landscape', confidence: 0.55 });
			groceryModule = createMockModule();
			photoModule2 = createMockModule();
			// Verifier disagrees and picks grocery
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'grocery',
				intent: 'landscape',
				confidence: 0.55,
				verifierStatus: 'agreed',
			});

			const cache = new ManifestCache();
			cache.add(groceryManifest, '/apps/grocery');
			cache.add(photoManifest2, '/apps/photos');

			const apps = [
				{ manifest: groceryManifest, module: groceryModule },
				{ manifest: photoManifest2, module: photoModule2 },
			];
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

			const telegram = createMockTelegram();
			const router = new Router({
				registry,
				llm: greyZoneLlm,
				telegram,
				fallback: createMockFallback(),
				config,
				logger: createMockLogger(),
				confidenceThreshold: 0.4,
				routeVerifier: verifier,
			});
			router.buildRoutingTables();

			await router.routePhoto(createPhotoCtx('some receipt'));

			expect(verifier.verify).toHaveBeenCalledOnce();
			expect(groceryModule.handlePhoto).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith(
				'123',
				expect.stringContaining("don't have access"),
			);
		});
	});

	// ---------------------------------------------------------------------------
	// Route metadata plumbing — verifier branches
	// ---------------------------------------------------------------------------

	describe('route metadata — verifier path', () => {
		let echoModule: AppModule;

		beforeEach(() => {
			echoModule = createMockModule();
		});

		it('verifier-agreed dispatch attaches verifierStatus:agreed on ctx.route', async () => {
			const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });
			// Return the full new VerifyAction shape
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'echo',
				intent: 'echo',
				confidence: 0.55,
				verifierStatus: 'agreed',
			});
			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				greyZoneLlm,
				verifier,
			);

			await router.routeMessage(createTextCtx('something ambiguous'));

			expectDispatchedRoute(vi.mocked(echoModule.handleMessage), {
				appId: 'echo',
				intent: 'echo',
				confidence: 0.55,
				source: 'intent',
				verifierStatus: 'agreed',
			});
		});

		it('verifier-degraded dispatch attaches verifierStatus:degraded on ctx.route', async () => {
			const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });
			const verifier = createMockVerifier({
				action: 'route',
				appId: 'echo',
				intent: 'echo',
				confidence: 0.55,
				verifierStatus: 'degraded',
			});
			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				greyZoneLlm,
				verifier,
			);

			await router.routeMessage(createTextCtx('something ambiguous'));

			expectDispatchedRoute(vi.mocked(echoModule.handleMessage), {
				source: 'intent',
				verifierStatus: 'degraded',
			});
		});

		it('high-confidence dispatch with verifier wired attaches verifierStatus:skipped on ctx.route', async () => {
			// confidence 0.9 > verificationUpperBound (0.7) — verifier is wired but bypassed
			const highConfLlm = createMockLLM({ category: 'echo', confidence: 0.9 });
			const verifier = createMockVerifier({ action: 'held' }); // should never be called
			const router = buildRouter(
				[{ manifest: echoManifest, module: echoModule }],
				highConfLlm,
				verifier,
			);

			await router.routeMessage(createTextCtx('echo this clearly'));

			expect(verifier.verify).not.toHaveBeenCalled();
			expectDispatchedRoute(vi.mocked(echoModule.handleMessage), {
				appId: 'echo',
				source: 'intent',
				verifierStatus: 'skipped',
			});
		});
	});
});

// ---------------------------------------------------------------------------
// Hermes P1 Chunk B — verifier picks 'chatbot' with conversationService wired
// Testing-standards rule #2: post-routing authorization must apply to new target.
// ---------------------------------------------------------------------------

describe('Router — verifier selects chatbot with conversationService wired (Chunk B)', () => {
	const testUser = {
		id: 'user1',
		name: 'Test',
		isAdmin: true,
		enabledApps: ['*'] as string[],
		sharedScopes: [] as string[],
	};

	it('verifier-picked chatbot routes to ConversationService', async () => {
		const echoModule = createMockModule();
		const echoManifest: AppManifest = {
			app: { id: 'echo', name: 'Echo', version: '1.0.0', description: '', author: '' },
			capabilities: { messages: { intents: ['echo'] } },
		};

		// Verifier overrides to chatbot — testing-standards rule #2: new target is authorized
		const verifier = createMockVerifier({
			action: 'route',
			appId: 'chatbot',
			intent: 'chatbot',
		});
		// Grey-zone confidence so verifier is invoked
		const greyLlm = createMockLLM({ category: 'echo', confidence: 0.55 });

		const conversationService = { handleMessage: vi.fn().mockResolvedValue(undefined) };
		const config = createMockConfig([testUser]);
		const cache = new ManifestCache();
		cache.add(echoManifest, '/apps/echo');

		const registry = {
			getApp: (id: string) => {
				if (id === 'echo')
					return {
						manifest: echoManifest,
						module: echoModule,
						appDir: '/apps/echo',
					} as RegisteredApp;
				return undefined;
			},
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['echo'],
		} as unknown as AppRegistry;

		const router = new Router({
			registry,
			llm: greyLlm,
			telegram: createMockTelegram(),
			fallback: createMockFallback(),
			config,
			logger: createMockLogger(),
			confidenceThreshold: 0.4,
			routeVerifier: verifier,
			conversationService: conversationService as any,
		});
		router.buildRoutingTables();

		await router.routeMessage({
			userId: 'user1',
			text: 'hello',
			timestamp: new Date(),
			chatId: 1,
			messageId: 1,
		});

		expect(conversationService.handleMessage).toHaveBeenCalledTimes(1);
	});
});

describe('Router.dispatchConversation — public error isolation (rv:chatbot regression)', () => {
	it('error in ConversationService.handleMessage is caught and produces a friendly reply', async () => {
		const telegramMock = createMockTelegram();
		const conversationService = {
			handleMessage: vi.fn().mockRejectedValue(new Error('chatbot explosion')),
		};
		const testUser = {
			id: 'user1',
			name: 'Test',
			isAdmin: true,
			enabledApps: ['*'] as string[],
			sharedScopes: [] as string[],
		};
		const config = createMockConfig([testUser]);
		const cache = new ManifestCache();
		const registry = {
			getApp: (_id: string) => undefined,
			getManifestCache: () => cache,
			getLoadedAppIds: () => [] as string[],
		} as unknown as AppRegistry;

		const router = new Router({
			registry,
			llm: createMockLLM({ category: 'none', confidence: 1.0 }),
			telegram: telegramMock,
			fallback: createMockFallback(),
			config,
			logger: createMockLogger(),
			conversationService: conversationService as any,
		});

		const ctx = { userId: 'user1', text: 'boom', timestamp: new Date(), chatId: 1, messageId: 1 };
		const route = {
			appId: 'chatbot',
			intent: 'chatbot',
			confidence: 1.0,
			source: 'manual' as const,
		};

		await router.dispatchConversation(ctx, route as any);

		// Handler error was isolated — send called with friendly message, no throw
		expect(telegramMock.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Something went wrong'),
		);
	});
});
