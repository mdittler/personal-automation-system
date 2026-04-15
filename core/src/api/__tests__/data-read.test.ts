import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { registerApiRoutes } from '../index.js';

const API_TOKEN = 'test-api-secret';

function createMockUserManager(registeredIds: string[] = ['user1']) {
	return {
		isRegistered: vi.fn((id: string) => registeredIds.includes(id)),
		getUser: vi.fn(),
		getUsers: vi.fn(() => []),
		validateConfig: vi.fn(() => []),
		getUserByName: vi.fn(),
	};
}

function createMockSpaceService(members: Record<string, string[]> = {}) {
	return {
		isMember: vi.fn((spaceId: string, userId: string) => (members[spaceId] ?? []).includes(userId)),
		getSpace: vi.fn(),
		getAllSpaces: vi.fn(() => []),
		saveSpace: vi.fn(),
		deleteSpace: vi.fn(),
		addMember: vi.fn(),
		removeMember: vi.fn(),
		setActiveSpace: vi.fn(),
		getActiveSpace: vi.fn(),
		clearActiveSpace: vi.fn(),
		init: vi.fn(),
	};
}

function createMockRouter() {
	return {
		routeMessage: vi.fn(),
		routePhoto: vi.fn(),
		buildRoutingTables: vi.fn(),
	};
}

function createMockCronManager() {
	return {
		getJobDetails: vi.fn(() => []),
		register: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		unregister: vi.fn(),
		getRegisteredJobs: vi.fn(() => []),
	};
}

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

