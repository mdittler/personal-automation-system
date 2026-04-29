/**
 * Integration tests: dispatchPhoto resolves session, binds expectedSessionId,
 * runs handler inside ALS, and appends photo summary to transcript.
 *
 * Seven scenarios:
 *   1. pre-existing-session — session minted first, dispatch appends 2 more turns
 *   2. no-active-session (mint path) — no prior session, dispatch mints + appends
 *   3. regression void — handler returns undefined, 0 turns appended
 *   4. regression throw — handler throws, 0 turns appended, dispatch resolves
 *   5. best-effort — appendExchange throws, dispatch still resolves
 *   6. expectedSessionId binding — appendExchange called with correct expectedSessionId
 *   7. ALS context — getCurrentUserId/HouseholdId/SessionId populated inside handler
 */

import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule, PhotoHandlerResult } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { PhotoContext, RouteInfo, TelegramService } from '../../../types/telegram.js';
import { ManifestCache, type AppRegistry, type RegisteredApp } from '../../app-registry/index.js';
import {
	getCurrentHouseholdId,
	getCurrentSessionId,
	getCurrentUserId,
} from '../../context/request-context.js';
import type { HouseholdService } from '../../household/index.js';
import { makeStoreFixture, type StoreFixture } from '../../conversation-session/__tests__/fixtures.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
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
		sendWithButtons: vi.fn().mockResolvedValue(undefined),
		editMessage: vi.fn().mockResolvedValue(undefined),
	};
}

