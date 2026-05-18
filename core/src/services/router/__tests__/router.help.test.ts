/**
 * Router `/help` rendering tests (Batch 1B+).
 *
 * Locks in the contract that `sendHelp` walks `getEffectiveCommandCatalog`
 * rather than hand-emitting hardcoded command lists. Drift between the
 * rendered help and the actual dispatch surface is the failure mode this
 * batch closes.
 *
 * Strategy:
 *   - Build a Router with the production wiring shape (registry, appToggle,
 *     userManager, optional conversationService, optional inviteService).
 *   - Send `/help` and capture the telegram.send payload.
 *   - Assert on the rendered text for admin / non-admin / app-disable /
 *     alias / no-conv-service cases.
 */

import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { AppToggleStore } from '../../app-toggle/index.js';
import type { ConversationService } from '../../conversation/conversation-service.js';
import type { InviteService } from '../../invite/index.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

// ---------------------------------------------------------------------------
// Mocks
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
	} as unknown as TelegramService;
}

function createMockLLM(): LLMService {
	return {
		complete: vi.fn(),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

function createConfig(users: SystemConfig['users']): SystemConfig {
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
	};
}

function createMockConversationService() {
	return {
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
		handleTitle: vi.fn().mockResolvedValue(undefined),
		handleRecall: vi.fn().mockResolvedValue(undefined),
		handleRefreshMemory: vi.fn().mockResolvedValue(undefined),
		handleFlushMemory: vi.fn().mockResolvedValue(undefined),
		handleSettings: vi.fn().mockResolvedValue(undefined),
	} as unknown as ConversationService;
}

function createMockInviteService(): InviteService {
	return {
		createInvite: vi.fn(),
		claimAndRedeem: vi.fn(),
	} as unknown as InviteService;
}

const notesManifest: AppManifest = {
	app: { id: 'notes', name: 'Notes', version: '1.0.0', description: 'Notes app', author: 'Test' },
	capabilities: {
		messages: {
			commands: [{ name: '/note', description: 'Add a note' }],
		},
	},
};

const foodManifest: AppManifest = {
	app: { id: 'food', name: 'Food', version: '1.0.0', description: 'Food app', author: 'Test' },
	capabilities: {
		messages: {
			commands: [{ name: '/recipes', description: 'List recipes' }],
		},
	},
};

interface BuildOpts {
	user: { id: string; name: string; isAdmin: boolean; enabledApps?: string[] };
	installedApps?: Array<{ manifest: AppManifest; module: AppModule }>;
	conversationServiceWired?: boolean;
	withInviteService?: boolean;
}

function makeRouterFor(opts: BuildOpts): { router: Router; telegram: TelegramService } {
	const installed = opts.installedApps ?? [
		{ manifest: notesManifest, module: createMockModule() },
		{ manifest: foodManifest, module: createMockModule() },
	];
	const cache = new ManifestCache();
	for (const a of installed) cache.add(a.manifest, `/apps/${a.manifest.app.id}`);

	const registered: RegisteredApp[] = installed.map((a) => ({
		manifest: a.manifest,
		module: a.module,
		appDir: `/apps/${a.manifest.app.id}`,
	}));
	const registry = {
		getApp: (id: string) => registered.find((r) => r.manifest.app.id === id),
		getAll: () => registered,
		getManifestCache: () => cache,
		getLoadedAppIds: () => registered.map((r) => r.manifest.app.id),
	} as unknown as AppRegistry;

	const enabledApps = opts.user.enabledApps ?? ['*'];
	const config = createConfig([
		{
			id: opts.user.id,
			name: opts.user.name,
			isAdmin: opts.user.isAdmin,
			enabledApps,
			sharedScopes: [],
		},
	]);

	// AppToggle returns true iff the app is in enabledApps (or wildcard).
	const appToggle: AppToggleStore = {
		isEnabled: vi.fn(
			(_uid: string, appId: string, ea: string[]) => ea.includes('*') || ea.includes(appId),
		),
		getOverrides: vi.fn().mockResolvedValue({}),
	} as unknown as AppToggleStore;

	const telegram = createMockTelegram();
	const conv =
		opts.conversationServiceWired === false ? undefined : createMockConversationService();
	const invite = opts.withInviteService === false ? undefined : createMockInviteService();

	const router = new Router({
		registry,
		llm: createMockLLM(),
		telegram,
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config,
		logger: createMockLogger(),
		conversationService: conv,
		appToggle,
		inviteService: invite,
	});
	router.buildRoutingTables();
	return { router, telegram };
}

function msg(text: string, userId: string): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

async function captureSendHelp(
	router: Router,
	telegram: TelegramService,
	userId: string,
): Promise<string> {
	await router.routeMessage(msg('/help', userId));
	const calls = (telegram.send as ReturnType<typeof vi.fn>).mock.calls;
	if (calls.length === 0) throw new Error('telegram.send was not called');
	return calls.map(([, t]) => t as string).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Router /help rendering via getEffectiveCommandCatalog', () => {
	it('renders /invite for an admin user', async () => {
		const { router, telegram } = makeRouterFor({
			user: { id: '1', name: 'A', isAdmin: true },
		});
		const out = await captureSendHelp(router, telegram, '1');
		expect(out).toContain('/invite');
	});

	it('omits /invite for a non-admin user', async () => {
		const { router, telegram } = makeRouterFor({
			user: { id: '2', name: 'B', isAdmin: false },
		});
		const out = await captureSendHelp(router, telegram, '2');
		expect(out).not.toContain('/invite');
	});

	it('omits commands from apps disabled for the user', async () => {
		const { router, telegram } = makeRouterFor({
			user: { id: '3', name: 'C', isAdmin: false, enabledApps: ['notes'] },
		});
		const out = await captureSendHelp(router, telegram, '3');
		expect(out).not.toContain('/recipes'); // food disabled
		expect(out).toContain('/note'); // notes enabled
	});

	it('renders aliases inline for /newchat (so both /newchat and /reset are visible)', async () => {
		const { router, telegram } = makeRouterFor({
			user: { id: '4', name: 'D', isAdmin: false },
			conversationServiceWired: true,
		});
		const out = await captureSendHelp(router, telegram, '4');
		expect(out).toContain('/newchat');
		expect(out).toContain('/reset');
	});

	it('omits conversation commands when ConversationService is not wired', async () => {
		const { router, telegram } = makeRouterFor({
			user: { id: '5', name: 'E', isAdmin: false },
			conversationServiceWired: false,
		});
		const out = await captureSendHelp(router, telegram, '5');
		expect(out).not.toContain('/ask');
		expect(out).not.toContain('/recall');
	});
});
