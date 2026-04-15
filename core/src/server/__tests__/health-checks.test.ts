import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthChecker } from '../health-checks.js';
import type { CheckResult } from '../health-checks.js';

// Minimal pino-compatible logger mock
const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as import('pino').Logger;

function makeChecker(overrides: {
	getMe?: () => Promise<unknown>;
	isRunning?: () => boolean;
	listModels?: () => Promise<unknown[]>;
	dataDir?: string;
}) {
	return new HealthChecker({
		telegram: { getMe: overrides.getMe ?? (() => Promise.resolve({ id: 1 })) },
		scheduler: { isRunning: overrides.isRunning ?? (() => true) },
		providerRegistry: {
			getAll: () => [
				{
					listModels: overrides.listModels ?? (() => Promise.resolve([])),
				},
			],
		},
		dataDir: overrides.dataDir ?? tmpdir(),
		logger: mockLogger,
	});
}

describe('HealthChecker.checkTelegram', () => {
	it('returns ok when getMe resolves quickly', async () => {
		const checker = makeChecker({ getMe: () => Promise.resolve({ id: 123 }) });
		const result = await checker.checkTelegram();
		expect(result.status).toBe('ok');
		expect(result.name).toBe('telegram');
		expect(typeof result.latencyMs).toBe('number');
	});

	it('returns fail when getMe rejects', async () => {
		const checker = makeChecker({ getMe: () => Promise.reject(new Error('connection refused')) });
		const result = await checker.checkTelegram();
		expect(result.status).toBe('fail');
		expect(result.name).toBe('telegram');
		expect(result.detail).toContain('connection refused');
	});

	it('returns fail when getMe never resolves (timeout)', async () => {
		vi.useFakeTimers();
		const neverResolves = new Promise<never>(() => {});
		const checker = makeChecker({ getMe: () => neverResolves });

		const resultPromise = checker.checkTelegram();
		// Advance past the 5s timeout
		vi.advanceTimersByTime(6_000);
		const result = await resultPromise;

		expect(result.status).toBe('fail');
		expect(result.detail).toContain('timed out');
		vi.useRealTimers();
	});
});

describe('HealthChecker.checkScheduler', () => {
	it('returns ok when scheduler is running', () => {
		const checker = makeChecker({ isRunning: () => true });
		const result = checker.checkScheduler();
		expect(result.status).toBe('ok');
		expect(result.name).toBe('scheduler');
	});

	it('returns fail when scheduler is not running', () => {
		const checker = makeChecker({ isRunning: () => false });
		const result = checker.checkScheduler();
		expect(result.status).toBe('fail');
		expect(result.name).toBe('scheduler');
	});
});

describe('HealthChecker.checkLLM', () => {
	it('returns ok when listModels resolves', async () => {
		const checker = makeChecker({
			listModels: () => Promise.resolve([{ id: 'model-a', displayName: 'Model A' }]),
		});
		const result = await checker.checkLLM();
		expect(result.status).toBe('ok');
		expect(result.name).toBe('llm');
		expect(result.detail).toBe('llm_reachable');
	});

	it('returns fail with llm_configured when listModels fails (provider is configured but unreachable)', async () => {
		const checker = makeChecker({
			listModels: () => Promise.reject(new Error('network error')),
		});
		const result = await checker.checkLLM();
		expect(result.status).toBe('fail');
		expect(result.detail).toBe('llm_configured');
	});

	it('returns fail when no providers are configured', async () => {
		const checker = new HealthChecker({
			telegram: { getMe: () => Promise.resolve({}) },
			scheduler: { isRunning: () => true },
			providerRegistry: { getAll: () => [] },
			dataDir: tmpdir(),
			logger: mockLogger,
		});
		const result = await checker.checkLLM();
		expect(result.status).toBe('fail');
		expect(result.detail).toContain('no providers configured');
	});

	it('caches result for 60s and only calls listModels once', async () => {
		const listModels = vi.fn().mockResolvedValue([]);
		const checker = makeChecker({ listModels });

		await checker.checkLLM();
		await checker.checkLLM();
		await checker.checkLLM();

		// Should only have called the underlying listModels once
		expect(listModels).toHaveBeenCalledTimes(1);
	});

	it('calls listModels again after the 60s cache TTL expires', async () => {
		vi.useFakeTimers();
		try {
			const listModels = vi.fn().mockResolvedValue([]);
			const checker = makeChecker({ listModels });

			await checker.checkLLM();
			expect(listModels).toHaveBeenCalledTimes(1);

			// Advance past the 60s TTL
			vi.advanceTimersByTime(61_000);

			await checker.checkLLM();
			expect(listModels).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('HealthChecker.checkFilesystem', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'pas-health-test-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('returns ok for a writable directory', async () => {
		const checker = makeChecker({ dataDir: tmpDir });
		const result = await checker.checkFilesystem();
		expect(result.status).toBe('ok');
		expect(result.name).toBe('filesystem');
		expect(typeof result.latencyMs).toBe('number');
	});

	it('returns fail when the write operation fails', async () => {
		// Use a path containing a null byte — guaranteed to fail on all platforms
		const checker = makeChecker({ dataDir: 'path\0invalid' });
		const result = await checker.checkFilesystem();
		expect(result.status).toBe('fail');
		expect(result.name).toBe('filesystem');
		expect(result.detail).toBeDefined();
	});
});

describe('HealthChecker.checkAll', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'pas-health-all-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('returns allOk=true when all checks pass', async () => {
		const checker = new HealthChecker({
			telegram: { getMe: () => Promise.resolve({ id: 1 }) },
			scheduler: { isRunning: () => true },
			providerRegistry: { getAll: () => [{ listModels: () => Promise.resolve([]) }] },
			dataDir: tmpDir,
			logger: mockLogger,
		});

		const { allOk, checks } = await checker.checkAll();
		expect(allOk).toBe(true);
		expect(checks).toHaveLength(4);
		expect(checks.every((c) => c.status === 'ok')).toBe(true);
	});

	it('returns allOk=false when a check fails', async () => {
		const checker = new HealthChecker({
			telegram: { getMe: () => Promise.reject(new Error('no telegram')) },
			scheduler: { isRunning: () => true },
			providerRegistry: { getAll: () => [{ listModels: () => Promise.resolve([]) }] },
			dataDir: tmpDir,
			logger: mockLogger,
		});

		const { allOk, checks } = await checker.checkAll();
		expect(allOk).toBe(false);
		const telegramCheck = checks.find((c) => c.name === 'telegram');
		expect(telegramCheck?.status).toBe('fail');
	});
});
