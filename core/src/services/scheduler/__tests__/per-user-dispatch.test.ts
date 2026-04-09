import { describe, expect, it, vi } from 'vitest';
import { getCurrentUserId } from '../../context/request-context.js';
import { buildScheduledJobHandler } from '../per-user-dispatch.js';

function mockLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(() => mockLogger()),
		level: 'info',
	} as never;
}

describe('buildScheduledJobHandler', () => {
	it('user_scope: shared calls handler once with no userId', async () => {
		const handleScheduledJob = vi.fn(async () => {});
		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'weekly-plan',
			userScope: 'shared',
			appModule: { handleScheduledJob },
			userProvider: {
				getAllUsers: () => [{ id: 'a' }, { id: 'b' }],
			},
			logger: mockLogger(),
		});

		await handler();

		expect(handleScheduledJob).toHaveBeenCalledTimes(1);
		expect(handleScheduledJob).toHaveBeenCalledWith('weekly-plan');
	});

	it('user_scope: system calls handler once with no userId', async () => {
		const handleScheduledJob = vi.fn(async () => {});
		const handler = buildScheduledJobHandler({
			appId: 'notes',
			jobId: 'cleanup',
			userScope: 'system',
			appModule: { handleScheduledJob },
			userProvider: { getAllUsers: () => [{ id: 'a' }] },
			logger: mockLogger(),
		});

		await handler();

		expect(handleScheduledJob).toHaveBeenCalledTimes(1);
		expect(handleScheduledJob).toHaveBeenCalledWith('cleanup');
	});

	it('user_scope: all iterates users and passes userId to handler', async () => {
		const calls: Array<[string, string | undefined]> = [];
		const handleScheduledJob = vi.fn(async (jobId: string, userId?: string) => {
			calls.push([jobId, userId]);
		});

		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'nutrition-summary',
			userScope: 'all',
			appModule: { handleScheduledJob },
			userProvider: {
				getAllUsers: () => [{ id: 'alice' }, { id: 'bob' }, { id: 'carol' }],
			},
			logger: mockLogger(),
		});

		await handler();

		expect(calls).toEqual([
			['nutrition-summary', 'alice'],
			['nutrition-summary', 'bob'],
			['nutrition-summary', 'carol'],
		]);
	});

	it('user_scope: all wraps each invocation in requestContext so config lookups see the user', async () => {
		const seen: Array<string | undefined> = [];
		const handleScheduledJob = vi.fn(async () => {
			// Simulate a handler calling services.config.get — which reads getCurrentUserId internally
			seen.push(getCurrentUserId());
		});

		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'nutrition-summary',
			userScope: 'all',
			appModule: { handleScheduledJob },
			userProvider: {
				getAllUsers: () => [{ id: 'alice' }, { id: 'bob' }],
			},
			logger: mockLogger(),
		});

		await handler();

		expect(seen).toEqual(['alice', 'bob']);
	});

	it('user_scope: all isolates per-user errors — one failure does not abort the loop', async () => {
		const logger = mockLogger();
		const calls: string[] = [];
		const handleScheduledJob = vi.fn(async (_jobId: string, userId?: string) => {
			calls.push(userId!);
			if (userId === 'bob') throw new Error('bob-specific failure');
		});

		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'nutrition-summary',
			userScope: 'all',
			appModule: { handleScheduledJob },
			userProvider: {
				getAllUsers: () => [{ id: 'alice' }, { id: 'bob' }, { id: 'carol' }],
			},
			logger,
		});

		await handler();

		// All three users were attempted, even though bob threw
		expect(calls).toEqual(['alice', 'bob', 'carol']);
		// The failure for bob was logged
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: 'food',
				jobId: 'nutrition-summary',
				userId: 'bob',
				error: 'bob-specific failure',
			}),
			'Per-user scheduled job invocation failed for user',
		);
	});

	it('user_scope: all with zero users logs and returns without calling handler', async () => {
		const logger = mockLogger();
		const handleScheduledJob = vi.fn(async () => {});

		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'nutrition-summary',
			userScope: 'all',
			appModule: { handleScheduledJob },
			userProvider: { getAllUsers: () => [] },
			logger,
		});

		await handler();

		expect(handleScheduledJob).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({ appId: 'food', jobId: 'nutrition-summary' }),
			'Per-user scheduled job has no users to dispatch to',
		);
	});

	it('does nothing if the app module has no handleScheduledJob', async () => {
		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'x',
			userScope: 'all',
			appModule: {},
			userProvider: { getAllUsers: () => [{ id: 'alice' }] },
			logger: mockLogger(),
		});

		await expect(handler()).resolves.toBeUndefined();
	});
});
