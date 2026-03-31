import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { registerApiRoutes } from '../index.js';

const API_TOKEN = 'test-api-secret';

function createMockEventBus() {
	return {
		emit: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	};
}

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

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

describe('API Data Route', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;
	let changeLog: ChangeLog;
	let mockEventBus: ReturnType<typeof createMockEventBus>;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-data-'));
		changeLog = new ChangeLog(dataDir);
		mockEventBus = createMockEventBus();

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog,
			spaceService: createMockSpaceService({ family: ['user1'] }) as any,
			userManager: createMockUserManager() as any,
			router: createMockRouter() as any,
			cronManager: {
				getJobDetails: vi.fn(() => []),
				register: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
				unregister: vi.fn(),
				getRegisteredJobs: vi.fn(() => []),
			} as any,
			timezone: 'America/New_York',
			eventBus: mockEventBus,
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

	function post(body: Record<string, unknown>) {
		return app.inject({
			method: 'POST',
			url: '/api/data',
			headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
			payload: body,
		});
	}

	it('write mode creates file', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'test.md',
			content: 'Hello from API',
			mode: 'write',
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true, path: 'test.md', mode: 'write' });

		const content = await readFile(join(dataDir, 'users', 'user1', 'notes', 'test.md'), 'utf-8');
		expect(content).toBe('Hello from API');
	});

	it('append mode appends to file', async () => {
		// Write first
		await post({
			userId: 'user1',
			appId: 'notes',
			path: 'log.md',
			content: 'Line 1\n',
			mode: 'write',
		});
		// Append
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'log.md',
			content: 'Line 2\n',
			mode: 'append',
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().mode).toBe('append');

		const content = await readFile(join(dataDir, 'users', 'user1', 'notes', 'log.md'), 'utf-8');
		expect(content).toBe('Line 1\nLine 2\n');
	});

	it('mode defaults to write', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'test.md',
			content: 'default mode',
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().mode).toBe('write');
	});

	it('space-scoped write with valid membership', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'shared.md',
			content: 'Space data',
			spaceId: 'family',
		});
		expect(res.statusCode).toBe(200);

		const content = await readFile(
			join(dataDir, 'spaces', 'family', 'notes', 'shared.md'),
			'utf-8',
		);
		expect(content).toBe('Space data');
	});

	it('change log records operation', async () => {
		await post({ userId: 'user1', appId: 'notes', path: 'test.md', content: 'logged' });
		const logPath = changeLog.getLogPath();
		const logContent = await readFile(logPath, 'utf-8');
		expect(logContent).toContain('notes');
	});

	it('missing userId returns 400', async () => {
		const res = await post({ appId: 'notes', path: 'test.md', content: 'x' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('userId');
	});

	it('missing appId returns 400', async () => {
		const res = await post({ userId: 'user1', path: 'test.md', content: 'x' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('appId');
	});

	it('missing path returns 400', async () => {
		const res = await post({ userId: 'user1', appId: 'notes', content: 'x' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('path');
	});

	it('missing content returns 400', async () => {
		const res = await post({ userId: 'user1', appId: 'notes', path: 'test.md' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('content');
	});

	it('unregistered userId returns 403', async () => {
		const res = await post({ userId: 'unknown', appId: 'notes', path: 'test.md', content: 'x' });
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toContain('Unregistered');
	});

	it('invalid appId pattern returns 400', async () => {
		const res = await post({ userId: 'user1', appId: 'INVALID', path: 'test.md', content: 'x' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('appId');
	});

	it('invalid mode returns 400', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'test.md',
			content: 'x',
			mode: 'delete',
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('mode');
	});

	it('path traversal attempt returns 400', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: '../../etc/passwd',
			content: 'x',
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('traversal');
	});

	it('space membership denied returns 403', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'test.md',
			content: 'x',
			spaceId: 'noaccess',
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toContain('member');
	});

	it('invalid spaceId format returns 400', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'test.md',
			content: 'x',
			spaceId: 'INVALID!',
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('spaceId');
	});

	it('userId with path traversal chars returns 400', async () => {
		const res = await post({ userId: '../../etc', appId: 'notes', path: 'test.md', content: 'x' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('userId');
	});

	it('empty string content writes empty file', async () => {
		const res = await post({ userId: 'user1', appId: 'notes', path: 'empty.md', content: '' });
		expect(res.statusCode).toBe(200);
		const content = await readFile(join(dataDir, 'users', 'user1', 'notes', 'empty.md'), 'utf-8');
		expect(content).toBe('');
	});

	it('nested path creates subdirectories', async () => {
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'daily-notes/2026-03-18.md',
			content: 'Nested file',
		});
		expect(res.statusCode).toBe(200);
		const content = await readFile(
			join(dataDir, 'users', 'user1', 'notes', 'daily-notes', '2026-03-18.md'),
			'utf-8',
		);
		expect(content).toBe('Nested file');
	});

	it('write triggers data:changed event', async () => {
		await post({ userId: 'user1', appId: 'notes', path: 'test.md', content: 'hello' });
		expect(mockEventBus.emit).toHaveBeenCalledWith(
			'data:changed',
			expect.objectContaining({
				operation: 'write',
				appId: 'notes',
				userId: 'user1',
				path: 'test.md',
			}),
		);
	});

	it('append triggers data:changed event', async () => {
		await post({
			userId: 'user1',
			appId: 'notes',
			path: 'log.md',
			content: 'entry\n',
			mode: 'append',
		});
		expect(mockEventBus.emit).toHaveBeenCalledWith(
			'data:changed',
			expect.objectContaining({
				operation: 'append',
				appId: 'notes',
				userId: 'user1',
				path: 'log.md',
			}),
		);
	});

	it('filesystem error returns 500', async () => {
		// Use a path that is valid but will fail to write (directory as file name)
		// First create a directory at the target path
		const { mkdir } = await import('node:fs/promises');
		await mkdir(join(dataDir, 'users', 'user1', 'notes', 'conflict'), { recursive: true });
		// Try to write a file at a path where a directory already exists
		const res = await post({
			userId: 'user1',
			appId: 'notes',
			path: 'conflict',
			content: 'should fail',
		});
		expect(res.statusCode).toBe(500);
		expect(res.json().ok).toBe(false);
	});
});
