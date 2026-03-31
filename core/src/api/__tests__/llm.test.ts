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

	it('sets _appId to api', async () => {
		await app.inject({
			method: 'POST',
			url: '/api/llm/complete',
			headers: authHeaders(),
			payload: { prompt: 'Test' },
		});
		expect(mockLlm.complete).toHaveBeenCalledWith(
			'Test',
			expect.objectContaining({ _appId: 'api' }),
		);
	});

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
