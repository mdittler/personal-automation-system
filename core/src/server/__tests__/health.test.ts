import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../health-checks.js';
import { HealthChecker } from '../health-checks.js';
import { registerHealthRoute } from '../health.js';

// Minimal pino-compatible logger mock
const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as import('pino').Logger;

function makeChecker(checksOverride?: CheckResult[]): HealthChecker {
	const defaultChecks: CheckResult[] = checksOverride ?? [
		{ name: 'telegram', status: 'ok', latencyMs: 10 },
		{ name: 'scheduler', status: 'ok' },
		{ name: 'llm', status: 'ok', detail: 'llm_reachable' },
		{ name: 'filesystem', status: 'ok', latencyMs: 2 },
	];

	const allOk = defaultChecks.every((c) => c.status === 'ok');

	return {
		checkAll: vi.fn().mockResolvedValue({ allOk, checks: defaultChecks }),
		checkTelegram: vi.fn(),
		checkScheduler: vi.fn(),
		checkLLM: vi.fn(),
		checkFilesystem: vi.fn(),
	} as unknown as HealthChecker;
}

describe('GET /health', () => {
	it('should return 200 with status ok', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app);

		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.status).toBe('ok');
		expect(typeof body.uptime).toBe('number');

		await app.close();
	});

	it('should return application/json content type', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app);

		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		expect(response.headers['content-type']).toContain('application/json');

		await app.close();
	});

	it('should return uptime as a non-negative number', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app);

		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		const body = response.json();
		expect(body.uptime).toBeGreaterThanOrEqual(0);

		await app.close();
	});
});

describe('GET /health/live', () => {
	it('returns 200 with status ok and uptime', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app);

		const response = await app.inject({ method: 'GET', url: '/health/live' });

		expect(response.statusCode).toBe(200);
		const body = response.json<{ status: string; uptime: number }>();
		expect(body.status).toBe('ok');
		expect(typeof body.uptime).toBe('number');
		expect(body.uptime).toBeGreaterThanOrEqual(0);

		await app.close();
	});
});

describe('GET /health/ready', () => {
	it('returns 200 with checks array when checker passes all checks', async () => {
		const app = Fastify({ logger: false });
		const checker = makeChecker();
		registerHealthRoute(app, checker);

		const response = await app.inject({ method: 'GET', url: '/health/ready' });

		expect(response.statusCode).toBe(200);
		const body = response.json<{ status: string; uptime: number; checks: CheckResult[] }>();
		expect(body.status).toBe('ok');
		expect(typeof body.uptime).toBe('number');
		expect(Array.isArray(body.checks)).toBe(true);
		expect(body.checks.length).toBeGreaterThan(0);

		await app.close();
	});

	it('returns 503 with status degraded when an essential check (telegram) fails', async () => {
		const app = Fastify({ logger: false });
		const failChecks: CheckResult[] = [
			{ name: 'telegram', status: 'fail', detail: 'connection refused' },
			{ name: 'scheduler', status: 'ok' },
			{ name: 'llm', status: 'ok' },
			{ name: 'filesystem', status: 'ok' },
		];
		const checker = makeChecker(failChecks);
		registerHealthRoute(app, checker);

		const response = await app.inject({ method: 'GET', url: '/health/ready' });

		expect(response.statusCode).toBe(503);
		const body = response.json<{ status: string }>();
		expect(body.status).toBe('degraded');

		await app.close();
	});

	it('returns 503 with status degraded when an essential check (filesystem) fails', async () => {
		const app = Fastify({ logger: false });
		const failChecks: CheckResult[] = [
			{ name: 'telegram', status: 'ok' },
			{ name: 'scheduler', status: 'ok' },
			{ name: 'llm', status: 'ok' },
			{ name: 'filesystem', status: 'fail', detail: 'ENOENT' },
		];
		const checker = makeChecker(failChecks);
		registerHealthRoute(app, checker);

		const response = await app.inject({ method: 'GET', url: '/health/ready' });

		expect(response.statusCode).toBe(503);
		const body = response.json<{ status: string }>();
		expect(body.status).toBe('degraded');

		await app.close();
	});

	it('returns 200 when only a non-essential check (LLM) fails', async () => {
		const app = Fastify({ logger: false });
		const mixedChecks: CheckResult[] = [
			{ name: 'telegram', status: 'ok' },
			{ name: 'scheduler', status: 'ok' },
			{ name: 'llm', status: 'fail', detail: 'unreachable' },
			{ name: 'filesystem', status: 'ok' },
		];
		const checker = makeChecker(mixedChecks);
		registerHealthRoute(app, checker);

		const response = await app.inject({ method: 'GET', url: '/health/ready' });

		expect(response.statusCode).toBe(200);
		const body = response.json<{ status: string }>();
		expect(body.status).toBe('ok');

		await app.close();
	});

	it('returns 200 with status ok when only the scheduler check fails (non-essential)', async () => {
		const app = Fastify({ logger: false });
		const schedulerFailChecks: CheckResult[] = [
			{ name: 'telegram', status: 'ok' },
			{ name: 'scheduler', status: 'fail', detail: 'not running' },
			{ name: 'llm', status: 'ok' },
			{ name: 'filesystem', status: 'ok' },
		];
		const checker = makeChecker(schedulerFailChecks);
		registerHealthRoute(app, checker);

		const response = await app.inject({ method: 'GET', url: '/health/ready' });

		expect(response.statusCode).toBe(200);
		const body = response.json<{ status: string; checks: CheckResult[] }>();
		expect(body.status).toBe('ok');
		expect(body.checks.find((c) => c.name === 'scheduler')?.status).toBe('fail');

		await app.close();
	});

	it('returns 200 without checks when no checker is provided', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app); // no checker

		const response = await app.inject({ method: 'GET', url: '/health/ready' });

		expect(response.statusCode).toBe(200);
		const body = response.json<{ status: string; uptime: number; checks?: unknown }>();
		expect(body.status).toBe('ok');
		expect(typeof body.uptime).toBe('number');
		expect(body.checks).toBeUndefined();

		await app.close();
	});
});
