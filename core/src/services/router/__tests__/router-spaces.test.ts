import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import type { RegisteredUser } from '../../../types/users.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { SpaceService, SpaceValidationError } from '../../spaces/index.js';
import type { UserManager } from '../../user-manager/index.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

// --- Mock factories ---

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
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createMockConfig(users: SystemConfig['users'] = []): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		fallback: 'notes',
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

function createMockSpaceService(overrides: Partial<SpaceService> = {}): SpaceService {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		listSpaces: vi.fn().mockReturnValue([]),
		getSpace: vi.fn().mockReturnValue(null),
		saveSpace: vi.fn().mockResolvedValue([]),
		deleteSpace: vi.fn().mockResolvedValue(true),
		isMember: vi.fn().mockReturnValue(false),
		getSpacesForUser: vi.fn().mockReturnValue([]),
		getActiveSpace: vi.fn().mockReturnValue(null),
		setActiveSpace: vi.fn().mockResolvedValue([]),
		addMember: vi.fn().mockResolvedValue([]),
		removeMember: vi.fn().mockResolvedValue([]),
		...overrides,
	} as unknown as SpaceService;
}

function createMockUserManager(users: RegisteredUser[] = []): UserManager {
	return {
		getUser: vi.fn((id: string) => users.find((u) => u.id === id) ?? null),
		isRegistered: vi.fn((id: string) => users.some((u) => u.id === id)),
		getAllUsers: vi.fn(() => users),
		getUserApps: vi.fn(),
		getSharedScopes: vi.fn(),
		isAppEnabled: vi.fn(),
		validateConfig: vi.fn(),
	} as unknown as UserManager;
}

