import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { ensureDir } from '../../utils/file.js';
import { registerApiRoutes } from '../index.js';

const API_TOKEN = 'test-api-secret';

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

function createMocks() {
	return {
		userManager: {
			isRegistered: vi.fn(() => true),
			getUser: vi.fn(),
			getUsers: vi.fn(() => []),
			validateConfig: vi.fn(() => []),
			getUserByName: vi.fn(),
		},
		spaceService: {
			isMember: vi.fn(() => false),
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
		},
		router: { routeMessage: vi.fn(), routePhoto: vi.fn(), buildRoutingTables: vi.fn() },
		cronManager: {
			getJobDetails: vi.fn(() => []),
			register: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			unregister: vi.fn(),
			getRegisteredJobs: vi.fn(() => []),
		},
		reportService: {
			listReports: vi.fn(() => []),
			getReport: vi.fn(),
			run: vi.fn(),
			saveReport: vi.fn(),
			deleteReport: vi.fn(),
			init: vi.fn(),
		},
		alertService: {
			listAlerts: vi.fn(() => []),
			getAlert: vi.fn(),
			evaluate: vi.fn(),
			saveAlert: vi.fn(),
			deleteAlert: vi.fn(),
			init: vi.fn(),
		},
		telegram: { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() },
		llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() },
	};
}

describe('API Changes Route', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;
	let changeLog: ChangeLog;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-changes-'));
		changeLog = new ChangeLog(dataDir);

		const mocks = createMocks();
		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog,
			spaceService: mocks.spaceService as any,
			userManager: mocks.userManager as any,
			router: mocks.router as any,
			cronManager: mocks.cronManager as any,
			timezone: 'America/New_York',
			logger,
			reportService: mocks.reportService as any,
			alertService: mocks.alertService as any,
			telegram: mocks.telegram as any,
			llm: mocks.llm as any,
		});
	});

	afterEach(async () => {
		await app?.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	function authHeaders() {
		return { authorization: `Bearer ${API_TOKEN}` };
	}

	async function writeChangeLogEntries(
		entries: Array<{
			timestamp: string;
			operation: string;
			path: string;
			appId: string;
			userId: string;
		}>,
	) {
		await ensureDir(join(dataDir, 'system'));
		const lines = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
		await appendFile(changeLog.getLogPath(), lines, 'utf-8');
	}

	it('returns empty entries when no change log exists', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/changes', headers: authHeaders() });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.entries).toEqual([]);
		expect(body.count).toBe(0);
	});

	it('returns entries from the last 24 hours by default', async () => {
		const now = new Date().toISOString();
		await writeChangeLogEntries([
			{ timestamp: now, operation: 'write', path: 'test.md', appId: 'notes', userId: 'user1' },
		]);

		const res = await app.inject({ method: 'GET', url: '/api/changes', headers: authHeaders() });
		const body = res.json();
		expect(body.count).toBe(1);
		expect(body.entries[0].appId).toBe('notes');
	});

	it('filters by since parameter', async () => {
		const old = '2025-01-01T00:00:00.000Z';
		const recent = new Date().toISOString();
		await writeChangeLogEntries([
			{ timestamp: old, operation: 'write', path: 'old.md', appId: 'notes', userId: 'user1' },
			{ timestamp: recent, operation: 'write', path: 'new.md', appId: 'notes', userId: 'user1' },
		]);

		const since = new Date(Date.now() - 60_000).toISOString();
		const res = await app.inject({
			method: 'GET',
			url: `/api/changes?since=${since}`,
			headers: authHeaders(),
		});
		const body = res.json();
		expect(body.count).toBe(1);
		expect(body.entries[0].path).toBe('new.md');
	});

	it('filters by appFilter parameter', async () => {
		const now = new Date().toISOString();
		await writeChangeLogEntries([
			{ timestamp: now, operation: 'write', path: 'a.md', appId: 'notes', userId: 'user1' },
			{ timestamp: now, operation: 'write', path: 'b.md', appId: 'chatbot', userId: 'user1' },
		]);

		const res = await app.inject({
			method: 'GET',
			url: '/api/changes?appFilter=notes',
			headers: authHeaders(),
		});
		const body = res.json();
		expect(body.count).toBe(1);
		expect(body.entries[0].appId).toBe('notes');
	});

	it('respects limit parameter', async () => {
		const now = new Date().toISOString();
		const entries = Array.from({ length: 10 }, (_, i) => ({
			timestamp: now,
			operation: 'write',
			path: `file-${i}.md`,
			appId: 'notes',
			userId: 'user1',
		}));
		await writeChangeLogEntries(entries);

		const res = await app.inject({
			method: 'GET',
			url: '/api/changes?limit=3',
			headers: authHeaders(),
		});
		expect(res.json().count).toBe(3);
	});

	it('returns empty when appFilter matches nothing', async () => {
		const now = new Date().toISOString();
		await writeChangeLogEntries([
			{ timestamp: now, operation: 'write', path: 'a.md', appId: 'notes', userId: 'user1' },
		]);

		const res = await app.inject({
			method: 'GET',
			url: '/api/changes?appFilter=nonexistent',
			headers: authHeaders(),
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().count).toBe(0);
		expect(res.json().entries).toEqual([]);
	});

	it('returns 400 for invalid since date', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/changes?since=not-a-date',
			headers: authHeaders(),
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('Invalid "since"');
	});

	it('returns 400 for invalid limit', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/changes?limit=-1',
			headers: authHeaders(),
		});
		expect(res.statusCode).toBe(400);
	});

	it('caps limit at maximum', async () => {
		const now = new Date().toISOString();
		await writeChangeLogEntries([
			{ timestamp: now, operation: 'write', path: 'a.md', appId: 'notes', userId: 'user1' },
		]);

		const res = await app.inject({
			method: 'GET',
			url: '/api/changes?limit=999999',
			headers: authHeaders(),
		});
		expect(res.statusCode).toBe(200);
	});

	it('requires authentication', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/changes' });
		expect(res.statusCode).toBe(401);
	});
});
