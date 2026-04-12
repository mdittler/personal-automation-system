import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneOffManager } from '../oneoff-manager.js';

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
	manager.stop();
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
