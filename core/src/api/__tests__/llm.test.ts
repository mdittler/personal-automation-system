import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import type { CostTracker } from '../../services/llm/cost-tracker.js';
import { SystemLLMGuard } from '../../services/llm/system-llm-guard.js';
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
	};
}

describe('API LLM Route', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;
	let mockLlm: any;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-llm-'));
		const mocks = createMocks();

		mockLlm = {
			complete: vi.fn(() => 'LLM response text'),
			classify: vi.fn(),
			extractStructured: vi.fn(),
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
			alertService: mocks.alertService as any,
			telegram: mocks.telegram as any,
			llm: mockLlm,
		});
	});

	afterEach(async () => {
		await app?.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	function authHeaders() {
		return { authorization: `Bearer ${API_TOKEN}` };
	}

	it('completes an LLM prompt', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Hello world' },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.text).toBe('LLM response text');
		expect(body.tier).toBe('fast');
	});

	it('uses specified tier', async () => {
		await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test', tier: 'standard' },
		});
		expect(mockLlm.complete).toHaveBeenCalledWith(
			'Test',
			expect.objectContaining({ tier: 'standard' }),
		);
	});

	it('passes systemPrompt, maxTokens, temperature', async () => {
		await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: {
				prompt: 'Test',
				systemPrompt: 'You are helpful',
				maxTokens: 500,
				temperature: 0.5,
			},
		});
		expect(mockLlm.complete).toHaveBeenCalledWith(
			'Test',
			expect.objectContaining({
				systemPrompt: 'You are helpful',
				maxTokens: 500,
				temperature: 0.5,
			}),
		);
	});

	// _appId attribution is handled by the SystemLLMGuard (attributionId: 'api') wired in
	// bootstrap — the route itself does not stamp _appId. The guard behaviour is verified in
	// the 'API LLM Route — SystemLLMGuard integration (F14)' describe block below.

	it('returns 400 for missing prompt', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: {},
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for empty prompt', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: '   ' },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for invalid tier', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test', tier: 'invalid' },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain('Invalid tier');
	});

	it('returns 400 for invalid maxTokens', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test', maxTokens: -1 },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for invalid temperature', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test', temperature: 3.0 },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for oversized prompt', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'x'.repeat(100_001) },
		});
		expect(res.statusCode).toBe(400);
	});

	it('returns 429 for cost cap errors with sanitized message', async () => {
		mockLlm.complete.mockRejectedValue(
			new Error("Monthly cost cap exceeded for app 'api': $10.00"),
		);
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test' },
		});
		expect(res.statusCode).toBe(429);
		// Should NOT leak the raw error details
		expect(res.json().error).toBe('LLM cost cap exceeded. Try again later.');
		expect(res.json().error).not.toContain('$10.00');
	});

	it('returns 429 for rate limit errors with sanitized message', async () => {
		mockLlm.complete.mockRejectedValue(new Error('Rate limit exceeded for app api'));
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test' },
		});
		expect(res.statusCode).toBe(429);
		expect(res.json().error).toBe('LLM rate limit exceeded. Try again later.');
	});

	it('returns 500 for generic LLM errors', async () => {
		mockLlm.complete.mockRejectedValue(new Error('Network error'));
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test' },
		});
		expect(res.statusCode).toBe(500);
	});

	it('requires authentication', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			payload: { prompt: 'Test' },
		});
		expect(res.statusCode).toBe(401);
	});
});

describe('API LLM Route — SystemLLMGuard integration (F14)', () => {
	let app: ReturnType<typeof Fastify>;
	let dataDir: string;
	let innerLlm: any;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-api-llm-guard-'));
		const mocks = createMocks();

		innerLlm = {
			complete: vi.fn(() => 'response'),
			classify: vi.fn(),
			extractStructured: vi.fn(),
		};

		const mockCostTracker = {
			getMonthlyTotalCost: vi.fn(() => 0),
			record: vi.fn().mockResolvedValue(undefined),
			estimateCost: vi.fn(() => 0),
			readUsage: vi.fn().mockResolvedValue(''),
			loadMonthlyCache: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
			getMonthlyAppCost: vi.fn(() => 0),
			getMonthlyAppCosts: vi.fn(() => new Map()),
			getMonthlyUserCost: vi.fn(() => 0),
			getMonthlyUserCosts: vi.fn(() => new Map()),
		} as unknown as CostTracker;

		// Wire through the real SystemLLMGuard with attributionId: 'api' — same as bootstrap
		const apiLlm = new SystemLLMGuard({
			inner: innerLlm,
			costTracker: mockCostTracker,
			globalMonthlyCostCap: 50.0,
			logger: pino({ level: 'silent' }),
			attributionId: 'api',
		});

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
			logger: pino({ level: 'silent' }) as any,
			reportService: mocks.reportService as any,
			alertService: mocks.alertService as any,
			telegram: mocks.telegram as any,
			llm: apiLlm,
		});
	});

	afterEach(async () => {
		await app?.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	it('routes through SystemLLMGuard and attributes cost to api not system', async () => {
		await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: { authorization: `Bearer ${API_TOKEN}` },
			payload: { prompt: 'Test' },
		});

		expect(innerLlm.complete).toHaveBeenCalled();
		const callArgs = (innerLlm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
		// The guard must stamp _appId: 'api', not 'system'
		expect(callArgs[1]?._appId).toBe('api');
	});
});