describe('API Data Read Route', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-read-'));

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog: { record: vi.fn(), getLogPath: vi.fn() } as any,
			spaceService: createMockSpaceService({ family: ['user1'] }) as any,
			userManager: createMockUserManager() as any,
			router: createMockRouter() as any,
			cronManager: createMockCronManager() as any,
			timezone: 'America/New_York',
			reportService: {
				listReports: vi.fn(() => []),
				getReport: vi.fn(),
				run: vi.fn(),
				saveReport: vi.fn(),
				deleteReport: vi.fn(),
				init: vi.fn(),
			} as any,
			alertService: {
				listAlerts: vi.fn(() => []),
				getAlert: vi.fn(),
				evaluate: vi.fn(),
				saveAlert: vi.fn(),
				deleteAlert: vi.fn(),
				init: vi.fn(),
			} as any,
			telegram: { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() } as any,
			llm: {
				complete: vi.fn(() => 'mock response'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			} as any,
			logger,
		});
	});

	afterEach(async () => {
		await app.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	function get(params: Record<string, string>) {
		const searchParams = new URLSearchParams(params);
		return app.inject({
			method: 'GET',
			url: `/api/data?${searchParams}`,
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
	}

	// --- Standard (happy path) ---

	it('reads a file', async () => {
		const filePath = join(dataDir, 'users', 'user1', 'notes', 'test.md');
		await mkdir(join(dataDir, 'users', 'user1', 'notes'), { recursive: true });
		await writeFile(filePath, 'Hello from file');

		const res = await get({ userId: 'user1', appId: 'notes', path: 'test.md' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.type).toBe('file');
		expect(body.path).toBe('test.md');
		expect(body.content).toBe('Hello from file');
	});

	it('lists a directory', async () => {
		const dir = join(dataDir, 'users', 'user1', 'notes', 'daily-notes');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, '2026-03-18.md'), 'Note 1');
		await writeFile(join(dir, '2026-03-19.md'), 'Note 2');

		const res = await get({ userId: 'user1', appId: 'notes', path: 'daily-notes' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.type).toBe('directory');
		expect(body.entries).toHaveLength(2);
		expect(body.entries[0]).toEqual({ name: '2026-03-18.md', isDirectory: false });
		expect(body.entries[1]).toEqual({ name: '2026-03-19.md', isDirectory: false });
	});

	it('returns not_found for missing file', async () => {
		const res = await get({ userId: 'user1', appId: 'notes', path: 'nonexistent.md' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.type).toBe('not_found');
		expect(body.path).toBe('nonexistent.md');
	});

	it('reads space-scoped file', async () => {
		const filePath = join(dataDir, 'spaces', 'family', 'notes', 'shared.md');
		await mkdir(join(dataDir, 'spaces', 'family', 'notes'), { recursive: true });
		await writeFile(filePath, 'Space data');

		const res = await get({
			userId: 'user1',
			appId: 'notes',
			path: 'shared.md',
			spaceId: 'family',
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.type).toBe('file');
		expect(body.content).toBe('Space data');
	});

	// --- Edge cases ---

	it('reads empty file', async () => {
		const filePath = join(dataDir, 'users', 'user1', 'notes', 'empty.md');
		await mkdir(join(dataDir, 'users', 'user1', 'notes'), { recursive: true });
		await writeFile(filePath, '');

		const res = await get({ userId: 'user1', appId: 'notes', path: 'empty.md' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.type).toBe('file');
		expect(body.content).toBe('');
	});

	it('lists nested directories showing isDirectory', async () => {
		const dir = join(dataDir, 'users', 'user1', 'notes');
		await mkdir(join(dir, 'subdir'), { recursive: true });
		await writeFile(join(dir, 'file.md'), 'content');

		const res = await get({ userId: 'user1', appId: 'notes', path: '.' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.type).toBe('directory');
		const dirEntry = body.entries.find((e: any) => e.name === 'subdir');
		const fileEntry = body.entries.find((e: any) => e.name === 'file.md');
		expect(dirEntry?.isDirectory).toBe(true);
		expect(fileEntry?.isDirectory).toBe(false);
	});

	it('handles path with dots', async () => {
		const filePath = join(dataDir, 'users', 'user1', 'notes', 'file.v2.md');
		await mkdir(join(dataDir, 'users', 'user1', 'notes'), { recursive: true });
		await writeFile(filePath, 'versioned');

		const res = await get({ userId: 'user1', appId: 'notes', path: 'file.v2.md' });
		expect(res.statusCode).toBe(200);
		expect(res.json().type).toBe('file');
	});

	// --- Error cases ---

	it('missing userId returns 400', async () => {
		const res = await get({ appId: 'notes', path: 'test.md' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('userId');
	});

	it('missing appId returns 400', async () => {
		const res = await get({ userId: 'user1', path: 'test.md' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('appId');
	});

	it('missing path returns 400', async () => {
		const res = await get({ userId: 'user1', appId: 'notes' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('path');
	});

	it('unregistered user returns 403', async () => {
		const res = await get({ userId: 'unknown', appId: 'notes', path: 'test.md' });
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toContain('Unregistered');
	});

	it('invalid appId pattern returns 400', async () => {
		const res = await get({ userId: 'user1', appId: 'INVALID', path: 'test.md' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('appId');
	});

	// --- Security ---

	it('path traversal attempt returns 400', async () => {
		const res = await get({ userId: 'user1', appId: 'notes', path: '../../etc/passwd' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('traversal');
	});

	it('invalid userId format returns 400', async () => {
		const res = await get({ userId: '../../etc', appId: 'notes', path: 'test.md' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('userId');
	});

	it('non-member space read returns 403', async () => {
		const res = await get({
			userId: 'user1',
			appId: 'notes',
			path: 'test.md',
			spaceId: 'noaccess',
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toContain('member');
	});

	it('invalid spaceId format returns 400', async () => {
		const res = await get({
			userId: 'user1',
			appId: 'notes',
			path: 'test.md',
			spaceId: 'INVALID!',
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('spaceId');
	});

	// --- Edge cases (additional) ---

	it('lists empty directory', async () => {
		const dir = join(dataDir, 'users', 'user1', 'notes', 'empty-dir');
		await mkdir(dir, { recursive: true });

		const res = await get({ userId: 'user1', appId: 'notes', path: 'empty-dir' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.type).toBe('directory');
		expect(body.entries).toEqual([]);
	});

	it('reads app root directory', async () => {
		// When the app directory itself doesn't exist, returns not_found
		const res = await get({ userId: 'user1', appId: 'nonexistent-app', path: '.' });
		expect(res.statusCode).toBe(200);
		expect(res.json().type).toBe('not_found');
	});

	// --- Size limit ---

	it('file exceeding 1MB returns 413', async () => {
		const filePath = join(dataDir, 'users', 'user1', 'notes', 'large.bin');
		await mkdir(join(dataDir, 'users', 'user1', 'notes'), { recursive: true });
		// Write a file larger than 1MB
		const content = 'x'.repeat(1024 * 1024 + 1);
		await writeFile(filePath, content);

		const res = await get({ userId: 'user1', appId: 'notes', path: 'large.bin' });
		expect(res.statusCode).toBe(413);
		expect(res.json().ok).toBe(false);
		expect(res.json().error).toContain('size');
	});
});

// ---------------------------------------------------------------------------
// C3 / R2: GET /api/data — household-aware read (post-migration)
// ---------------------------------------------------------------------------

describe('API Data Read Route — household-aware read (C3/R2)', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;

	const householdService = {
		getHouseholdForUser: (id: string) => (id === 'user1' ? 'hh-alpha' : null),
	};

	function createSpaceServiceWithKinds() {
		return {
			isMember: vi.fn((spaceId: string, userId: string) =>
				['family', 'collab-1'].includes(spaceId) && userId === 'user1',
			),
			getSpace: vi.fn((spaceId: string) => {
				if (spaceId === 'family') {
					return { id: 'family', kind: 'household', householdId: 'hh-alpha' };
				}
				if (spaceId === 'collab-1') {
					return { id: 'collab-1', kind: 'collaboration' };
				}
				return null;
			}),
		};
	}

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-read-hh-'));

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog: { record: vi.fn(), getLogPath: vi.fn() } as any,
			spaceService: createSpaceServiceWithKinds() as any,
			userManager: createMockUserManager() as any,
			router: createMockRouter() as any,
			cronManager: createMockCronManager() as any,
			timezone: 'America/New_York',
			reportService: {
				listReports: vi.fn(() => []),
				getReport: vi.fn(),
				run: vi.fn(),
				saveReport: vi.fn(),
				deleteReport: vi.fn(),
				init: vi.fn(),
			} as any,
			alertService: {
				listAlerts: vi.fn(() => []),
				getAlert: vi.fn(),
				evaluate: vi.fn(),
				saveAlert: vi.fn(),
				deleteAlert: vi.fn(),
				init: vi.fn(),
			} as any,
			telegram: { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() } as any,
			llm: {
				complete: vi.fn(() => 'mock response'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			} as any,
			logger,
			householdService: householdService as any,
		});
	});

	afterEach(async () => {
		await app.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	function get(params: Record<string, string>) {
		const searchParams = new URLSearchParams(params);
		return app.inject({
			method: 'GET',
			url: `/api/data?${searchParams}`,
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
	}

	it('reads user file from households/<hh>/users/<u>/<app>/ path when householdService is wired', async () => {
		const hhPath = join(dataDir, 'households', 'hh-alpha', 'users', 'user1', 'notes');
		await mkdir(hhPath, { recursive: true });
		await writeFile(join(hhPath, 'data.md'), 'Household data');

		const res = await get({ userId: 'user1', appId: 'notes', path: 'data.md' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.type).toBe('file');
		expect(body.content).toBe('Household data');
	});

	it('reads household-space file from households/<hh>/spaces/<s>/<app>/ path', async () => {
		const spacePath = join(
			dataDir,
			'households',
			'hh-alpha',
			'spaces',
			'family',
			'notes',
		);
		await mkdir(spacePath, { recursive: true });
		await writeFile(join(spacePath, 'shared.md'), 'Household space data');

		const res = await get({
			userId: 'user1',
			appId: 'notes',
			path: 'shared.md',
			spaceId: 'family',
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.type).toBe('file');
		expect(body.content).toBe('Household space data');
	});

	it('reads collaboration-space file from collaborations/<s>/<app>/ path', async () => {
		const collabPath = join(dataDir, 'collaborations', 'collab-1', 'notes');
		await mkdir(collabPath, { recursive: true });
		await writeFile(join(collabPath, 'shared.md'), 'Collab data');

		const res = await get({
			userId: 'user1',
			appId: 'notes',
			path: 'shared.md',
			spaceId: 'collab-1',
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.type).toBe('file');
		expect(body.content).toBe('Collab data');
	});
});
