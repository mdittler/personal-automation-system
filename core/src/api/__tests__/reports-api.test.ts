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
		isRegistered: vi.fn((id: string) => id === 'user1' || id === 'user2'),
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
	return { routeMessage: vi.fn(), routePhoto: vi.fn(), buildRoutingTables: vi.fn() };
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

const sampleReport = {
	id: 'weekly-review',
	name: 'Weekly Review',
	enabled: true,
	schedule: '0 9 * * 1',
	delivery: ['user1'],
	sections: [],
	llm: { enabled: false },
};

const sampleRunResult = {
	reportId: 'weekly-review',
	markdown: '# Weekly Review\nSome content',
	summarized: false,
	runAt: '2026-03-19T09:00:00.000Z',
};

describe('API Reports Routes', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;
	let mockReportService: any;
	let mockTelegram: any;
	let mockUserManager: any;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-reports-'));

		mockReportService = {
			listReports: vi.fn(() => [sampleReport]),
			getReport: vi.fn((id: string) => (id === 'weekly-review' ? sampleReport : null)),
			run: vi.fn((id: string) => (id === 'weekly-review' ? sampleRunResult : null)),
			saveReport: vi.fn(),
			deleteReport: vi.fn(),
			init: vi.fn(),
		};
		mockTelegram = {
			send: vi.fn(),
			sendPhoto: vi.fn(),
			sendOptions: vi.fn(),
		};
		mockUserManager = createMockUserManager();

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog: new ChangeLog(dataDir),
			spaceService: createMockSpaceService() as any,
			userManager: mockUserManager as any,
			router: createMockRouter() as any,
			cronManager: createMockCronManager() as any,
			timezone: 'America/New_York',
			logger,
			reportService: mockReportService,
			alertService: {
				listAlerts: vi.fn(() => []),
				getAlert: vi.fn(),
				evaluate: vi.fn(),
				saveAlert: vi.fn(),
				deleteAlert: vi.fn(),
				init: vi.fn(),
			} as any,
			telegram: mockTelegram,
			llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() } as any,
		});
	});

	afterEach(async () => {
		await app?.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	function authHeaders() {
		return { authorization: `Bearer ${API_TOKEN}` };
	}

	// --- GET /api/reports ---

	describe('GET /reports', () => {
		it('returns list of reports', async () => {
			const res = await app.inject({ method: 'GET', url: '/api/reports', headers: authHeaders() });
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.ok).toBe(true);
			expect(body.reports).toHaveLength(1);
			expect(body.reports[0].id).toBe('weekly-review');
		});

		it('returns empty list when no reports', async () => {
			mockReportService.listReports.mockResolvedValue([]);
			const res = await app.inject({ method: 'GET', url: '/api/reports', headers: authHeaders() });
			expect(res.json().reports).toEqual([]);
		});

		it('requires authentication', async () => {
			const res = await app.inject({ method: 'GET', url: '/api/reports' });
			expect(res.statusCode).toBe(401);
		});

		it('returns 500 on service error', async () => {
			mockReportService.listReports.mockRejectedValue(new Error('DB error'));
			const res = await app.inject({ method: 'GET', url: '/api/reports', headers: authHeaders() });
			expect(res.statusCode).toBe(500);
		});
	});

	// --- GET /api/reports/:id ---

	describe('GET /reports/:id', () => {
		it('returns a report definition', async () => {
			const res = await app.inject({
				method: 'GET',
				url: '/api/reports/weekly-review',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.ok).toBe(true);
			expect(body.report.id).toBe('weekly-review');
		});

		it('returns 404 for non-existent report', async () => {
			const res = await app.inject({
				method: 'GET',
				url: '/api/reports/nonexistent',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(404);
		});

		it('returns 400 for invalid report ID', async () => {
			const res = await app.inject({
				method: 'GET',
				url: '/api/reports/INVALID_ID',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(400);
		});

		it('returns 500 on service error', async () => {
			mockReportService.getReport.mockRejectedValue(new Error('Read error'));
			const res = await app.inject({
				method: 'GET',
				url: '/api/reports/weekly-review',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(500);
		});
	});

	// --- POST /api/reports/:id/run ---

	describe('POST /reports/:id/run', () => {
		it('runs a report successfully', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/run',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.ok).toBe(true);
			expect(body.result.reportId).toBe('weekly-review');
			expect(body.result.markdown).toContain('Weekly Review');
		});

		it('passes preview option', async () => {
			await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/run',
				headers: authHeaders(),
				payload: { preview: true },
			});
			expect(mockReportService.run).toHaveBeenCalledWith('weekly-review', { preview: true });
		});

		it('returns 404 for non-existent report', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/nonexistent/run',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(404);
		});

		it('returns 400 for invalid report ID', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/BAD-ID/run',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(400);
		});

		it('returns 500 on service error', async () => {
			mockReportService.run.mockRejectedValue(new Error('Run failed'));
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/run',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(500);
		});
	});

	// --- POST /api/reports/:id/deliver ---

	describe('POST /reports/:id/deliver', () => {
		it('delivers content to report delivery users', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'Report content here' },
			});
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.ok).toBe(true);
			expect(body.delivered).toBe(1);
			expect(body.total).toBe(1);
			expect(mockTelegram.send).toHaveBeenCalledWith('user1', 'Report content here');
		});

		it('delivers to explicit userIds', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'Content', userIds: ['user1', 'user2'] },
			});
			expect(res.statusCode).toBe(200);
			expect(res.json().delivered).toBe(2);
		});

		it('returns 403 for unregistered explicit userIds', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'Content', userIds: ['unknown-user'] },
			});
			expect(res.statusCode).toBe(403);
		});

		it('returns 400 for missing content', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(400);
		});

		it('returns 400 for oversized content', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'x'.repeat(50_001) },
			});
			expect(res.statusCode).toBe(400);
		});

		it('returns 404 when no explicit userIds and report not found', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/nonexistent/deliver',
				headers: authHeaders(),
				payload: { content: 'Content' },
			});
			expect(res.statusCode).toBe(404);
		});

		it('returns 400 when delivery list is empty', async () => {
			mockReportService.getReport.mockResolvedValue({ ...sampleReport, delivery: [] });
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'Content' },
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error).toContain('No delivery recipients');
		});

		it('returns partial delivery results on telegram errors', async () => {
			mockTelegram.send.mockRejectedValueOnce(new Error('Telegram API error'));
			mockReportService.getReport.mockResolvedValue({
				...sampleReport,
				delivery: ['user1', 'user2'],
			});

			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'Content' },
			});
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.delivered).toBe(1);
			expect(body.total).toBe(2);
			expect(body.errors).toHaveLength(1);
		});

		it('returns 400 for invalid report ID', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/INVALID/deliver',
				headers: authHeaders(),
				payload: { content: 'Content' },
			});
			expect(res.statusCode).toBe(400);
		});

		it('returns 400 for invalid userId format in userIds array', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'Content', userIds: ['../evil'] },
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error).toContain('Invalid userId format');
		});

		it('returns 400 for non-string elements in userIds array', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/reports/weekly-review/deliver',
				headers: authHeaders(),
				payload: { content: 'Content', userIds: [123, null] },
			});
			expect(res.statusCode).toBe(400);
		});
	});
});
