import { tmpdir } from 'node:os';
import cron from 'node-cron';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledJob } from '../../../types/scheduler.js';
import { CronManager } from '../cron-manager.js';
import type { SchedulerJobNotifier } from '../notifier.js';

const logger = pino({ level: 'silent' });
const testDataDir = tmpdir();

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
	it('registers a cron job', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		expect(manager.getRegisteredJobs()).toEqual(['test-app:test-job']);
	});

	it('rejects duplicate job registration', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.register(makeJob(), () => handler);

		expect(manager.getRegisteredJobs()).toHaveLength(1);
	});

	it('rejects invalid cron expressions', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob({ cron: 'not a cron' }), () => handler);

		expect(manager.getRegisteredJobs()).toHaveLength(0);
	});

	it('registers multiple jobs from different apps', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob({ id: 'job-a', appId: 'app-1' }), () => handler);
		manager.register(makeJob({ id: 'job-b', appId: 'app-2' }), () => handler);

		expect(manager.getRegisteredJobs()).toEqual(['app-1:job-a', 'app-2:job-b']);
	});

	it('getJobDetails includes lastRunAt as null before any runs', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		const details = manager.getJobDetails();
		expect(details).toHaveLength(1);
		expect(details[0].lastRunAt).toBeNull();
		expect(details[0].key).toBe('test-app:test-job');
		expect(details[0].job.id).toBe('test-job');
	});

	// --- unregister ---

	it('unregisters an existing job and returns true', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		expect(manager.getRegisteredJobs()).toHaveLength(1);

		const result = manager.unregister('test-app:test-job');
		expect(result).toBe(true);
		expect(manager.getRegisteredJobs()).toHaveLength(0);
	});

	it('returns false when unregistering a nonexistent job', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const result = manager.unregister('nonexistent:job');
		expect(result).toBe(false);
	});

	it('removes lastRunAt entry on unregister', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		// getJobDetails returns lastRunAt as null before any runs
		expect(manager.getJobDetails()[0].lastRunAt).toBeNull();

		manager.unregister('test-app:test-job');
		expect(manager.getJobDetails()).toHaveLength(0);
	});

	it('allows re-registering a job after unregister', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.unregister('test-app:test-job');

		// Re-register same key should work (no "already registered" warning)
		manager.register(makeJob(), () => handler);
		expect(manager.getRegisteredJobs()).toEqual(['test-app:test-job']);
	});

	it('start and stop do not throw', () => {
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.start();
		manager.stop();
	});

	it('passes timezone option to node-cron createTask', () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'Europe/London', testDataDir);
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		expect(createTaskSpy).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function), {
			timezone: 'Europe/London',
		});

		createTaskSpy.mockRestore();
		manager.stop();
	});

	// --- notifier integration ---

	it('calls notifier.onFailure when cron handler throws', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', testDataDir);

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
		const manager = new CronManager(logger, 'America/New_York', testDataDir);

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
		const manager = new CronManager(logger, 'America/New_York', testDataDir);

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

	// --- in-flight drain ---

	it('stop() awaits in-flight job before resolving', async () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'America/New_York', testDataDir);

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
		const manager = new CronManager(logger, 'America/New_York', testDataDir);
		// Don't trigger any cron callback
		const start = Date.now();
		await manager.stop();
		expect(Date.now() - start).toBeLessThan(200);
	});
});
