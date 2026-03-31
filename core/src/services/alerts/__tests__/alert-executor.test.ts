import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AlertAction } from '../../../types/alert.js';
import { type ExecutorDeps, executeActions } from '../alert-executor.js';

const logger = pino({ level: 'silent' });

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
	return {
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
		} as any,
		reportService: {
			run: vi.fn().mockResolvedValue({
				reportId: 'test',
				markdown: '# Test',
				summarized: false,
				runAt: new Date().toISOString(),
			}),
		} as any,
		logger,
		...overrides,
	};
}

describe('executeActions', () => {
	// --- Standard (happy path) ---

	it('executes telegram_message action to all delivery users', async () => {
		const deps = makeDeps();
		const actions: AlertAction[] = [{ type: 'telegram_message', config: { message: 'Hello!' } }];

		const result = await executeActions(actions, ['user1', 'user2'], deps);

		expect(result.successCount).toBe(1);
		expect(result.failureCount).toBe(0);
		expect(deps.telegram.send).toHaveBeenCalledTimes(2);
		expect(deps.telegram.send).toHaveBeenCalledWith('user1', 'Hello!');
		expect(deps.telegram.send).toHaveBeenCalledWith('user2', 'Hello!');
	});

	it('executes run_report action', async () => {
		const deps = makeDeps();
		const actions: AlertAction[] = [{ type: 'run_report', config: { report_id: 'daily-summary' } }];

		const result = await executeActions(actions, ['user1'], deps);

		expect(result.successCount).toBe(1);
		expect(result.failureCount).toBe(0);
		expect(deps.reportService.run).toHaveBeenCalledWith('daily-summary');
	});

	it('executes multiple actions in order', async () => {
		const deps = makeDeps();
		const callOrder: string[] = [];
		(deps.telegram.send as any).mockImplementation(async () => {
			callOrder.push('telegram');
		});
		(deps.reportService.run as any).mockImplementation(async () => {
			callOrder.push('report');
			return { reportId: 'test', markdown: '', summarized: false, runAt: '' };
		});

		const actions: AlertAction[] = [
			{ type: 'telegram_message', config: { message: 'Alert!' } },
			{ type: 'run_report', config: { report_id: 'daily-summary' } },
		];

		const result = await executeActions(actions, ['user1'], deps);

		expect(result.successCount).toBe(2);
		expect(callOrder).toEqual(['telegram', 'report']);
	});

	// --- Edge cases ---

	it('handles empty actions array', async () => {
		const deps = makeDeps();
		const result = await executeActions([], ['user1'], deps);

		expect(result.successCount).toBe(0);
		expect(result.failureCount).toBe(0);
	});

	it('handles empty delivery array for telegram_message', async () => {
		const deps = makeDeps();
		const actions: AlertAction[] = [{ type: 'telegram_message', config: { message: 'Hello!' } }];

		const result = await executeActions(actions, [], deps);

		expect(result.successCount).toBe(1);
		expect(deps.telegram.send).not.toHaveBeenCalled();
	});

	it('counts unknown action type as failure', async () => {
		const deps = makeDeps();
		const actions: AlertAction[] = [{ type: 'email' as any, config: { to: 'me' } }];

		const result = await executeActions(actions, ['user1'], deps);

		expect(result.successCount).toBe(0);
		expect(result.failureCount).toBe(1);
	});

	// --- Error handling ---

	it('isolates telegram send failure per user', async () => {
		const deps = makeDeps();
		(deps.telegram.send as any)
			.mockResolvedValueOnce(undefined) // user1 succeeds
			.mockRejectedValueOnce(new Error('Network error')); // user2 fails

		const actions: AlertAction[] = [{ type: 'telegram_message', config: { message: 'Test' } }];

		// Should succeed because at least one user received the message
		const result = await executeActions(actions, ['user1', 'user2'], deps);
		expect(result.successCount).toBe(1);
	});

	it('fails telegram_message action if ALL users fail', async () => {
		const deps = makeDeps();
		(deps.telegram.send as any).mockRejectedValue(new Error('Network error'));

		const actions: AlertAction[] = [{ type: 'telegram_message', config: { message: 'Test' } }];

		const result = await executeActions(actions, ['user1', 'user2'], deps);
		expect(result.failureCount).toBe(1);
		expect(result.successCount).toBe(0);
	});

	it('fails run_report when report returns null', async () => {
		const deps = makeDeps();
		(deps.reportService.run as any).mockResolvedValue(null);

		const actions: AlertAction[] = [{ type: 'run_report', config: { report_id: 'nonexistent' } }];

		const result = await executeActions(actions, ['user1'], deps);
		expect(result.failureCount).toBe(1);
		expect(result.successCount).toBe(0);
	});

	it('isolates action failures — first fails, second succeeds', async () => {
		const deps = makeDeps();
		(deps.reportService.run as any).mockResolvedValue(null); // report fails
		// telegram succeeds by default

		const actions: AlertAction[] = [
			{ type: 'run_report', config: { report_id: 'nonexistent' } },
			{ type: 'telegram_message', config: { message: 'Alert!' } },
		];

		const result = await executeActions(actions, ['user1'], deps);
		expect(result.successCount).toBe(1);
		expect(result.failureCount).toBe(1);
	});

	it('isolates action failures — first succeeds, second fails', async () => {
		const deps = makeDeps();
		(deps.reportService.run as any).mockRejectedValue(new Error('boom'));

		const actions: AlertAction[] = [
			{ type: 'telegram_message', config: { message: 'Alert!' } },
			{ type: 'run_report', config: { report_id: 'broken' } },
		];

		const result = await executeActions(actions, ['user1'], deps);
		expect(result.successCount).toBe(1);
		expect(result.failureCount).toBe(1);
	});
});
