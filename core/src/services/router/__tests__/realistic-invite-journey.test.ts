/**
 * Realistic invite code journey tests — natural language from real users.
 *
 * Simulates how non-technical family members actually interact with invite codes:
 * typos, confusion, Telegram deep links, copy-paste issues, and natural phrasing.
 *
 * Tests the UserGuard gate (unregistered users) and Router invite commands
 * (registered admin users) using the same message patterns a real household
 * would produce.
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppManifest } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { ClassifyResult, LLMService } from '../../../types/llm.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache } from '../../app-registry/index.js';
import type { InviteService } from '../../invite/index.js';
import type { UserManager } from '../../user-manager/index.js';
import type { UserMutationService } from '../../user-manager/user-mutation-service.js';
import { UserGuard } from '../../user-manager/user-guard.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

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

function createMockLLM(): LLMService {
	return {
		complete: vi.fn(),
		classify: vi
			.fn()
			.mockResolvedValue({ category: 'unknown', confidence: 0.1 } as ClassifyResult),
		extractStructured: vi.fn(),
	};
}

function createMockUserManager(registeredIds: string[]): UserManager {
	const idSet = new Set(registeredIds);
	return {
		isRegistered: vi.fn((id: string) => idSet.has(id)),
		getUser: vi.fn((id: string) =>
			idSet.has(id) ? { id, name: `User-${id}`, isAdmin: false } : null,
		),
		getAllUsers: vi.fn(() => []),
		getUserApps: vi.fn(() => ['*']),
		getSharedScopes: vi.fn(() => []),
		isAppEnabled: vi.fn().mockResolvedValue(true),
		addUser: vi.fn(),
		removeUser: vi.fn(),
		updateUserApps: vi.fn(),
		updateUserSharedScopes: vi.fn(),
		validateConfig: vi.fn(() => []),
	} as unknown as UserManager;
}

function createMockInviteService(
	validateResult: { invite: { name: string } } | { error: string },
): InviteService {
	return {
		validateCode: vi.fn(async () => validateResult),
		claimAndRedeem: vi.fn(async () => validateResult),
		redeemCode: vi.fn(async () => {}),
		createInvite: vi.fn().mockResolvedValue('d3f7a8c2'),
		listInvites: vi.fn().mockResolvedValue({}),
		cleanup: vi.fn(),
	} as unknown as InviteService;
}

function createMockUserMutationService(): UserMutationService {
	return {
		registerUser: vi.fn(async () => {}),
		removeUser: vi.fn().mockResolvedValue({}),
		updateUserApps: vi.fn(),
		updateUserSharedScopes: vi.fn(),
	} as unknown as UserMutationService;
}

function createMockFallback(): FallbackHandler {
	return {
		handleUnrecognized: vi.fn().mockResolvedValue(undefined),
	} as unknown as FallbackHandler;
}

function createTextCtx(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ---------------------------------------------------------------------------
// Test: UserGuard — what unregistered users actually type
// ---------------------------------------------------------------------------

describe('Realistic invite journeys — UserGuard (unregistered users)', () => {
	let telegram: TelegramService;
	let logger: Logger;
	let inviteService: InviteService;
	let userMutationService: UserMutationService;

	function buildGuard(
		registeredIds: string[],
		inviteResult: { invite: { name: string } } | { error: string },
	): UserGuard {
		inviteService = createMockInviteService(inviteResult);
		userMutationService = createMockUserMutationService();
		return new UserGuard({
			userManager: createMockUserManager(registeredIds),
			telegram,
			logger,
			inviteService,
			userMutationService,
		});
	}

	beforeEach(() => {
		telegram = createMockTelegram();
		logger = createMockLogger();
	});

	const validInvite = {
		invite: { name: 'Sarah', householdId: 'default' },
	};

	const expiredInvite = {
		error: 'This invite code has expired. Ask the admin for a new one.',
	};

	const usedInvite = {
		error: 'This invite code has already been used.',
	};

	const invalidInvite = {
		error: 'Invalid invite code.',
	};

	// ═══════════════════════════════════════════════════════════════════════
	// Section 1: The happy path — what we tell them to do
	// ═══════════════════════════════════════════════════════════════════════

	describe('new user follows the invite instructions', () => {
		it('"a1b2c3d4" — admin texts them the code, they paste it in', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.claimAndRedeem).toHaveBeenCalledWith('a1b2c3d4', 'newuser');
			expect(userMutationService.registerUser).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'newuser', name: 'Sarah' }),
			);
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('Welcome to PAS, Sarah'),
			);
		});

		it('"/start a1b2c3d4" — they click the t.me deep link the admin shared', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', '/start a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.claimAndRedeem).toHaveBeenCalledWith('a1b2c3d4', 'newuser');
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('Welcome'),
			);
		});

		it('"  a1b2c3d4  " — they copy-pasted the code and got extra spaces', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', '  a1b2c3d4  ');
			expect(result).toBe(true);
			expect(inviteService.claimAndRedeem).toHaveBeenCalledWith('a1b2c3d4', 'newuser');
		});

		it('"/start  a1b2c3d4" — double space after /start from copy-paste', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', '/start  a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.claimAndRedeem).toHaveBeenCalledWith('a1b2c3d4', 'newuser');
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 2: What confused users actually type first
	// ═══════════════════════════════════════════════════════════════════════

	describe('confused user — sends the wrong thing before figuring it out', () => {
		it('"hi" — just says hello to the bot', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'hi');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('not registered'),
			);
		});

		it('"hello, my husband said I should use this app?" — asks a question', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser(
				'newuser',
				'hello, my husband said I should use this app?',
			);
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"how do I join?" — asks how to get started', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'how do I join?');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"my code is a1b2c3d4" — wraps the code in a sentence', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'my code is a1b2c3d4');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"Code: a1b2c3d4" — prefixes the code with a label', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'Code: a1b2c3d4');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"Here is my invite code: a1b2c3d4" — writes a full sentence', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser(
				'newuser',
				'Here is my invite code: a1b2c3d4',
			);
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"A1B2C3D4" — types the code in uppercase', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'A1B2C3D4');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"a1b2c3d" — only types 7 characters (one short)', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'a1b2c3d');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"a1b2c3d4e5" — types too many characters', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'a1b2c3d4e5');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"start a1b2c3d4" — forgets the slash on /start', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'start a1b2c3d4');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"I got sent a code" — mentions a code without providing it', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'I got sent a code');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});

		it('"add me to the grocery list" — tries to use the app before registering', async () => {
			const guard = buildGuard([], validInvite);
			const result = await guard.checkUser('newuser', 'add me to the grocery list');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 3: Bad codes — expired, used, or nonexistent
	// ═══════════════════════════════════════════════════════════════════════

	describe('user sends a code that is no longer valid', () => {
		it('"deadbeef" — the code expired yesterday', async () => {
			const guard = buildGuard([], expiredInvite);
			const result = await guard.checkUser('newuser', 'deadbeef');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).toHaveBeenCalledWith('deadbeef', 'newuser');
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('expired'),
			);
		});

		it('"/start deadbeef" — expired code via deep link', async () => {
			const guard = buildGuard([], expiredInvite);
			const result = await guard.checkUser('newuser', '/start deadbeef');
			expect(result).toBe(false);
			expect(inviteService.claimAndRedeem).toHaveBeenCalledWith('deadbeef', 'newuser');
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('expired'),
			);
		});

		it('"abcd1234" — someone already used this code', async () => {
			const guard = buildGuard([], usedInvite);
			const result = await guard.checkUser('newuser', 'abcd1234');
			expect(result).toBe(false);
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('already been used'),
			);
		});

		it('"00000000" — code that was never created', async () => {
			const guard = buildGuard([], invalidInvite);
			const result = await guard.checkUser('newuser', '00000000');
			expect(result).toBe(false);
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('Invalid invite code'),
			);
		});

		it('"/start 00000000" — invalid code via deep link', async () => {
			const guard = buildGuard([], invalidInvite);
			const result = await guard.checkUser('newuser', '/start 00000000');
			expect(result).toBe(false);
			expect(telegram.send).toHaveBeenCalledWith(
				'newuser',
				expect.stringContaining('Invalid invite code'),
			);
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 4: Already-registered user — code-like text shouldn't redeem
	// ═══════════════════════════════════════════════════════════════════════

	describe('registered user sends something that looks like an invite code', () => {
		it('"a1b2c3d4" — registered user accidentally pastes a code', async () => {
			const guard = buildGuard(['existing'], validInvite);
			const result = await guard.checkUser('existing', 'a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
			expect(telegram.send).not.toHaveBeenCalled();
		});

		it('"/start a1b2c3d4" — registered user clicks an old deep link', async () => {
			const guard = buildGuard(['existing'], validInvite);
			const result = await guard.checkUser('existing', '/start a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});
	});
});

// ---------------------------------------------------------------------------
// Test: Router — admin /invite command with natural phrasing
// ---------------------------------------------------------------------------

describe('Realistic invite journeys — Router (admin /invite command)', () => {
	let telegram: TelegramService;
	let llm: LLMService;
	let fallback: FallbackHandler;
	let logger: Logger;
	let inviteService: InviteService;
	let userMutationService: UserMutationService;

	const echoManifest: AppManifest = {
		app: {
			id: 'echo',
			name: 'Echo',
			version: '1.0.0',
			description: 'Echo app',
			author: 'Test',
		},
		capabilities: {
			messages: {
				intents: ['echo'],
				commands: [{ name: '/echo', description: 'Echo a message', args: ['message'] }],
			},
		},
	};

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

	function buildRouter(users: SystemConfig['users']): Router {
		const config = createMockConfig(users);
		const cache = new ManifestCache();
		cache.add(echoManifest, '/apps/echo');

		const registry = {
			getApp: (id: string) => {
				if (id === 'echo') {
					return {
						manifest: echoManifest,
						module: {
							init: vi.fn(),
							handleMessage: vi.fn(),
							handleCommand: vi.fn(),
							handlePhoto: vi.fn(),
						},
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
			inviteService,
			userMutationService,
		});
		router.buildRoutingTables();
		return router;
	}

	beforeEach(() => {
		telegram = createMockTelegram();
		llm = createMockLLM();
		fallback = createMockFallback();
		logger = createMockLogger();
		inviteService = createMockInviteService({ invite: { name: 'Mock' } });
		userMutationService = createMockUserMutationService();
	});

	const adminUser = {
		id: 'admin1',
		name: 'Dad',
		isAdmin: true,
		enabledApps: ['*'],
		sharedScopes: [],
	};
	const regularUser = {
		id: 'user1',
		name: 'Mom',
		isAdmin: false,
		enabledApps: ['*'],
		sharedScopes: [],
	};

	// ═══════════════════════════════════════════════════════════════════════
	// Section 5: Admin creating invites — what they'd actually type
	// ═══════════════════════════════════════════════════════════════════════

	describe('admin creates invites with various name styles', () => {
		it('"/invite Sarah" — simple first name', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/invite Sarah', 'admin1'));
			expect(inviteService.createInvite).toHaveBeenCalledWith('Sarah', 'admin1', expect.objectContaining({ householdId: 'default' }));
			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('d3f7a8c2'),
			);
		});

		it('"/invite Mom" — family nickname', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/invite Mom', 'admin1'));
			expect(inviteService.createInvite).toHaveBeenCalledWith('Mom', 'admin1', expect.objectContaining({ householdId: 'default' }));
		});

		it('"/invite Sarah Johnson" — full name with space', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/invite Sarah Johnson', 'admin1'));
			expect(inviteService.createInvite).toHaveBeenCalledWith('Sarah Johnson', 'admin1', expect.objectContaining({ householdId: 'default' }));
		});

		it('"/invite my wife" — descriptive name', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/invite my wife', 'admin1'));
			expect(inviteService.createInvite).toHaveBeenCalledWith('my wife', 'admin1', expect.objectContaining({ householdId: 'default' }));
		});

		it('"/invite Grandma 👵" — name with emoji', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/invite Grandma 👵', 'admin1'));
			expect(inviteService.createInvite).toHaveBeenCalledWith('Grandma 👵', 'admin1', expect.objectContaining({ householdId: 'default' }));
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 6: Things admins get wrong
	// ═══════════════════════════════════════════════════════════════════════

	describe('admin gets the command wrong', () => {
		it('"/invite" — forgets the name', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/invite', 'admin1'));
			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('Usage'),
			);
		});

		it('"/invite " — just a trailing space, no name', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/invite ', 'admin1'));
			expect(inviteService.createInvite).not.toHaveBeenCalled();
		});

		it('"invite Sarah" — forgets the slash', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('invite Sarah', 'admin1'));
			// Without slash, this is free text → goes to LLM classification, NOT /invite
			expect(inviteService.createInvite).not.toHaveBeenCalled();
		});

		it('"can you invite Sarah?" — tries natural language instead of command', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('can you invite Sarah?', 'admin1'));
			expect(inviteService.createInvite).not.toHaveBeenCalled();
		});

		it('"add Sarah as a user" — tries natural language for user management', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('add Sarah as a user', 'admin1'));
			expect(inviteService.createInvite).not.toHaveBeenCalled();
		});

		it('"I want to invite someone" — no name, conversational', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(
				createTextCtx('I want to invite someone', 'admin1'),
			);
			expect(inviteService.createInvite).not.toHaveBeenCalled();
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 7: Non-admin tries to create invites
	// ═══════════════════════════════════════════════════════════════════════

	describe('non-admin tries /invite', () => {
		it('"/invite Sarah" from regular user — gets permission denied', async () => {
			const router = buildRouter([adminUser, regularUser]);
			await router.routeMessage(createTextCtx('/invite Sarah', 'user1'));
			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining('Only admins'),
			);
		});

		it('"/invite Mom" from regular user — also denied', async () => {
			const router = buildRouter([adminUser, regularUser]);
			await router.routeMessage(createTextCtx('/invite Mom', 'user1'));
			expect(inviteService.createInvite).not.toHaveBeenCalled();
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 8: /help shows invite for admins only
	// ═══════════════════════════════════════════════════════════════════════

	describe('/help — invite visibility', () => {
		it('admin sees /invite in help', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/help', 'admin1'));
			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('/invite'),
			);
		});

		it('regular user does NOT see /invite in help', async () => {
			const router = buildRouter([adminUser, regularUser]);
			await router.routeMessage(createTextCtx('/help', 'user1'));
			expect(telegram.send).toHaveBeenCalledWith(
				'user1',
				expect.not.stringContaining('/invite'),
			);
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 9: /start for registered users
	// ═══════════════════════════════════════════════════════════════════════

	describe('/start — registered user edge cases', () => {
		it('"/start" — registered user gets welcome message', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/start', 'admin1'));
			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('Welcome to PAS'),
			);
		});

		it('"/start a1b2c3d4" — registered user with code gets told they are already registered', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(createTextCtx('/start a1b2c3d4', 'admin1'));
			expect(telegram.send).toHaveBeenCalledWith(
				'admin1',
				expect.stringContaining('already registered'),
			);
			// Should NOT redeem the code
			expect(inviteService.claimAndRedeem).not.toHaveBeenCalled();
		});
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Section 10: Messages that LOOK invite-related but should route normally
	// ═══════════════════════════════════════════════════════════════════════

	describe('invite-adjacent messages from registered users route normally', () => {
		it('"invite my mom over for dinner Saturday" — food intent, not /invite', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(
				createTextCtx('invite my mom over for dinner Saturday', 'admin1'),
			);
			// Should go through LLM classification, not the /invite handler
			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(llm.classify).toHaveBeenCalled();
		});

		it('"I need to send an invite for the party" — daily note, not /invite', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(
				createTextCtx('I need to send an invite for the party', 'admin1'),
			);
			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(llm.classify).toHaveBeenCalled();
		});

		it('"add the code ABC123 to my notes" — mentions code-like text in context', async () => {
			const router = buildRouter([adminUser]);
			await router.routeMessage(
				createTextCtx('add the code ABC123 to my notes', 'admin1'),
			);
			expect(inviteService.createInvite).not.toHaveBeenCalled();
			expect(llm.classify).toHaveBeenCalled();
		});
	});
});
