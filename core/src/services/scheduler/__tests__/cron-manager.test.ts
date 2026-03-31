import cron from 'node-cron';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledJob } from '../../../types/scheduler.js';
import { CronManager } from '../cron-manager.js';

const logger = pino({ level: 'silent' });

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
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		expect(manager.getRegisteredJobs()).toEqual(['test-app:test-job']);
	});

	it('rejects duplicate job registration', () => {
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.register(makeJob(), () => handler);

		expect(manager.getRegisteredJobs()).toHaveLength(1);
	});

	it('rejects invalid cron expressions', () => {
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob({ cron: 'not a cron' }), () => handler);

		expect(manager.getRegisteredJobs()).toHaveLength(0);
	});

	it('registers multiple jobs from different apps', () => {
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob({ id: 'job-a', appId: 'app-1' }), () => handler);
		manager.register(makeJob({ id: 'job-b', appId: 'app-2' }), () => handler);

		expect(manager.getRegisteredJobs()).toEqual(['app-1:job-a', 'app-2:job-b']);
	});

	it('getJobDetails includes lastRunAt as null before any runs', () => {
		const manager = new CronManager(logger, 'America/New_York');
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
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		expect(manager.getRegisteredJobs()).toHaveLength(1);

		const result = manager.unregister('test-app:test-job');
		expect(result).toBe(true);
		expect(manager.getRegisteredJobs()).toHaveLength(0);
	});

	it('returns false when unregistering a nonexistent job', () => {
		const manager = new CronManager(logger, 'America/New_York');
		const result = manager.unregister('nonexistent:job');
		expect(result).toBe(false);
	});

	it('removes lastRunAt entry on unregister', () => {
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		// getJobDetails returns lastRunAt as null before any runs
		expect(manager.getJobDetails()[0].lastRunAt).toBeNull();

		manager.unregister('test-app:test-job');
		expect(manager.getJobDetails()).toHaveLength(0);
	});

	it('allows re-registering a job after unregister', () => {
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.unregister('test-app:test-job');

		// Re-register same key should work (no "already registered" warning)
		manager.register(makeJob(), () => handler);
		expect(manager.getRegisteredJobs()).toEqual(['test-app:test-job']);
	});

	it('start and stop do not throw', () => {
		const manager = new CronManager(logger, 'America/New_York');
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);
		manager.start();
		manager.stop();
	});

	it('passes timezone option to node-cron createTask', () => {
		const createTaskSpy = vi.spyOn(cron, 'createTask');
		const manager = new CronManager(logger, 'Europe/London');
		const handler = vi.fn();

		manager.register(makeJob(), () => handler);

		expect(createTaskSpy).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function), {
			timezone: 'Europe/London',
		});

		createTaskSpy.mockRestore();
		manager.stop();
	});
});