function createMockLLM(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue('ok'),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createMockConfig(dataDir = '/tmp/data'): SystemConfig {
	return {
		port: 3000,
		dataDir,
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'test' },
		claude: { apiKey: 'test', model: 'test' },
		gui: { authToken: 'test' },
		cloudflare: {},
		users: [{ id: 'u1', name: 'User One', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
	};
}

const photoManifest: AppManifest = {
	app: { id: 'food', name: 'Food', version: '1.0.0', description: 'Food app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['food'],
			accepts_photos: true,
			photo_intents: ['receipt'],
		},
	},
};

const PHOTO_ROUTE: RouteInfo = {
	appId: 'food',
	intent: 'receipt',
	confidence: 0.9,
	source: 'photo-intent',
	verifierStatus: 'not-run',
};

function createPhotoCtx(userId = 'u1'): PhotoContext {
	return {
		userId,
		photo: Buffer.from('fake-image'),
		caption: 'grocery receipt',
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 1,
		messageId: 1,
	};
}

function makeSummaryResult(): PhotoHandlerResult {
	return {
		photoSummary: {
			userTurn: '[Photo: receipt]',
			assistantTurn: 'Got it! I recorded 3 items from your receipt.',
		},
	};
}

function buildRouter(options: {
	photoModule: AppModule;
	chatSessions?: StoreFixture['store'];
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
	logger?: Logger;
}): { router: Router; telegram: TelegramService } {
	const cache = new ManifestCache();
	cache.add(photoManifest, '/apps/food');

	const registry = {
		getApp: (id: string) => {
			if (id !== 'food') return undefined;
			return {
				manifest: photoManifest,
				module: options.photoModule,
				appDir: '/apps/food',
			} as RegisteredApp;
		},
		getManifestCache: () => cache,
		getAll: () => [{ manifest: photoManifest, module: options.photoModule, appDir: '/apps/food' }],
		getLoadedAppIds: () => ['food'],
	} as unknown as AppRegistry;

	const telegram = createMockTelegram();
	const logger = options.logger ?? createMockLogger();

	const router = new Router({
		registry,
		llm: createMockLLM(),
		telegram,
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config: createMockConfig(),
		logger,
		chatSessions: options.chatSessions as any,
		householdService: options.householdService,
	});
	router.buildRoutingTables();
	return { router, telegram };
}

// ---------------------------------------------------------------------------
// Scenario 1: pre-existing session — turns appended into existing session
// ---------------------------------------------------------------------------

describe('dispatchPhoto — pre-existing session', () => {
	let fixture: StoreFixture;

	beforeEach(async () => {
		fixture = await makeStoreFixture();
	});

	afterEach(async () => {
		const { rm } = await import('node:fs/promises');
		await rm(fixture.tempDir, { recursive: true, force: true });
	});

	it('appends photo summary turns into the existing session (total 4 turns)', async () => {
		const userId = 'u1';
		const sessionKey = `agent:main:telegram:dm:${userId}`;

		// Mint a session first with a setup exchange
		const { sessionId: existingId } = await fixture.ensure({ userId });
		expect(existingId).toBeDefined();

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(makeSummaryResult()),
		};

		const { router } = buildRouter({
			photoModule,
			chatSessions: fixture.store,
		});

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		// Read the session and verify 4 turns total (2 from setup + 2 from photo)
		const decoded = await fixture.readDecoded(userId, existingId!);
		expect(decoded.turns).toHaveLength(4);
		expect(decoded.turns[2]!.role).toBe('user');
		expect(decoded.turns[2]!.content).toBe('[Photo: receipt]');
		expect(decoded.turns[3]!.role).toBe('assistant');
		expect(decoded.turns[3]!.content).toBe('Got it! I recorded 3 items from your receipt.');
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: no-active-session (mint path)
// ---------------------------------------------------------------------------

describe('dispatchPhoto — no active session (mint path)', () => {
	let fixture: StoreFixture;

	beforeEach(async () => {
		fixture = await makeStoreFixture();
	});

	afterEach(async () => {
		const { rm } = await import('node:fs/promises');
		await rm(fixture.tempDir, { recursive: true, force: true });
	});

	it('mints a new session and appends 2 turns when no session exists', async () => {
		const userId = 'u1';

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(makeSummaryResult()),
		};

		const { router } = buildRouter({
			photoModule,
			chatSessions: fixture.store,
		});

		// Confirm no active session before dispatch
		const sessionKey = `agent:main:telegram:dm:${userId}`;
		const beforeId = await fixture.store.peekActive({ userId, sessionKey });
		expect(beforeId).toBeUndefined();

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		// A session should now exist with exactly 2 turns
		const afterId = await fixture.store.peekActive({ userId, sessionKey });
		expect(afterId).toBeDefined();

		const decoded = await fixture.readDecoded(userId, afterId!);
		expect(decoded.turns).toHaveLength(2);
		expect(decoded.turns[0]!.role).toBe('user');
		expect(decoded.turns[0]!.content).toBe('[Photo: receipt]');
		expect(decoded.turns[1]!.role).toBe('assistant');
		expect(decoded.turns[1]!.content).toBe('Got it! I recorded 3 items from your receipt.');
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: regression void — handler returns undefined → 0 turns appended
// ---------------------------------------------------------------------------

describe('dispatchPhoto — regression: void handler result', () => {
	let fixture: StoreFixture;

	beforeEach(async () => {
		fixture = await makeStoreFixture();
	});

	afterEach(async () => {
		const { rm } = await import('node:fs/promises');
		await rm(fixture.tempDir, { recursive: true, force: true });
	});

	it('does not append any turns when handler returns undefined', async () => {
		const userId = 'u1';
		const sessionKey = `agent:main:telegram:dm:${userId}`;

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		};

		const { router } = buildRouter({
			photoModule,
			chatSessions: fixture.store,
		});

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		// No session minted, no turns appended
		const sessionId = await fixture.store.peekActive({ userId, sessionKey });
		expect(sessionId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Scenario 4: regression throw — handler throws → 0 turns appended, resolves ok
// ---------------------------------------------------------------------------

describe('dispatchPhoto — regression: handler throws', () => {
	let fixture: StoreFixture;

	beforeEach(async () => {
		fixture = await makeStoreFixture();
	});

	afterEach(async () => {
		const { rm } = await import('node:fs/promises');
		await rm(fixture.tempDir, { recursive: true, force: true });
	});

	it('resolves without throwing when handler throws, and appends no turns', async () => {
		const userId = 'u1';
		const sessionKey = `agent:main:telegram:dm:${userId}`;

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockRejectedValue(new Error('handler boom')),
		};

		const { router } = buildRouter({
			photoModule,
			chatSessions: fixture.store,
		});

		// Must resolve without throwing
		await expect(
			router.dispatchPhoto(
				{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
				createPhotoCtx(userId),
				PHOTO_ROUTE,
			),
		).resolves.toBeUndefined();

		// No session minted
		const sessionId = await fixture.store.peekActive({ userId, sessionKey });
		expect(sessionId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Scenario 5: best-effort — appendExchange throws, dispatch still resolves
// ---------------------------------------------------------------------------

describe('dispatchPhoto — best-effort: appendExchange failure is non-fatal', () => {
	it('resolves without throwing when appendExchange throws, and handler was called', async () => {
		const userId = 'u1';

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(makeSummaryResult()),
		};

		// Create a spy store where appendExchange always throws
		const spyStore = {
			peekActive: vi.fn().mockResolvedValue('20260101_120000_aabbccdd'),
			appendExchange: vi.fn().mockRejectedValue(new Error('disk full')),
		};

		const { router } = buildRouter({
			photoModule,
			chatSessions: spyStore as any,
		});

		await expect(
			router.dispatchPhoto(
				{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
				createPhotoCtx(userId),
				PHOTO_ROUTE,
			),
		).resolves.toBeUndefined();

		// Handler was still called
		expect(photoModule.handlePhoto).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Scenario 6: expectedSessionId binding
// ---------------------------------------------------------------------------

describe('dispatchPhoto — expectedSessionId binding', () => {
	let fixture: StoreFixture;

	beforeEach(async () => {
		fixture = await makeStoreFixture();
	});

	afterEach(async () => {
		const { rm } = await import('node:fs/promises');
		await rm(fixture.tempDir, { recursive: true, force: true });
	});

	it('appendExchange is called with expectedSessionId matching the pre-existing session', async () => {
		const userId = 'u1';

		// Mint a session first
		const { sessionId: existingId } = await fixture.ensure({ userId });
		expect(existingId).toBeDefined();

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(makeSummaryResult()),
		};

		// Spy on appendExchange so we can verify the arguments
		const appendSpy = vi.spyOn(fixture.store, 'appendExchange');

		const { router } = buildRouter({
			photoModule,
			chatSessions: fixture.store,
		});

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		expect(appendSpy).toHaveBeenCalledOnce();
		const [appendCtx] = appendSpy.mock.calls[0]!;
		expect(appendCtx.expectedSessionId).toBe(existingId);
	});

	it('appendExchange is called WITHOUT expectedSessionId when no prior session exists', async () => {
		const userId = 'u1';

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(makeSummaryResult()),
		};

		const appendSpy = vi.spyOn(fixture.store, 'appendExchange');

		const { router } = buildRouter({
			photoModule,
			chatSessions: fixture.store,
		});

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		expect(appendSpy).toHaveBeenCalledOnce();
		const [appendCtx] = appendSpy.mock.calls[0]!;
		expect(appendCtx.expectedSessionId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Scenario 7: ALS context — userId, householdId, sessionId populated inside handler
// ---------------------------------------------------------------------------

describe('dispatchPhoto — ALS context binding', () => {
	it('getCurrentUserId() returns correct userId inside handler', async () => {
		const userId = 'u1';
		let capturedUserId: string | undefined = 'sentinel';

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockImplementation(async () => {
				capturedUserId = getCurrentUserId();
				return makeSummaryResult();
			}),
		};

		// No chatSessions needed for ALS check
		const { router } = buildRouter({ photoModule });

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		expect(capturedUserId).toBe(userId);
	});

	it('getCurrentHouseholdId() returns correct householdId when householdService is wired', async () => {
		const userId = 'u1';
		let capturedHouseholdId: string | undefined = 'sentinel';

		const householdService: Pick<HouseholdService, 'getHouseholdForUser'> = {
			getHouseholdForUser: vi.fn().mockReturnValue('hh-test'),
		};

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockImplementation(async () => {
				capturedHouseholdId = getCurrentHouseholdId();
				return makeSummaryResult();
			}),
		};

		const { router } = buildRouter({ photoModule, householdService });

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		expect(capturedHouseholdId).toBe('hh-test');
	});

	it('getCurrentSessionId() returns the active sessionId inside handler when session exists', async () => {
		const userId = 'u1';
		const EXPECTED_SESSION_ID = '20260101_120000_aabbccdd';
		let capturedSessionId: string | undefined = 'sentinel';

		const spyStore = {
			peekActive: vi.fn().mockResolvedValue(EXPECTED_SESSION_ID),
			appendExchange: vi.fn().mockResolvedValue({ sessionId: EXPECTED_SESSION_ID }),
		};

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockImplementation(async () => {
				capturedSessionId = getCurrentSessionId();
				return makeSummaryResult();
			}),
		};

		const { router } = buildRouter({
			photoModule,
			chatSessions: spyStore as any,
		});

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		expect(capturedSessionId).toBe(EXPECTED_SESSION_ID);
	});

	it('getCurrentSessionId() is undefined inside handler when no session exists', async () => {
		const userId = 'u1';
		let capturedSessionId: string | undefined = 'sentinel';

		const spyStore = {
			peekActive: vi.fn().mockResolvedValue(undefined),
			appendExchange: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
		};

		const photoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockImplementation(async () => {
				capturedSessionId = getCurrentSessionId();
				return undefined; // no summary — just checking ALS
			}),
		};

		const { router } = buildRouter({
			photoModule,
			chatSessions: spyStore as any,
		});

		await router.dispatchPhoto(
			{ manifest: photoManifest, module: photoModule, appDir: '/apps/food' } as RegisteredApp,
			createPhotoCtx(userId),
			PHOTO_ROUTE,
		);

		expect(capturedSessionId).toBeUndefined();
	});
});