function createTextCtx(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
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

const defaultUser: RegisteredUser = {
	id: 'user1',
	name: 'Alice',
	isAdmin: true,
	enabledApps: ['*'],
	sharedScopes: [],
};

const secondUser: RegisteredUser = {
	id: 'user2',
	name: 'Bob',
	isAdmin: false,
	enabledApps: ['*'],
	sharedScopes: [],
};

// --- Test suite ---

describe('Router — /space command and active space injection', () => {
	let telegram: TelegramService;
	let llm: LLMService;
	let fallback: FallbackHandler;
	let logger: Logger;
	let echoModule: AppModule;

	function buildRouter(opts: {
		users?: SystemConfig['users'];
		apps?: Array<{ manifest: AppManifest; module: AppModule }>;
		spaceService?: SpaceService;
		userManager?: UserManager;
	}): Router {
		const users = opts.users ?? [defaultUser];
		const apps = opts.apps ?? [{ manifest: echoManifest, module: echoModule }];

		const config = createMockConfig(users);
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
			telegram,
			fallback,
			config,
			logger,
			confidenceThreshold: 0.4,
			spaceService: opts.spaceService,
			userManager: opts.userManager,
		});
		router.buildRoutingTables();
		return router;
	}

	/** Helper to extract the last message sent via telegram.send. */
	function lastSentMessage(): string {
		const calls = vi.mocked(telegram.send).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		return calls[calls.length - 1]?.[1];
	}

	beforeEach(() => {
		telegram = createMockTelegram();
		llm = createMockLLM();
		fallback = createMockFallback();
		logger = createMockLogger();
		echoModule = createMockModule();
	});

	// ── Active space injection ────────────────────────────────────────

	describe('active space injection', () => {
		it('injects spaceId and spaceName when user has active space', async () => {
			const spaceService = createMockSpaceService({
				getActiveSpace: vi.fn().mockReturnValue('family'),
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/echo hello'));

			// handleCommand receives the enriched ctx
			expect(echoModule.handleCommand).toHaveBeenCalledWith(
				'echo',
				['hello'],
				expect.objectContaining({ spaceId: 'family', spaceName: 'Family' }),
			);
		});

		it('does NOT inject spaceId when user has no active space', async () => {
			const spaceService = createMockSpaceService({
				getActiveSpace: vi.fn().mockReturnValue(null),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/echo hello'));

			const receivedCtx = vi.mocked(echoModule.handleCommand!).mock.calls[0]?.[2] as MessageContext;
			expect(receivedCtx.spaceId).toBeUndefined();
			expect(receivedCtx.spaceName).toBeUndefined();
		});

		it('does NOT inject spaceId when spaceService is not configured', async () => {
			const router = buildRouter({ spaceService: undefined });

			await router.routeMessage(createTextCtx('/echo hello'));

			const receivedCtx = vi.mocked(echoModule.handleCommand!).mock.calls[0]?.[2] as MessageContext;
			expect(receivedCtx.spaceId).toBeUndefined();
			expect(receivedCtx.spaceName).toBeUndefined();
		});
	});

	// ── /space (no args) — status ─────────────────────────────────────

	describe('/space (status)', () => {
		it('shows "Personal mode" when no active space', async () => {
			const spaceService = createMockSpaceService({
				getActiveSpace: vi.fn().mockReturnValue(null),
				getSpacesForUser: vi.fn().mockReturnValue([]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space'));

			const msg = lastSentMessage();
			expect(msg).toContain('Personal mode');
		});

		it('shows active space name when in a space', async () => {
			const spaceService = createMockSpaceService({
				getActiveSpace: vi.fn().mockReturnValue('family'),
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
				getSpacesForUser: vi.fn().mockReturnValue([
					{
						id: 'family',
						name: 'Family',
						members: ['user1'],
						createdBy: 'user1',
						createdAt: '',
						description: '',
					},
				]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space'));

			const msg = lastSentMessage();
			expect(msg).toContain('Family');
			expect(msg).not.toContain('Personal mode');
		});

		it('lists user spaces', async () => {
			const spaceService = createMockSpaceService({
				getActiveSpace: vi.fn().mockReturnValue(null),
				getSpacesForUser: vi.fn().mockReturnValue([
					{
						id: 'family',
						name: 'Family',
						members: ['user1'],
						createdBy: 'user1',
						createdAt: '',
						description: '',
					},
					{
						id: 'work',
						name: 'Work Team',
						members: ['user1'],
						createdBy: 'user1',
						createdAt: '',
						description: '',
					},
				]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space'));

			const msg = lastSentMessage();
			expect(msg).toContain('family');
			expect(msg).toContain('Family');
			expect(msg).toContain('work');
			expect(msg).toContain('Work Team');
		});
	});

	// ── /space <id> — enter space ─────────────────────────────────────

	describe('/space <id> (enter space)', () => {
		it('enters space mode successfully', async () => {
			const spaceService = createMockSpaceService({
				setActiveSpace: vi.fn().mockResolvedValue([]),
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space family'));

			expect(spaceService.setActiveSpace).toHaveBeenCalledWith('user1', 'family');
			const msg = lastSentMessage();
			expect(msg).toContain('Entered space');
			expect(msg).toContain('Family');
		});

		it('rejects non-member with error', async () => {
			const spaceService = createMockSpaceService({
				setActiveSpace: vi.fn().mockResolvedValue([
					{
						field: 'spaceId',
						message: 'You are not a member of this space',
					} as SpaceValidationError,
				]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space family'));

			const msg = lastSentMessage();
			expect(msg).toContain('not a member');
		});

		it('rejects non-existent space', async () => {
			const spaceService = createMockSpaceService({
				setActiveSpace: vi
					.fn()
					.mockResolvedValue([
						{ field: 'spaceId', message: 'Space not found' } as SpaceValidationError,
					]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space nonexistent'));

			const msg = lastSentMessage();
			expect(msg).toContain('not found');
		});
	});

	// ── /space off — exit ─────────────────────────────────────────────

	describe('/space off (exit)', () => {
		it('exits space mode', async () => {
			const spaceService = createMockSpaceService({
				setActiveSpace: vi.fn().mockResolvedValue([]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space off'));

			expect(spaceService.setActiveSpace).toHaveBeenCalledWith('user1', null);
			const msg = lastSentMessage();
			expect(msg).toContain('personal mode');
		});
	});

	// ── /space create ──────────────────────────────────────────────────

	describe('/space create', () => {
		it('creates space with user as first member', async () => {
			const spaceService = createMockSpaceService({
				saveSpace: vi.fn().mockResolvedValue([]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space create family Our Family'));

			expect(spaceService.saveSpace).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'family',
					name: 'Our Family',
					members: ['user1'],
					createdBy: 'user1',
				}),
			);
			const msg = lastSentMessage();
			expect(msg).toContain('Our Family');
			expect(msg).toContain('created');
		});

		it('sends validation errors on invalid input', async () => {
			const spaceService = createMockSpaceService({
				saveSpace: vi
					.fn()
					.mockResolvedValue([
						{ field: 'id', message: 'Space ID must start with a letter' } as SpaceValidationError,
					]),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space create 123bad Invalid Space'));

			const msg = lastSentMessage();
			expect(msg).toContain('must start with a letter');
		});

		it('sends usage message when missing args', async () => {
			const spaceService = createMockSpaceService();
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space create'));

			const msg = lastSentMessage();
			expect(msg).toContain('Usage');
			// saveSpace should not have been called
			expect(spaceService.saveSpace).not.toHaveBeenCalled();
		});
	});

	// ── /space delete ──────────────────────────────────────────────────

	describe('/space delete', () => {
		it('deletes space when requested by creator', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
				deleteSpace: vi.fn().mockResolvedValue(true),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space delete family'));

			expect(spaceService.deleteSpace).toHaveBeenCalledWith('family');
			const msg = lastSentMessage();
			expect(msg).toContain('Family');
			expect(msg).toContain('deleted');
		});

		it('rejects non-creator', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1', 'user2'],
					createdBy: 'user2',
					createdAt: '',
					description: '',
				}),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space delete family'));

			expect(spaceService.deleteSpace).not.toHaveBeenCalled();
			const msg = lastSentMessage();
			expect(msg).toContain('creator');
		});

		it('handles non-existent space', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue(null),
			});
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space delete nope'));

			const msg = lastSentMessage();
			expect(msg).toContain('not found');
		});
	});

	// ── /space invite ──────────────────────────────────────────────────

	describe('/space invite', () => {
		it('adds member by name', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
				addMember: vi.fn().mockResolvedValue([]),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space invite family Bob'));

			expect(spaceService.addMember).toHaveBeenCalledWith('family', 'user2');
			const msg = lastSentMessage();
			expect(msg).toContain('Bob');
			expect(msg).toContain('added');
			expect(msg).toContain('Family');
		});

		it('rejects unknown username', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
			});
			const userManager = createMockUserManager([defaultUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space invite family Unknown'));

			const msg = lastSentMessage();
			expect(msg).toContain('not found');
			expect(spaceService.addMember).not.toHaveBeenCalled();
		});

		it('sends usage message when missing args', async () => {
			const spaceService = createMockSpaceService();
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/space invite'));

			const msg = lastSentMessage();
			expect(msg).toContain('Usage');
		});
	});

	// ── /space kick ────────────────────────────────────────────────────

	describe('/space kick', () => {
		it('removes member by name', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1', 'user2'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
				removeMember: vi.fn().mockResolvedValue([]),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space kick family Bob'));

			expect(spaceService.removeMember).toHaveBeenCalledWith('family', 'user2');
			const msg = lastSentMessage();
			expect(msg).toContain('Bob');
			expect(msg).toContain('removed');
		});

		it('rejects unknown username', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
			});
			const userManager = createMockUserManager([defaultUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space kick family Ghost'));

			const msg = lastSentMessage();
			expect(msg).toContain('not found');
			expect(spaceService.removeMember).not.toHaveBeenCalled();
		});
	});

	// ── /space invite & kick authorization ─────────────────────────────

	describe('/space invite — authorization', () => {
		it('rejects invite from non-member', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user2'], // user1 is NOT a member
					createdBy: 'user2',
					createdAt: '',
					description: '',
				}),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space invite family Bob'));

			const msg = lastSentMessage();
			expect(msg).toContain('must be a member');
			// addMember should NOT have been called
			expect(spaceService.addMember).not.toHaveBeenCalled();
		});

		it('allows invite from member', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1'], // user1 IS a member
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
				addMember: vi.fn().mockResolvedValue([]),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space invite family Bob'));

			expect(spaceService.addMember).toHaveBeenCalledWith('family', 'user2');
			const msg = lastSentMessage();
			expect(msg).toContain('Bob');
			expect(msg).toContain('added');
		});
	});

	describe('/space kick — authorization', () => {
		it('rejects kick from non-member', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user2'], // user1 is NOT a member
					createdBy: 'user2',
					createdAt: '',
					description: '',
				}),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space kick family Bob'));

			const msg = lastSentMessage();
			expect(msg).toContain('must be a member');
			expect(spaceService.removeMember).not.toHaveBeenCalled();
		});

		it('allows kick from member', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1', 'user2'], // user1 IS a member
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
				removeMember: vi.fn().mockResolvedValue([]),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space kick family Bob'));

			expect(spaceService.removeMember).toHaveBeenCalledWith('family', 'user2');
			const msg = lastSentMessage();
			expect(msg).toContain('Bob');
			expect(msg).toContain('removed');
		});

		it('rejects kicking the creator via service validation', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1', 'user2'],
					createdBy: 'user2',
					createdAt: '',
					description: '',
				}),
				removeMember: vi
					.fn()
					.mockResolvedValue([{ field: 'userId', message: 'Cannot remove the space creator' }]),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space kick family Bob'));

			const msg = lastSentMessage();
			expect(msg).toContain('Cannot remove the space creator');
		});
	});

	// ── /space members ─────────────────────────────────────────────────

	describe('/space members', () => {
		it('lists members with names', async () => {
			const spaceService = createMockSpaceService({
				getSpace: vi.fn().mockReturnValue({
					id: 'family',
					name: 'Family',
					members: ['user1', 'user2'],
					createdBy: 'user1',
					createdAt: '',
					description: '',
				}),
			});
			const userManager = createMockUserManager([defaultUser, secondUser]);
			const router = buildRouter({ spaceService, userManager });

			await router.routeMessage(createTextCtx('/space members family'));

			const msg = lastSentMessage();
			expect(msg).toContain('Alice');
			expect(msg).toContain('Bob');
			expect(msg).toContain('creator');
		});
	});

	// ── /space when spaceService not configured ────────────────────────

	describe('/space when spaceService not configured', () => {
		it('sends "not configured" message', async () => {
			const router = buildRouter({ spaceService: undefined });

			await router.routeMessage(createTextCtx('/space'));

			const msg = lastSentMessage();
			expect(msg).toContain('not configured');
		});
	});

	// ── /help includes space commands ──────────────────────────────────

	describe('/help includes space commands', () => {
		it('includes space commands when spaceService is configured', async () => {
			const spaceService = createMockSpaceService();
			const router = buildRouter({ spaceService });

			await router.routeMessage(createTextCtx('/help'));

			const msg = lastSentMessage();
			expect(msg).toContain('Spaces');
			expect(msg).toContain('/space');
			expect(msg).toContain('/space off');
			expect(msg).toContain('/space create');
		});

		it('does NOT include space commands when spaceService is absent', async () => {
			const router = buildRouter({ spaceService: undefined });

			await router.routeMessage(createTextCtx('/help'));

			const msg = lastSentMessage();
			expect(msg).not.toContain('Spaces');
		});
	});
});
