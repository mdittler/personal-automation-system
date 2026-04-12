import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneOffManager } from '../oneoff-manager.js';
import type { SchedulerJobNotifier } from '../notifier.js';

const logger = pino({ level: 'silent' });

/** Build a minimal mock logger with spies on warn and error. */
function makeMockLogger() {
	return {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as pino.Logger;
}

let tempDir: string;
let manager: OneOffManager;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-scheduler-'));
	manager = new OneOffManager(tempDir, logger);
});

afterEach(async () => {
	await manager.stop();
	await rm(tempDir, { recursive: true, force: true });
});

describe('OneOffManager', () => {
	it('schedules a task and persists to YAML', async () => {
		const runAt = new Date(Date.now() + 60_000);
		await manager.schedule('app-1', 'job-1', runAt, 'handlers/task.ts');

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.appId).toBe('app-1');
		expect(pending[0]?.jobId).toBe('job-1');
	});

	it('replaces an existing task with the same ID', async () => {
		const runAt1 = new Date(Date.now() + 60_000);
		const runAt2 = new Date(Date.now() + 120_000);

		await manager.schedule('app-1', 'job-1', runAt1, 'handler.ts');
		await manager.schedule('app-1', 'job-1', runAt2, 'handler.ts');

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.runAt.getTime()).toBe(runAt2.getTime());
	});

	it('cancels a pending task', async () => {
		await manager.schedule('app-1', 'job-1', new Date(Date.now() + 60_000), 'handler.ts');
		await manager.cancel('app-1', 'job-1');

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(0);
	});

	it('cancelling non-existent task is a no-op', async () => {
		await manager.cancel('app-1', 'nonexistent');
		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(0);
	});

	it('survives reload (persistence)', async () => {
		await manager.schedule('app-1', 'job-1', new Date(Date.now() + 60_000), 'handler.ts');

		// Create a new manager pointing at the same directory
		const manager2 = new OneOffManager(tempDir, logger);
		const pending = await manager2.getPendingTasks();

		expect(pending).toHaveLength(1);
		expect(pending[0]?.appId).toBe('app-1');
	});

	it('executes due tasks and removes them', async () => {
		const handler = vi.fn();
		manager.setHandlerResolver(() => handler);

		// Schedule a task in the past (immediately due)
		await manager.schedule('app-1', 'job-1', new Date(Date.now() - 1000), 'handler.ts');

		await manager.checkAndExecute();

		expect(handler).toHaveBeenCalledOnce();

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(0);
	});

	it('keeps future tasks after executing due tasks', async () => {
		const handler = vi.fn();
		manager.setHandlerResolver(() => handler);

		// One due, one future
		await manager.schedule('app-1', 'due', new Date(Date.now() - 1000), 'handler.ts');
		await manager.schedule('app-1', 'future', new Date(Date.now() + 300_000), 'handler.ts');

		await manager.checkAndExecute();

		expect(handler).toHaveBeenCalledOnce();

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.jobId).toBe('future');
	});

	it('rejects scheduling with invalid Date (NaN)', async () => {
		const invalidDate = new Date(Number.NaN);
		await expect(manager.schedule('app-1', 'job-1', invalidDate, 'handler.ts')).rejects.toThrow();
	});

	it('handles multiple apps', async () => {
		await manager.schedule('app-a', 'job-1', new Date(Date.now() + 60_000), 'a.ts');
		await manager.schedule('app-b', 'job-1', new Date(Date.now() + 60_000), 'b.ts');

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(2);
	});

	it('concurrent schedule calls do not lose tasks', async () => {
		const futureDate = new Date(Date.now() + 300_000);
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				manager.schedule('app-1', `job-${i}`, futureDate, 'handler.ts'),
			),
		);

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(5);
	});

	it('writeQueue recovers after a failed schedule', async () => {
		// Use an invalid Date — NaN date causes toISOString() to throw in saveTasks
		const invalidDate = new Date('not-a-date');
		await expect(manager.schedule('app1', 'job1', invalidDate, 'handler.js')).rejects.toThrow();

		// Second schedule with valid date should still work
		const futureDate = new Date(Date.now() + 60_000);
		await manager.schedule('app2', 'job2', futureDate, 'handler.js');

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(1);
		expect(pending[0].jobId).toBe('job2');
	});

	it('due tasks without resolver stay pending (not deleted)', async () => {
		// No setHandlerResolver called — manager must warn and keep task
		const mockLogger = makeMockLogger();
		const managerNoResolver = new OneOffManager(tempDir, mockLogger);

		await managerNoResolver.schedule('app-1', 'job-1', new Date(Date.now() - 1000), 'handler.ts');
		await managerNoResolver.checkAndExecute();

		const pending = await managerNoResolver.getPendingTasks();
		expect(pending).toHaveLength(1);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ appId: 'app-1', jobId: 'job-1' }),
			expect.stringContaining('No handler resolver'),
		);
	});

	it('due task with throwing resolver stays pending (unresolvable)', async () => {
		const mockLogger = makeMockLogger();
		const managerThrows = new OneOffManager(tempDir, mockLogger);

		await managerThrows.schedule('app-1', 'job-1', new Date(Date.now() - 1000), 'handler.ts');
		managerThrows.setHandlerResolver(() => {
			throw new Error('App not found');
		});

		await managerThrows.checkAndExecute();

		const pending = await managerThrows.getPendingTasks();
		expect(pending).toHaveLength(1);
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.objectContaining({ appId: 'app-1', jobId: 'job-1', error: 'App not found' }),
			expect.stringContaining('Handler resolver failed'),
		);
	});

	it('due task with resolved handler that throws is removed (execution failure)', async () => {
		await manager.schedule('app-1', 'job-1', new Date(Date.now() - 1000), 'handler.ts');

		manager.setHandlerResolver(() => async () => {
			throw new Error('handler crash');
		});

		await manager.checkAndExecute();

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(0);
	});

	// --- notifier integration ---

	it('calls notifier.onFailure when one-off task handler throws', async () => {
		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(false),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);
		manager.setHandlerResolver(() => async () => {
			throw new Error('boom');
		});

		await manager.schedule('app1', 'job1', new Date(Date.now() - 60_000), 'handler.js');
		await manager.checkAndExecute();

		expect(notifier.onFailure).toHaveBeenCalledWith('app1', 'job1', expect.stringContaining('boom'));
		expect(notifier.onSuccess).not.toHaveBeenCalled();

		// Task should be removed (attempted)
		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(0);
	});

	it('calls notifier.onSuccess on successful one-off task', async () => {
		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(false),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);
		manager.setHandlerResolver(() => async () => {
			// success — do nothing
		});

		await manager.schedule('app1', 'job1', new Date(Date.now() - 60_000), 'handler.js');
		await manager.checkAndExecute();

		expect(notifier.onSuccess).toHaveBeenCalledWith('app1', 'job1');
		expect(notifier.onFailure).not.toHaveBeenCalled();

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(0);
	});

	it('skips disabled one-off task and keeps it pending', async () => {
		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(true),
			onFailure: vi.fn().mockResolvedValue(false),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);

		const handler = vi.fn();
		manager.setHandlerResolver(() => handler);

		await manager.schedule('app1', 'job1', new Date(Date.now() - 60_000), 'handler.js');
		await manager.checkAndExecute();

		expect(notifier.isDisabled).toHaveBeenCalledWith('app1', 'job1');
		expect(handler).not.toHaveBeenCalled();
		expect(notifier.onSuccess).not.toHaveBeenCalled();
		expect(notifier.onFailure).not.toHaveBeenCalled();

		// Task should remain pending since it was skipped
		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(1);
	});

	// --- in-flight drain ---

	it('stop() awaits in-flight one-off task before resolving', async () => {
		let handlerFinished = false;
		let resolveHandler!: () => void;
		const handlerDone = new Promise<void>((resolve) => {
			resolveHandler = resolve;
		});

		manager.setHandlerResolver(() => async () => {
			await handlerDone;
			handlerFinished = true;
		});

		const pastDate = new Date(Date.now() - 60_000);
		await manager.schedule('app1', 'job1', pastDate, 'handler.js');

		// Start checkAndExecute without awaiting (it will block on handler)
		void manager.checkAndExecute();

		// Give checkAndExecute a moment to start executing
		await new Promise((r) => setTimeout(r, 20));
		expect(handlerFinished).toBe(false); // sanity check: handler still running

		// stop() must not resolve until the in-flight handler completes
		const stopPromise = manager.stop();

		await new Promise((r) => setTimeout(r, 10));
		expect(handlerFinished).toBe(false); // handler still blocking stop

		resolveHandler(); // let handler finish
		await stopPromise; // stop() should now resolve
		expect(handlerFinished).toBe(true); // handler completed before stop() resolved
	});

	it('stop() resolves immediately when idle', async () => {
		const start = Date.now();
		await manager.stop();
		expect(Date.now() - start).toBeLessThan(200);
	});

	// --- notifier exception resilience ---

	it('continues processing remaining tasks if notifier.onFailure throws', async () => {
		const notifier: SchedulerJobNotifier = {
			isDisabled: vi.fn().mockReturnValue(false),
			onFailure: vi.fn().mockRejectedValue(new Error('notifier exploded')),
			onSuccess: vi.fn(),
		};
		manager.setNotifier(notifier);
		manager.setHandlerResolver(() => async () => { throw new Error('handler crash'); });

		const pastDate = new Date(Date.now() - 60_000);
		// Schedule TWO tasks — if the loop aborts on first notifier failure, second is lost
		await manager.schedule('app1', 'job1', pastDate, 'handler.js');
		await manager.schedule('app1', 'job2', pastDate, 'handler.js');
		await manager.checkAndExecute();

		// Both tasks attempted and removed (notifier throw should not affect task removal)
		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(0);
	});

	// --- stop() timeout path ---

	it('stop() resolves after 30s timeout if in-flight job never completes', async () => {
		// Use a separate manager so the module-level afterEach is not affected
		const localManager = new OneOffManager(tempDir + '-timeout', logger);

		// Provide a release handle so we can unblock the handler after the test
		let releaseHandler!: () => void;
		const blockForever = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});

		localManager.setHandlerResolver(
			() =>
				async () => {
					await blockForever;
				},
		);

		const pastDate = new Date(Date.now() - 60_000);
		await localManager.schedule('app1', 'job1', pastDate, 'handler.js');

		vi.useFakeTimers();
		try {
			// Start checkAndExecute (will block on blockForever)
			void localManager.checkAndExecute();

			// Drain microtasks so the handler starts executing inside the queue chain
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// Call stop() — should resolve via 30s timeout
			const stopPromise = localManager.stop();

			// Advance 30 seconds — fires the setTimeout(resolve, 30_000) in stop()
			await vi.advanceTimersByTimeAsync(30_000);

			// stop() should now resolve (via timeout)
			await expect(stopPromise).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
			// Unblock the handler so the queue can drain and temp files can be cleaned up
			releaseHandler();
		}
	});

	// --- stopping flag ---

	it('checkAndExecute() is a no-op after stop() is called', async () => {
		manager.setHandlerResolver(() => async () => {});

		const pastDate = new Date(Date.now() - 60_000);
		await manager.schedule('app1', 'job1', pastDate, 'handler.js');

		// stop() sets stopping = true
		await manager.stop();

		// checkAndExecute should be a no-op — no tasks should be removed
		await manager.checkAndExecute();

		const pending = await manager.getPendingTasks();
		expect(pending).toHaveLength(1); // task remains because stopping=true prevented execution
	});

	it('concurrent schedule and cancel serialize correctly', async () => {
		const futureDate = new Date(Date.now() + 300_000);

		// Schedule 3 tasks sequentially first
		for (let i = 0; i < 3; i++) {
			await manager.schedule('app-1', `job-${i}`, futureDate, 'handler.ts');
		}

		// Concurrently schedule a new task and cancel an existing one
		await Promise.all([
			manager.schedule('app-1', 'job-3', futureDate, 'handler.ts'),
			manager.cancel('app-1', 'job-1'),
		]);

		const pending = await manager.getPendingTasks();
		const ids = pending.map((t) => t.jobId).sort();
		expect(ids).toContain('job-0');
		expect(ids).not.toContain('job-1');
		expect(ids).toContain('job-2');
		expect(ids).toContain('job-3');
	});
});
