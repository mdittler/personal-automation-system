import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { registerApiRoutes } from '../index.js';

const API_TOKEN = 'test-api-secret';

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

function createMockUserManager() {
	return {
		isRegistered: vi.fn(() => true),
		getUser: vi.fn(),
		getUsers: vi.fn(() => []),
		validateConfig: vi.fn(() => []),
		getUserByName: vi.fn(),
	};
}

function createMockSpaceService() {
	return {
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
	};
}

function createMockRouter() {
	return {
		routeMessage: vi.fn(),
		routePhoto: vi.fn(),
		buildRoutingTables: vi.fn(),
	};
}

describe('API Schedules Route', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-sched-'));
	});

	afterEach(async () => {
		await app?.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	function createApp(jobDetails: any[] = []) {
		const mockCronManager = {
			getJobDetails: vi.fn(() => jobDetails),
			register: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			unregister: vi.fn(),
			getRegisteredJobs: vi.fn(() => []),
		};

		app = Fastify({ logger: false });
		return registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog: new ChangeLog(dataDir),
			spaceService: createMockSpaceService() as any,
			userManager: createMockUserManager() as any,
			router: createMockRouter() as any,
			cronManager: mockCronManager as any,
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
	}

	function get() {
		return app.inject({
			method: 'GET',
			url: '/api/schedules',
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
	}

	it('returns empty schedule list', async () => {
		await createApp([]);
		const res = await get();
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.jobs).toEqual([]);
	});

	it('returns job details with human-readable descriptions', async () => {
		await createApp([
			{
				key: 'reports:weekly-review',
				job: {
					id: 'weekly-review',
					appId: 'reports',
					cron: '0 9 * * 1',
					handler: 'weekly-review',
					description: 'Report: Weekly Review',
					userScope: 'system',
				},
				lastRunAt: null,
			},
		]);

		const res = await get();
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.jobs).toHaveLength(1);

		const job = body.jobs[0];
		expect(job.key).toBe('reports:weekly-review');
		expect(job.appId).toBe('reports');
		expect(job.jobId).toBe('weekly-review');
		expect(job.description).toBe('Report: Weekly Review');
		expect(job.cron).toBe('0 9 * * 1');
		expect(job.humanSchedule).toContain('Monday');
		expect(job.nextRun).not.toBeNull();
		// API returns ISO 8601 strings, not human-readable
		expect(job.nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(job.lastRunAt).toBeNull();
	});

	it('includes lastRunAt when available', async () => {
		const lastRun = new Date('2026-03-17T09:00:00Z');
		await createApp([
			{
				key: 'system:daily-diff',
				job: {
					id: 'daily-diff',
					appId: 'system',
					cron: '0 2 * * *',
					handler: 'daily-diff',
					description: 'Generate daily diff',
					userScope: 'system',
				},
				lastRunAt: lastRun,
			},
		]);

		const res = await get();
		const body = res.json();
		expect(body.jobs[0].lastRunAt).not.toBeNull();
		// Verify ISO format
		expect(body.jobs[0].lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('handles multiple jobs', async () => {
		await createApp([
			{
				key: 'system:daily-diff',
				job: {
					id: 'daily-diff',
					appId: 'system',
					cron: '0 2 * * *',
					handler: 'dd',
					userScope: 'system',
				},
				lastRunAt: null,
			},
			{
				key: 'reports:weekly',
				job: {
					id: 'weekly',
					appId: 'reports',
					cron: '0 9 * * 1',
					handler: 'wr',
					userScope: 'system',
				},
				lastRunAt: null,
			},
		]);

		const res = await get();
		expect(res.json().jobs).toHaveLength(2);
	});

	it('job with no description returns null', async () => {
		await createApp([
			{
				key: 'app:job',
				job: { id: 'job', appId: 'app', cron: '*/5 * * * *', handler: 'h', userScope: 'all' },
				lastRunAt: null,
			},
		]);

		const res = await get();
		const job = res.json().jobs[0];
		expect(job.description).toBeNull();
	});

	it('requires authentication', async () => {
		await createApp([]);
		const res = await app.inject({
			method: 'GET',
			url: '/api/schedules',
		});
		expect(res.statusCode).toBe(401);
	});

	it('handles job with invalid cron expression gracefully', async () => {
		// getNextRun returns null for invalid cron
		await createApp([
			{
				key: 'app:bad',
				job: { id: 'bad', appId: 'app', cron: 'invalid-cron', handler: 'h', userScope: 'all' },
				lastRunAt: null,
			},
		]);

		const res = await get();
		expect(res.statusCode).toBe(200);
		const job = res.json().jobs[0];
		expect(job.nextRun).toBeNull();
		// humanSchedule falls back to raw expression for invalid cron
		expect(job.humanSchedule).toBe('invalid-cron');
	});

	it('CronManager error returns 500', async () => {
		const throwingCronManager = {
			getJobDetails: vi.fn(() => {
				throw new Error('CronManager internal error');
			}),
			register: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			unregister: vi.fn(),
			getRegisteredJobs: vi.fn(() => []),
		};

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog: new ChangeLog(dataDir),
			spaceService: createMockSpaceService() as any,
			userManager: createMockUserManager() as any,
			router: createMockRouter() as any,
			cronManager: throwingCronManager as any,
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

		const res = await app.inject({
			method: 'GET',
			url: '/api/schedules',
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
		expect(res.statusCode).toBe(500);
	});
});
