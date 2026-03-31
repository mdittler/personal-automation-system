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
import type { SpaceService, SpaceValidationError } from '../../../services/spaces/index.js';
import type { UserManager } from '../../../services/user-manager/index.js';
import { registerAuth } from '../../auth.js';
import { registerCsrfProtection } from '../../csrf.js';
import { registerSpaceRoutes } from '../spaces.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..', '..');
const viewsDir = join(moduleDir, 'views');

const USERS = [
	{ id: '111', name: 'Alice', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
	{ id: '222', name: 'Bob', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
];

function makeSpace(overrides: Record<string, unknown> = {}) {
	return {
		id: 'family',
		name: 'Family',
		description: 'Family shared space',
		members: ['111'],
		createdBy: '111',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeSpaceService(overrides: Partial<SpaceService> = {}): SpaceService {
	return {
		listSpaces: vi.fn().mockReturnValue([]),
		getSpace: vi.fn().mockReturnValue(null),
		saveSpace: vi.fn().mockResolvedValue([]),
		deleteSpace: vi.fn().mockResolvedValue(true),
		addMember: vi.fn().mockResolvedValue([]),
		removeMember: vi.fn().mockResolvedValue([]),
		isMember: vi.fn().mockReturnValue(false),
		getSpacesForUser: vi.fn().mockReturnValue([]),
		getActiveSpace: vi.fn().mockReturnValue(null),
		setActiveSpace: vi.fn().mockResolvedValue([]),
		init: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as SpaceService;
}

function makeUserManager(): UserManager {
	return {
		getAllUsers: vi.fn().mockReturnValue(USERS),
		getUser: vi.fn().mockImplementation((id: string) => {
			return USERS.find((u) => u.id === id) ?? null;
		}),
		isRegistered: vi.fn().mockImplementation((id: string) => {
			return USERS.some((u) => u.id === id);
		}),
	} as unknown as UserManager;
}

let tempDir: string;
let app: Awaited<ReturnType<typeof Fastify>>;
let spaceService: SpaceService;
let userManager: UserManager;

async function buildApp(spaceServiceOverrides: Partial<SpaceService> = {}) {
	spaceService = makeSpaceService(spaceServiceOverrides);
	userManager = makeUserManager();

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
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			await registerCsrfProtection(gui);
			registerSpaceRoutes(gui, { spaceService, userManager, logger });
		},
		{ prefix: '/gui' },
	);

	return fastifyApp;
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

async function authenticatedGet(url: string) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const cookies = collectCookies(loginRes);
	return app.inject({ method: 'GET', url, cookies });
}

async function authenticatedPost(url: string, payload: Record<string, unknown>) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const loginCookies = collectCookies(loginRes);

	// GET any authenticated page to obtain CSRF token
	const getRes = await app.inject({
		method: 'GET',
		url: '/gui/spaces',
		cookies: loginCookies,
	});
	const allCookies = collectCookies(loginRes, getRes);
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';

	return app.inject({
		method: 'POST',
		url,
		payload: { ...payload, _csrf: csrfToken },
		cookies: allCookies,
	});
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-gui-spaces-'));
});

afterEach(async () => {
	if (app) await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('Space GUI Routes', () => {
	// --- List ---

	describe('GET /gui/spaces', () => {
		it('returns list page with spaces', async () => {
			const space = makeSpace();
			app = await buildApp({
				listSpaces: vi.fn().mockReturnValue([space]),
			});

			const res = await authenticatedGet('/gui/spaces');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Spaces');
			expect(res.body).toContain('Family');
			expect(res.body).toContain('Alice'); // member name resolved
		});

		it('shows empty state when no spaces', async () => {
			app = await buildApp({
				listSpaces: vi.fn().mockReturnValue([]),
			});

			const res = await authenticatedGet('/gui/spaces');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('No shared spaces yet');
		});
	});

	// --- New form ---

	describe('GET /gui/spaces/new', () => {
		it('returns create form', async () => {
			app = await buildApp();

			const res = await authenticatedGet('/gui/spaces/new');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Create Space');
			// Should list registered users as member checkboxes
			expect(res.body).toContain('Alice');
			expect(res.body).toContain('Bob');
		});
	});

	// --- Edit form ---

	describe('GET /gui/spaces/:id/edit', () => {
		it('returns edit form for existing space', async () => {
			const space = makeSpace();
			app = await buildApp({
				getSpace: vi.fn().mockReturnValue(space),
			});

			const res = await authenticatedGet('/gui/spaces/family/edit');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Edit Space');
			expect(res.body).toContain('Family');
		});

		it('returns 404 for non-existent space', async () => {
			app = await buildApp({
				getSpace: vi.fn().mockReturnValue(null),
				listSpaces: vi.fn().mockReturnValue([]),
			});

			const res = await authenticatedGet('/gui/spaces/nonexistent/edit');

			expect(res.statusCode).toBe(404);
		});
	});

	// --- Create/Update ---

	describe('POST /gui/spaces', () => {
		it('creates new space and redirects', async () => {
			app = await buildApp({
				saveSpace: vi.fn().mockResolvedValue([]),
			});

			const res = await authenticatedPost('/gui/spaces', {
				id: 'new-space',
				name: 'New Space',
				description: 'A new shared space',
				members: '111',
				isNew: 'true',
			});

			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/spaces');
			expect(spaceService.saveSpace).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'new-space',
					name: 'New Space',
					description: 'A new shared space',
					members: ['111'],
				}),
			);
		});

		it('shows validation errors on invalid input', async () => {
			const errors: SpaceValidationError[] = [
				{ field: 'id', message: 'Space ID is required' },
				{ field: 'name', message: 'Space name is required' },
			];
			app = await buildApp({
				saveSpace: vi.fn().mockResolvedValue(errors),
			});

			const res = await authenticatedPost('/gui/spaces', {
				id: '',
				name: '',
				isNew: 'true',
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Space ID is required');
			expect(res.body).toContain('Space name is required');
			expect(res.body).toContain('Create Space');
		});

		it('preserves creator info on update', async () => {
			const existing = makeSpace({ createdBy: '111', createdAt: '2026-01-01T00:00:00.000Z' });
			app = await buildApp({
				getSpace: vi.fn().mockReturnValue(existing),
				saveSpace: vi.fn().mockResolvedValue([]),
			});

			const res = await authenticatedPost('/gui/spaces', {
				id: 'family',
				name: 'Family Updated',
				description: 'Updated desc',
				members: ['111', '222'],
				isNew: 'false',
				createdBy: 'someone-else',
				createdAt: '9999-01-01T00:00:00.000Z',
			});

			expect(res.statusCode).toBe(302);
			// saveSpace should have been called with original creator, not the spoofed values
			expect(spaceService.saveSpace).toHaveBeenCalledWith(
				expect.objectContaining({
					createdBy: '111',
					createdAt: '2026-01-01T00:00:00.000Z',
				}),
			);
		});
	});

	// --- Delete ---

	describe('POST /gui/spaces/:id/delete', () => {
		it('deletes space and redirects', async () => {
			app = await buildApp({
				deleteSpace: vi.fn().mockResolvedValue(true),
			});

			const res = await authenticatedPost('/gui/spaces/family/delete', {});

			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/spaces');
			expect(spaceService.deleteSpace).toHaveBeenCalledWith('family');
		});
	});

	// --- Add member (htmx) ---

	describe('POST /gui/spaces/:id/members/add', () => {
		it('adds member and returns updated list', async () => {
			const spaceAfterAdd = makeSpace({ members: ['111', '222'] });
			app = await buildApp({
				addMember: vi.fn().mockResolvedValue([]),
				getSpace: vi.fn().mockReturnValue(spaceAfterAdd),
			});

			const res = await authenticatedPost('/gui/spaces/family/members/add', {
				userId: '222',
			});

			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			expect(spaceService.addMember).toHaveBeenCalledWith('family', '222');
			// Should contain the updated member list HTML
			expect(res.body).toContain('Alice');
			expect(res.body).toContain('Bob');
		});

		it('returns error for missing userId', async () => {
			app = await buildApp();

			const res = await authenticatedPost('/gui/spaces/family/members/add', {});

			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Missing user ID');
		});

		it('returns validation error from service', async () => {
			const errors: SpaceValidationError[] = [
				{ field: 'userId', message: 'User is already a member' },
			];
			app = await buildApp({
				addMember: vi.fn().mockResolvedValue(errors),
			});

			const res = await authenticatedPost('/gui/spaces/family/members/add', {
				userId: '111',
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('User is already a member');
		});
	});

	// --- Remove member (htmx) ---

	describe('POST /gui/spaces/:id/members/remove', () => {
		it('removes member and returns updated list', async () => {
			const spaceAfterRemove = makeSpace({ members: [] });
			app = await buildApp({
				removeMember: vi.fn().mockResolvedValue([]),
				getSpace: vi.fn().mockReturnValue(spaceAfterRemove),
			});

			const res = await authenticatedPost('/gui/spaces/family/members/remove', {
				userId: '111',
			});

			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			expect(spaceService.removeMember).toHaveBeenCalledWith('family', '111');
		});

		it('returns error for missing userId', async () => {
			app = await buildApp();

			const res = await authenticatedPost('/gui/spaces/family/members/remove', {});

			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Missing user ID');
		});

		it('returns validation error from service', async () => {
			const errors: SpaceValidationError[] = [{ field: 'userId', message: 'User is not a member' }];
			app = await buildApp({
				removeMember: vi.fn().mockResolvedValue(errors),
			});

			const res = await authenticatedPost('/gui/spaces/family/members/remove', {
				userId: '999',
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('User is not a member');
		});
	});
});
