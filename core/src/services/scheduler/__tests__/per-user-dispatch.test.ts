import { describe, expect, it, vi } from 'vitest';
import { getCurrentHouseholdId, getCurrentUserId } from '../../context/request-context.js';
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
	it('user_scope: shared without HouseholdService calls handler once with no userId — legacy regression guard', async () => {
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
			// no householdService → legacy single-dispatch
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

// ---------------------------------------------------------------------------
// R1: user_scope: shared dispatched per-household when HouseholdService wired
// ---------------------------------------------------------------------------

describe('buildScheduledJobHandler — user_scope: shared per-household dispatch (R1)', () => {
	const mockHouseholdService = {
		getHouseholdForUser: vi.fn(),
		listHouseholds: vi.fn(),
	};

	it('runs once per household with householdId in request context', async () => {
		mockHouseholdService.listHouseholds.mockReturnValue([
			{ id: 'hh-alpha', name: 'Alpha', createdAt: '', createdBy: 'u1', adminUserIds: [] },
			{ id: 'hh-beta', name: 'Beta', createdAt: '', createdBy: 'u2', adminUserIds: [] },
		]);

		const seenHouseholds: Array<string | undefined> = [];
		const handleScheduledJob = vi.fn(async () => {
			seenHouseholds.push(getCurrentHouseholdId());
		});

		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'perishable-check',
			userScope: 'shared',
			appModule: { handleScheduledJob },
			userProvider: { getAllUsers: () => [] },
			logger: mockLogger(),
			householdService: mockHouseholdService,
		});

		await handler();

		expect(handleScheduledJob).toHaveBeenCalledTimes(2);
		expect(handleScheduledJob).toHaveBeenCalledWith('perishable-check');
		expect(seenHouseholds).toEqual(['hh-alpha', 'hh-beta']);
	});

	it('per-household error does not abort siblings', async () => {
		mockHouseholdService.listHouseholds.mockReturnValue([
			{ id: 'hh-alpha', name: 'Alpha', createdAt: '', createdBy: 'u1', adminUserIds: [] },
			{ id: 'hh-beta', name: 'Beta', createdAt: '', createdBy: 'u2', adminUserIds: [] },
			{ id: 'hh-gamma', name: 'Gamma', createdAt: '', createdBy: 'u3', adminUserIds: [] },
		]);

		const logger = mockLogger();
		const seenHouseholds: Array<string | undefined> = [];
		const handleScheduledJob = vi.fn(async () => {
			const hhId = getCurrentHouseholdId();
			seenHouseholds.push(hhId);
			if (hhId === 'hh-beta') throw new Error('beta-failure');
		});

		const handler = buildScheduledJobHandler({
			appId: 'food',
			jobId: 'perishable-check',
			userScope: 'shared',
			appModule: { handleScheduledJob },
			userProvider: { getAllUsers: () => [] },
			logger,
			householdService: mockHouseholdService,
		});

		await handler();

		// All 3 households attempted
		expect(seenHouseholds).toEqual(['hh-alpha', 'hh-beta', 'hh-gamma']);
		// Failure for beta was logged
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: 'food',
				jobId: 'perishable-check',
				householdId: 'hh-beta',
				error: 'beta-failure',
			}),
			'Shared scheduled job invocation failed for household',
		);
	});

	it('user_scope: system still dispatches once even with HouseholdService — regression guard', async () => {
		mockHouseholdService.listHouseholds.mockReturnValue([
			{ id: 'hh-alpha', name: 'Alpha', createdAt: '', createdBy: 'u1', adminUserIds: [] },
		]);

		const handleScheduledJob = vi.fn(async () => {});
		const handler = buildScheduledJobHandler({
			appId: 'backup',
			jobId: 'daily-backup',
			userScope: 'system',
			appModule: { handleScheduledJob },
			userProvider: { getAllUsers: () => [] },
			logger: mockLogger(),
			householdService: mockHouseholdService,
		});

		await handler();

		expect(handleScheduledJob).toHaveBeenCalledTimes(1);
		expect(handleScheduledJob).toHaveBeenCalledWith('daily-backup');
	});
});
