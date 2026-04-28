import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRegistry } from '../../../services/app-registry/index.js';
import { CredentialService } from '../../../services/credentials/index.js';
import type { HouseholdService } from '../../../services/household/index.js';
import type { SpaceService } from '../../../services/spaces/index.js';
import type { UserManager } from '../../../services/user-manager/index.js';
import type { UserMutationService } from '../../../services/user-manager/user-mutation-service.js';
import { registerAuth } from '../../auth.js';
import { registerUserRoutes } from '../users.js';

const AUTH_TOKEN = 'test-token';
const ADMIN_PASSWORD = 'admin-password';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..', '..');
const viewsDir = join(moduleDir, 'views');

const USERS = [
	{ id: '111', name: 'Alice', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
	{ id: '222', name: 'Bob', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
];

function makeUserManager(): UserManager {
	return {
		getUser: vi.fn().mockImplementation((id: string) => USERS.find((u) => u.id === id) ?? null),
		getAllUsers: vi.fn().mockReturnValue(USERS),
		isRegistered: vi.fn().mockImplementation((id: string) => USERS.some((u) => u.id === id)),
	} as unknown as UserManager;
}

function makeHouseholdService(): Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'> {
	return {
		getHouseholdForUser: vi.fn().mockReturnValue('hh-1'),
		getHousehold: vi.fn().mockReturnValue({ id: 'hh-1', name: 'Home', adminUserIds: ['111'] }),
	};
}

function makeRegistry(): AppRegistry {
	return {
		getLoadedAppIds: vi.fn().mockReturnValue(['chatbot']),
		getApp: vi.fn().mockReturnValue({ manifest: { app: { name: 'Chatbot' } } }),
	} as unknown as AppRegistry;
}

function makeSpaceService(): SpaceService {
	return {
		listSpaces: vi.fn().mockReturnValue([]),
	} as unknown as SpaceService;
}

function makeUserMutationService(): UserMutationService {
	return {
		updateUserApps: vi.fn(),
		updateUserSharedScopes: vi.fn(),
		removeUser: vi.fn(),
	} as unknown as UserMutationService;
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const res of responses) {
		for (const c of res.cookies as Array<{ name: string; value: string }>) {
			result[c.name] = c.value;
		}
	}
	return result;
}

let tempDir: string;
let app: Awaited<ReturnType<typeof Fastify>>;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-users-route-test-'));
	const credentialService = new CredentialService({ dataDir: tempDir });
	await credentialService.setPassword('111', ADMIN_PASSWORD);

	app = Fastify({ logger: false });
	await app.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	const userManager = makeUserManager();
	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService,
				userManager,
				householdService: makeHouseholdService(),
			});
			registerUserRoutes(gui, {
				userManager,
				userMutationService: makeUserMutationService(),
				registry: makeRegistry(),
				spaceService: makeSpaceService(),
				logger,
			});
		},
		{ prefix: '/gui' },
	);
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('User GUI routes', () => {
	it('shows reset-password actions on the users page', async () => {
		const loginRes = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: '111', password: ADMIN_PASSWORD },
		});
		const cookies = collectCookies(loginRes);

		const res = await app.inject({
			method: 'GET',
			url: '/gui/users',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('/gui/users/111/reset-password');
		expect(res.body).toContain('/gui/users/222/reset-password');
		expect(res.body).toContain('Reset Password');
	});
});
