import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { ClassifyResult, LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache } from '../../app-registry/index.js';
import type { InviteService } from '../../invite/index.js';
import type { UserMutationService } from '../../user-manager/user-mutation-service.js';
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

function createMockLLM(): LLMService {
	return {
		complete: vi.fn(),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 } as ClassifyResult),
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

function createMockInviteService(overrides: Partial<InviteService> = {}): InviteService {
	return {
		createInvite: vi.fn().mockResolvedValue('abc12345'),
		validateCode: vi.fn().mockResolvedValue({
			invite: { name: 'Sarah', createdBy: 'admin1', createdAt: '', expiresAt: '', usedBy: null, usedAt: null },
		}),
		claimAndRedeem: vi.fn().mockResolvedValue({
			invite: { name: 'Sarah', createdBy: 'admin1', createdAt: '', expiresAt: '', usedBy: null, usedAt: null },
		}),
		redeemCode: vi.fn().mockResolvedValue(undefined),
		listInvites: vi.fn().mockResolvedValue({}),
		cleanup: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as InviteService;
}

function createMockUserMutationService(): UserMutationService {
	return {
		registerUser: vi.fn().mockResolvedValue(undefined),
		removeUser: vi.fn().mockResolvedValue({}),
	} as unknown as UserMutationService;
}

function createTextCtx(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

const echoManifest: AppManifest = {
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo'],
			commands: [{ name: '/echo', description: 'Echo a message', args: ['message'] }],
		},
	},
};

describe('Router — /invite command', () => {
	let telegram: TelegramService;
	let llm: LLMService;
	let fallback: FallbackHandler;
	let logger: Logger;
	let inviteService: InviteService;
	let userMutationService: UserMutationService;

	function buildRouter(
		users: SystemConfig['users'],
		options?: {
			inviteService?: InviteService;
			userMutationService?: UserMutationService;
		},
	): Router {
		const config = createMockConfig(users);
		const cache = new ManifestCache();
		cache.add(echoManifest, '/apps/echo');

		const registry = {
			getApp: (id: string) => {
				if (id === 'echo') {
					return {
						manifest: echoManifest,
						module: createMockModule(),
						appDir: '/apps/echo',
					};
				}
				return undefined;
			},
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['echo'],
		} as unknown as AppRegistry;

		const router = new Router({
			registry,
			llm,
			telegram,
			fallback,
			config,
			logger,
			inviteService: options?.inviteService,
			userMutationService: options?.userMutationService,
		});
		router.buildRoutingTables();
		return router;
	}

	beforeEach(() => {
		telegram = createMockTelegram();
		llm = createMockLLM();
		fallback = createMockFallback();
		logger = createMockLogger();
		inviteService = createMockInviteService();
		userMutationService = createMockUserMutationService();
	});

	describe('/invite command', () => {
		it('should allow admin to create an invite', async () => {
			const users = [
				{ id: 'admin1', name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/invite Sarah', 'admin1'));

			expect(inviteService.createInvite).toHaveBeenCalledWith('Sarah', 'admin1');
			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('abc12345'),
			);
		});

		it('should reject non-admin users', async () => {
			const users = [
				{ id: 'user1', name: 'Regular', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/invite Sarah', 'user1'));

			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				'Only admins can create invites.',
			);
		});

		it('should show usage when no name is provided', async () => {
			const users = [
				{ id: 'admin1', name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/invite', 'admin1'));

			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				'Usage: `/invite <name>`',
			);
		});

		it('should report when invite system is not configured', async () => {
			const users = [
				{ id: 'admin1', name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users); // no inviteService

			await router.routeMessage(createTextCtx('/invite Sarah', 'admin1'));

			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				'Invite system is not configured.',
			);
		});
	});

	describe('/start with invite code — unregistered user', () => {
		it('should validate, redeem, register, and welcome a new user', async () => {
			// No users in config — the sender is unregistered
			const router = buildRouter([], { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/start abc12345', 'newuser1'));

			expect(inviteService.claimAndRedeem).toHaveBeenCalledWith('abc12345', 'newuser1');
			expect(userMutationService.registerUser).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'newuser1',
					name: 'Sarah',
					isAdmin: false,
					enabledApps: ['*'],
				}),
			);
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser1',
				expect.stringContaining('Welcome to PAS'),
			);
		});

		it('should send error for invalid invite code', async () => {
			const badInviteService = createMockInviteService({
				validateCode: vi.fn().mockResolvedValue({ error: 'Invalid invite code.' }),
				claimAndRedeem: vi.fn().mockResolvedValue({ error: 'Invalid invite code.' }),
			});
			const router = buildRouter([], { inviteService: badInviteService, userMutationService });

			await router.routeMessage(createTextCtx('/start badcode1', 'newuser1'));

			expect(telegram.send).toHaveBeenCalledWith('newuser1', 'Invalid invite code.');
			expect(userMutationService.registerUser).not.toHaveBeenCalled();
		});
	});

	describe('/start without invite code — registered user', () => {
		it('should send normal welcome message', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/start', 'user1'));

			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				'Welcome to PAS! Type /help to see available commands.',
			);
		});

		it('should tell already-registered user with invite code that they are already registered', async () => {
			const users = [
				{ id: 'user1', name: 'Test', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/start abc12345', 'user1'));

			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining('already registered'),
			);
			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});
	});

	describe('/help includes invite for admins', () => {
		it('should show /invite in help for admin users', async () => {
			const users = [
				{ id: 'admin1', name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService });

			await router.routeMessage(createTextCtx('/help', 'admin1'));

			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('/invite'),
			);
		});

		it('should not show /invite in help for non-admin users', async () => {
			const users = [
				{ id: 'user1', name: 'Regular', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService });

			await router.routeMessage(createTextCtx('/help', 'user1'));

			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				expect.not.stringContaining('/invite'),
			);
		});
	});

	describe('/invite security', () => {
		it('should pass special characters in name to invite service without sanitization', async () => {
			const users = [
				{ id: 'admin1', name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/invite <script>alert(1)</script>', 'admin1'));

			// Invite name is stored as-is — XSS protection happens at display time
			expect(inviteService.createInvite).toHaveBeenCalledWith(
				'<script>alert(1)</script>',
				'admin1',
			);
		});

		it('should escape MarkdownV2 special characters in invite response', async () => {
			const users = [
				{ id: 'admin1', name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			];
			const router = buildRouter(users, { inviteService, userMutationService });

			await router.routeMessage(createTextCtx('/invite Test.User_1', 'admin1'));

			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('abc12345'),
			);
		});
	});
});
