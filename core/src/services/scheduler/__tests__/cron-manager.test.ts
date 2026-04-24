import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cron from 'node-cron';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledJob } from '../../../types/scheduler.js';
import { CronManager } from '../cron-manager.js';
import type { SchedulerJobNotifier } from '../notifier.js';

const logger = pino({ level: 'silent' });
let tempDir: string;

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: 'test-job',
		appId: 'test-app',
		cron: '*/5 * * * *',
		handler: 'handlers/test.ts',
		description: 'Test job',
		userScope: 'system',
		...overrides,
	};
}

describe('CronManager', () => {
	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-cron-manager-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it('registers a cron job', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		expect(manager.getRegisteredJobs()).toEqual(['test-app:test-job']);
	});

	it('rejects duplicate job registration', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.register(makeJob(), () => handler);

		expect(manager.getRegisteredJobs()).toHaveLength(1);
	});

	it('rejects invalid cron expressions', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob({ cron: 'not a cron' }), () => handler);

		expect(manager.getRegisteredJobs()).toHaveLength(0);
	});

	it('registers multiple jobs from different apps', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob({ id: 'job-a', appId: 'app-1' }), () => handler);
		manager.register(makeJob({ id: 'job-b', appId: 'app-2' }), () => handler);

		expect(manager.getRegisteredJobs()).toEqual(['app-1:job-a', 'app-2:job-b']);
	});

	it('getJobDetails includes lastRunAt as null before any runs', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		const details = manager.getJobDetails();
		expect(details).toHaveLength(1);
		expect(details[0].lastRunAt).toBeNull();
		expect(details[0].key).toBe('test-app:test-job');
		expect(details[0].job.id).toBe('test-job');
		expect(details[0].disabled).toBe(false);
		expect(details[0].failureCount).toBe(0);
	});

	// --- unregister ---

	it('unregisters an existing job and returns true', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		expect(manager.getRegisteredJobs()).toHaveLength(1);

		const result = manager.unregister('test-app:test-job');
		expect(result).toBe(true);
		expect(manager.getRegisteredJobs()).toHaveLength(0);
	});

	it('returns false when unregistering a nonexistent job', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const result = manager.unregister('nonexistent:job');
		expect(result).toBe(false);
	});

	it('removes lastRunAt entry on unregister', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		// getJobDetails returns lastRunAt as null before any runs
		expect(manager.getJobDetails()[0].lastRunAt).toBeNull();

		manager.unregister('test-app:test-job');
		expect(manager.getJobDetails()).toHaveLength(0);
	});

	it('allows re-registering a job after unregister', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.unregister('test-app:test-job');

		// Re-register same key should work (no "already registered" warning)
		manager.register(makeJob(), () => handler);
		expect(manager.getRegisteredJobs()).toEqual(['test-app:test-job']);
	});

	it('start and stop do not throw', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.start();
		manager.stop();
	});

	it('isRunning() returns false before start, true after start, false after stop', async () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		expect(manager.isRunning()).toBe(false);

		manager.start();
		expect(manager.isRunning()).toBe(true);

		await manager.stop();
		expect(manager.isRunning()).toBe(false);
	});

	it('passes timezone option to node-cron createTask', () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'Europe/London', tempDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		expect(createTaskSpy).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function), {
			timezone: 'Europe/London',
		});

		createTaskSpy.mockRestore();
		manager.stop();
	});

	it('persists lastRunAt to disk and reloads it on a fresh manager instance', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const successHandler = vi.fn().mockResolvedValue(undefined);

		manager.register(makeJob(), () => successHandler);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();
		expect(manager.getJobDetails()[0]?.lastRunAt).toBeNull();

		await cronCallback();

		const persistPath = join(tempDir, 'system', 'cron-last-run.json');
		const persisted = JSON.parse(await readFile(persistPath, 'utf-8')) as Record<string, string>;
		expect(persisted['test-app:test-job']).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		const reloaded = new CronManager(logger, 'America/New_York', tempDir);
		reloaded.register(makeJob(), () => successHandler);
		const details = reloaded.getJobDetails();
		expect(details[0]?.lastRunAt).toBeInstanceOf(Date);
		expect(details[0]?.lastRunAt?.toISOString()).toBe(persisted['test-app:test-job']);
	});

	it('creates the persistence directory on first successful run', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		manager.register(makeJob(), () => vi.fn().mockResolvedValue(undefined));

		const persistPath = join(tempDir, 'system', 'cron-last-run.json');
		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await expect(readFile(persistPath, 'utf-8')).rejects.toThrow();
		await cronCallback();
		await expect(readFile(persistPath, 'utf-8')).resolves.toContain('test-app:test-job');
	});

	it('ignores malformed persisted last-run data and starts clean', async () => {
		const persistPath = join(tempDir, 'system', 'cron-last-run.json');
		await mkdir(join(tempDir, 'system'), { recursive: true });
		await writeFile(persistPath, '{not-valid-json', 'utf-8');

		const manager = new CronManager(logger, 'America/New_York', tempDir);
		manager.register(makeJob(), () => vi.fn());

		const details = manager.getJobDetails();
		expect(details).toHaveLength(1);
		expect(details[0]?.lastRunAt).toBeNull();
	});

	// --- notifier integration ---

	it('calls notifier.onFailure when cron handler throws', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(false),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);

		const throwingHandler = vi.fn().mockRejectedValue(new Error('cron boom'));
		manager.register(makeJob(), () => throwingHandler);

		// Capture the cron callback registered by createTask
		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await cronCallback();

		expect(notifier.isDisabled).toHaveBeenCalledWith('test-app', 'test-job');
		expect(notifier.onFailure).toHaveBeenCalledWith('test-app', 'test-job', 'cron boom');
		expect(notifier.onSuccess).not.toHaveBeenCalled();

		createTaskSpy.mockRestore();
		manager.stop();
	});

	it('calls notifier.onSuccess when cron handler succeeds', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(false),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);

		const successHandler = vi.fn().mockResolvedValue(undefined);
		manager.register(makeJob(), () => successHandler);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await cronCallback();

		expect(notifier.isDisabled).toHaveBeenCalledWith('test-app', 'test-job');
		expect(notifier.onSuccess).toHaveBeenCalledWith('test-app', 'test-job');
		expect(notifier.onFailure).not.toHaveBeenCalled();

		createTaskSpy.mockRestore();
		manager.stop();
	});

	it('skips execution when job is disabled', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(true),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);

		const handler = vi.fn();
		manager.register(makeJob(), () => handler);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		await cronCallback();

		expect(notifier.isDisabled).toHaveBeenCalledWith('test-app', 'test-job');
		expect(handler).not.toHaveBeenCalled();
		expect(notifier.onSuccess).not.toHaveBeenCalled();
		expect(notifier.onFailure).not.toHaveBeenCalled();

		createTaskSpy.mockRestore();
		manager.stop();
	});

	it('getJobDetails reports disabled state and failure count from the notifier', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(true),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
			getFailureCount: vi.fn().mockReturnValue(3),
			reEnable: vi.fn(),
		};
		manager.setNotifier(notifier);
		manager.register(makeJob(), () => vi.fn());

		const details = manager.getJobDetails();
		expect(details[0]?.disabled).toBe(true);
		expect(details[0]?.failureCount).toBe(3);
	});

	it('reEnable delegates to the notifier and reports whether the job was disabled', () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(true),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
			reEnable: vi.fn(),
		};
		manager.setNotifier(notifier);

		const result = manager.reEnable('test-app', 'test-job');

		expect(result).toBe(true);
		expect(notifier.reEnable).toHaveBeenCalledWith('test-app', 'test-job');
	});

	// --- in-flight drain ---

	it('stop() awaits in-flight job before resolving', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		let handlerFinished = false;
		let resolveHandler!: () => void;
		const handlerDone = new Promise<void>((resolve) => {
			resolveHandler = resolve;
		});

		manager.register(
			makeJob(),
			() =>
				async () => {
					await handlerDone;
					handlerFinished = true;
				},
		);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		// Start cron callback (it will block waiting for handlerDone)
		void cronCallback();

		// Give the callback a tick to reach in-flight state
		await new Promise((r) => setTimeout(r, 10));
		expect(handlerFinished).toBe(false); // sanity check: handler is still running

		// stop() must not resolve until the in-flight job completes
		const stopPromise = manager.stop();

		// Give stop a tick to set up drain
		await new Promise((r) => setTimeout(r, 10));
		expect(handlerFinished).toBe(false); // handler still blocking stop

		resolveHandler(); // let handler finish
		await stopPromise; // stop() should now resolve
		expect(handlerFinished).toBe(true); // handler completed before stop() resolved

		createTaskSpy.mockRestore();
	});

	it('stop() resolves immediately when no jobs are in flight', async () => {
		const manager = new CronManager(logger, 'America/New_York', tempDir);
		// Don't trigger any cron callback
		const start = Date.now();
		await manager.stop();
		expect(Date.now() - start).toBeLessThan(200);
	});

	// --- notifier exception resilience ---

	it('continues without crashing if notifier.onFailure throws', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(false),
			onFailure: vi.fn().mockRejectedValue(new Error('notifier exploded')),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);

		const throwingHandler = vi.fn().mockRejectedValue(new Error('handler crash'));
		manager.register(makeJob(), () => throwingHandler);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		// Should not throw even though notifier.onFailure rejects
		await expect(cronCallback()).resolves.toBeUndefined();

		expect(notifier.onFailure).toHaveBeenCalledWith('test-app', 'test-job', 'handler crash');

		createTaskSpy.mockRestore();
		manager.stop();
	});

	// --- stop() timeout path ---

	it('stop() resolves after 30s timeout if in-flight job never completes', async () => {
		// Provide a release handle so we can unblock the handler after the test
		let releaseHandler!: () => void;
		const blockForever = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});

		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', tempDir);

		// Register a handler that blocks until released
		manager.register(
			makeJob(),
			() =>
				async () => {
					await blockForever;
				},
		);

		const cronCallback = createTaskSpy.mock.calls[0]?.[1] as () => Promise<void>;
		expect(cronCallback).toBeDefined();

		vi.useFakeTimers();
		try {
			// Start cron callback (will block on blockForever)
			void cronCallback();

			// Drain microtasks so inFlightCount is incremented
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// stop() should resolve via 30s timeout
			const stopPromise = manager.stop();

			// Advance 30 seconds — fires the setTimeout(resolve, 30_000) in stop()
			await vi.advanceTimersByTimeAsync(30_000);

			await expect(stopPromise).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
			// Unblock the handler so in-flight work can complete
			releaseHandler();
			createTaskSpy.mockRestore();
		}
	});
});
