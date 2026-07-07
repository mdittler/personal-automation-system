/**
 * Household hub (Batch 5, Task 5.1 + 5.2).
 *
 * `/gui/users` becomes the "Household" hub:
 * - Admin: guided invite flow (POST /gui/users/invite), member list, pending
 *   invite list (expiry only — InviteService has no revoke method).
 * - Member (Task 5.2): authenticated-only read-only view of their OWN
 *   household's members. No invite form, no role controls, no other
 *   households. Mutation POSTs stay platform-admin-only.
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own Fastify app via the per-file `buildApp` pattern used by
 * admin-route-guards.test.ts / report-wizard.test.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppRegistry, RegisteredApp } from '../../services/app-registry/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import { HouseholdService } from '../../services/household/index.js';
import { InviteService } from '../../services/invite/index.js';
import { SpaceService } from '../../services/spaces/index.js';
import { UserManager } from '../../services/user-manager/index.js';
import type { UserMutationService } from '../../services/user-manager/user-mutation-service.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerUserRoutes } from '../routes/users.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'test-token';
const ADMIN_PASS = 'admin-password';
const MEMBER_PASS = 'member-password';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_USER = {
	id: '111',
	name: 'Admin',
	isAdmin: true,
	enabledApps: ['*'],
	sharedScopes: [],
	householdId: 'home-a',
};
const MEMBER_USER = {
	id: '222',
	name: 'Member One',
	isAdmin: false,
	enabledApps: ['echo'],
	sharedScopes: [],
	householdId: 'home-a',
};
const OTHER_HH_USER = {
	id: '333',
	name: 'Other Household User',
	isAdmin: false,
	enabledApps: ['*'],
	sharedScopes: [],
	householdId: 'home-b',
};
const ALL_USERS = [ADMIN_USER, MEMBER_USER, OTHER_HH_USER];

function makeUserMutationService(): UserMutationService {
	return {
		updateUserApps: async () => {},
		updateUserSharedScopes: async () => {},
		removeUser: async () => ({}),
	} as unknown as UserMutationService;
}

function makeRegistry(): AppRegistry {
	const mockApp: RegisteredApp = {
		manifest: {
			app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Test echo app' },
			capabilities: { messages: { intents: [] } },
			requirements: { services: ['telegram'] },
		} as RegisteredApp['manifest'],
		module: { init: async () => {}, handleMessage: async () => {} },
		appDir: '/tmp/apps/echo',
	};
	return {
		getAll: () => [mockApp],
		getApp: (id: string) => (id === 'echo' ? mockApp : undefined),
		getLoadedAppIds: () => ['echo'],
		getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
	} as unknown as AppRegistry;
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const res of responses) {
		for (const c of res.cookies) {
			result[c.name] = c.value;
		}
	}
	return result;
}

let tempDir: string;
let app: Awaited<ReturnType<typeof Fastify>>;
let householdService: HouseholdService;
let inviteService: InviteService;
let userManager: UserManager;

async function buildApp(dir: string) {
	userManager = new UserManager({
		config: { users: ALL_USERS } as any,
		appToggle: new AppToggleStore({ dataDir: dir, logger }),
		logger,
	});

	householdService = new HouseholdService({ dataDir: dir, users: ALL_USERS, logger });
	await householdService.init();
	// Slugify("Home A") === "home-a" / Slugify("Home B") === "home-b" — matches
	// the householdId already assigned to the fixture users above.
	await householdService.createHousehold('Home A', ADMIN_USER.id, [ADMIN_USER.id]);
	await householdService.createHousehold('Home B', OTHER_HH_USER.id, [OTHER_HH_USER.id]);

	inviteService = new InviteService({
		dataDir: dir,
		logger,
		knownUsers: () => userManager.getAllUsers(),
	});

	const spaceService = new SpaceService({ dataDir: dir, userManager, householdService, logger });
	await spaceService.init();

	const credentialService = new CredentialService({ dataDir: dir });
	await credentialService.setPassword(ADMIN_USER.id, ADMIN_PASS);
	await credentialService.setPassword(MEMBER_USER.id, MEMBER_PASS);
	await credentialService.setPassword(OTHER_HH_USER.id, MEMBER_PASS);

	const fastifyApp = Fastify({ logger: false });
	await fastifyApp.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await fastifyApp.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	await fastifyApp.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService,
				userManager,
				householdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, { userManager });
			registerUserRoutes(gui, {
				userManager,
				userMutationService: makeUserMutationService(),
				registry: makeRegistry(),
				spaceService,
				householdService,
				inviteService,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return fastifyApp;
}

async function login(userId: string, password: string): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

async function getCsrf(cookies: Record<string, string>) {
	const res = await app.inject({ method: 'GET', url: '/gui/users', cookies });
	expect(res.statusCode).toBe(200);
	const allCookies = { ...cookies, ...collectCookies(res) };
	const metaMatch = res.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	expect(csrfToken).not.toBe('');
	return { cookies: allCookies, csrfToken };
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-household-'));
	app = await buildApp(tempDir);
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('Household hub — invite flow (admin)', () => {
	it('admin can create an invite and sees copy-paste instructions with the code', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/users/invite',
			payload: { name: 'New Person', role: 'member', _csrf: csrfToken },
			cookies,
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Send this to them in Telegram');
		expect(res.body).toMatch(/\/start [a-f0-9]{8}/);

		// The invite lands in the admin's resolved household.
		const invites = await inviteService.listInvites();
		const codes = Object.values(invites);
		expect(codes.length).toBe(1);
		expect(codes[0]?.householdId).toBe('home-a');
		expect(codes[0]?.name).toBe('New Person');
	});

	it('escapes a hostile invite name in the instruction card', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/users/invite',
			payload: { name: '<script>alert(1)</script>', role: 'member', _csrf: csrfToken },
			cookies,
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('<script>alert(1)</script>');
		expect(res.body).toContain('&lt;script&gt;');
	});

	it('invite POST requires platform admin + CSRF', async () => {
		// Member is forbidden outright.
		const memberLogin = await login(MEMBER_USER.id, MEMBER_PASS);
		const memberRes = await app.inject({
			method: 'POST',
			url: '/gui/users/invite',
			payload: { name: 'Nope', role: 'member', _csrf: 'whatever' },
			cookies: memberLogin,
		});
		expect(memberRes.statusCode).toBe(403);

		// Admin without a valid CSRF token is rejected.
		const adminLogin = await login(ADMIN_USER.id, ADMIN_PASS);
		const csrfRes = await app.inject({
			method: 'POST',
			url: '/gui/users/invite',
			payload: { name: 'Nope', role: 'member', _csrf: 'invalid-token' },
			cookies: adminLogin,
		});
		expect(csrfRes.statusCode).toBe(403);
	});

	it('member list shows display names, plain roles, and enabled apps as friendly labels', async () => {
		const cookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/users', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Member One');
		expect(res.body).toContain('222');
		expect(res.body).toContain('Echo');
	});

	it('pending invites are listed with expiry (InviteService has no revoke method — expiry only)', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		await app.inject({
			method: 'POST',
			url: '/gui/users/invite',
			payload: { name: 'Pending Person', role: 'member', _csrf: csrfToken },
			cookies,
		});

		const res = await app.inject({ method: 'GET', url: '/gui/users', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Pending Person');
		expect(res.body.toLowerCase()).toContain('expires');
		// No revoke affordance — InviteService.revokeInvite does not exist.
		expect(res.body).not.toContain('Revoke');
	});
});

describe('Household hub — member read-only view (Task 5.2, deliberate guard change)', () => {
	it('member GET /gui/users → 200 read-only: own household members, no invite form, no role controls, no other households', async () => {
		const cookies = await login(MEMBER_USER.id, MEMBER_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/users', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Member One');
		expect(res.body).toContain('Admin');
		// No invite form for members.
		expect(res.body).not.toContain('name="role"');
		expect(res.body).not.toContain('/gui/users/invite');
		// No mutation affordances (app checkboxes / remove buttons) for members.
		expect(res.body).not.toContain('/gui/users/222/apps');
		expect(res.body).not.toContain('/gui/users/222/remove');
		// Other household's user must not leak.
		expect(res.body).not.toContain('Other Household User');
	});

	it('member POST to any /gui/users mutation → 403', async () => {
		const loginCookies = await login(MEMBER_USER.id, MEMBER_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const appsRes = await app.inject({
			method: 'POST',
			url: '/gui/users/222/apps',
			payload: { app_echo: 'on', _csrf: csrfToken },
			cookies,
		});
		expect(appsRes.statusCode).toBe(403);

		const removeRes = await app.inject({
			method: 'POST',
			url: '/gui/users/222/remove',
			payload: { _csrf: csrfToken },
			cookies,
		});
		expect(removeRes.statusCode).toBe(403);

		const inviteRes = await app.inject({
			method: 'POST',
			url: '/gui/users/invite',
			payload: { name: 'X', role: 'member', _csrf: csrfToken },
			cookies,
		});
		expect(inviteRes.statusCode).toBe(403);
	});

	it('member sees only users in their own household (two-household isolation)', async () => {
		const cookies = await login(MEMBER_USER.id, MEMBER_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/users', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Member One');
		expect(res.body).toContain('Admin');
		expect(res.body).not.toContain('Other Household User');
	});
});
