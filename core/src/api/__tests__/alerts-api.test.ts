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
		telegram: { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() },
		llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() },
	};
}

const sampleAlert = {
	id: 'low-stock',
	name: 'Low Stock Alert',
	enabled: true,
	schedule: '0 * * * *',
	condition: { type: 'deterministic', expression: 'contains:warning' },
	actions: [{ type: 'telegram_message', message: 'Stock is low!' }],
	delivery: ['user1'],
	cooldown: '1 hour',
};

const sampleEvalResult = {
	alertId: 'low-stock',
	conditionMet: true,
	actionTriggered: true,
	actionsExecuted: 1,
};

describe('API Alerts Routes', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;
	let mockAlertService: any;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-alerts-'));
		const mocks = createMocks();

		mockAlertService = {
			listAlerts: vi.fn(() => [sampleAlert]),
			getAlert: vi.fn((id: string) => (id === 'low-stock' ? sampleAlert : null)),
			evaluate: vi.fn((id: string) =>
				id === 'low-stock'
					? sampleEvalResult
					: {
							alertId: id,
							conditionMet: false,
							actionTriggered: false,
							actionsExecuted: 0,
							error: 'Alert not found',
						},
			),
			saveAlert: vi.fn(),
			deleteAlert: vi.fn(),
			init: vi.fn(),
		};

		app = Fastify({ logger: false });
		await registerApiRoutes(app, {
			apiToken: API_TOKEN,
			rateLimiter: new RateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
			dataDir,
			changeLog: new ChangeLog(dataDir),
			spaceService: mocks.spaceService as any,
			userManager: mocks.userManager as any,
			router: mocks.router as any,
			cronManager: mocks.cronManager as any,
			timezone: 'America/New_York',
			logger,
			reportService: mocks.reportService as any,
			alertService: mockAlertService,
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

	// --- GET /api/alerts ---

	describe('GET /alerts', () => {
		it('returns list of alerts', async () => {
			const res = await app.inject({ method: 'GET', url: '/api/alerts', headers: authHeaders() });
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.ok).toBe(true);
			expect(body.alerts).toHaveLength(1);
			expect(body.alerts[0].id).toBe('low-stock');
		});

		it('returns empty list', async () => {
			mockAlertService.listAlerts.mockResolvedValue([]);
			const res = await app.inject({ method: 'GET', url: '/api/alerts', headers: authHeaders() });
			expect(res.json().alerts).toEqual([]);
		});

		it('requires authentication', async () => {
			const res = await app.inject({ method: 'GET', url: '/api/alerts' });
			expect(res.statusCode).toBe(401);
		});

		it('returns 500 on service error', async () => {
			mockAlertService.listAlerts.mockRejectedValue(new Error('Fail'));
			const res = await app.inject({ method: 'GET', url: '/api/alerts', headers: authHeaders() });
			expect(res.statusCode).toBe(500);
		});
	});

	// --- GET /api/alerts/:id ---

	describe('GET /alerts/:id', () => {
		it('returns an alert definition', async () => {
			const res = await app.inject({
				method: 'GET',
				url: '/api/alerts/low-stock',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(200);
			expect(res.json().alert.id).toBe('low-stock');
		});

		it('returns 404 for non-existent alert', async () => {
			const res = await app.inject({
				method: 'GET',
				url: '/api/alerts/nonexistent',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(404);
		});

		it('returns 400 for invalid alert ID', async () => {
			const res = await app.inject({
				method: 'GET',
				url: '/api/alerts/INVALID_ID',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(400);
		});

		it('returns 500 on service error', async () => {
			mockAlertService.getAlert.mockRejectedValue(new Error('Fail'));
			const res = await app.inject({
				method: 'GET',
				url: '/api/alerts/low-stock',
				headers: authHeaders(),
			});
			expect(res.statusCode).toBe(500);
		});
	});

	// --- POST /api/alerts/:id/evaluate ---

	describe('POST /alerts/:id/evaluate', () => {
		it('evaluates an alert successfully', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/alerts/low-stock/evaluate',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.ok).toBe(true);
			expect(body.result.conditionMet).toBe(true);
			expect(body.result.actionsExecuted).toBe(1);
		});

		it('passes preview option', async () => {
			await app.inject({
				method: 'POST',
				url: '/api/alerts/low-stock/evaluate',
				headers: authHeaders(),
				payload: { preview: true },
			});
			expect(mockAlertService.evaluate).toHaveBeenCalledWith('low-stock', { preview: true });
		});

		it('returns 404 for non-existent alert', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/alerts/nonexistent/evaluate',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(404);
		});

		it('returns 400 for invalid alert ID', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/alerts/BAD-ID/evaluate',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(400);
		});

		it('returns 500 on service error', async () => {
			mockAlertService.evaluate.mockRejectedValue(new Error('Eval failed'));
			const res = await app.inject({
				method: 'POST',
				url: '/api/alerts/low-stock/evaluate',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(500);
		});
	});

	// --- POST /api/alerts/:id/fire ---

	describe('POST /alerts/:id/fire', () => {
		it('fires an alert', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/alerts/low-stock/fire',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(200);
			expect(res.json().result.actionTriggered).toBe(true);
		});

		it('returns 404 for non-existent alert', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/alerts/nonexistent/fire',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(404);
		});

		it('returns 400 for invalid alert ID', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/alerts/BAD-ID/fire',
				headers: authHeaders(),
				payload: {},
			});
			expect(res.statusCode).toBe(400);
		});
	});
});
