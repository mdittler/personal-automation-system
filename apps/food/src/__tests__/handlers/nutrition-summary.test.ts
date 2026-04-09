import { describe, expect, it, vi } from 'vitest';
import { handleWeeklyNutritionSummaryJob } from '../../handlers/nutrition-summary.js';

function createMockServices() {
	return {
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
		},
		llm: {
			complete: vi.fn().mockResolvedValue('Weekly nutrition summary.'),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		config: {
			get: vi.fn().mockResolvedValue(undefined),
		},
		data: {
			forShared: vi.fn().mockReturnValue({
				read: vi.fn().mockResolvedValue(null),
				write: vi.fn().mockResolvedValue(undefined),
				list: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(false),
			}),
			forUser: vi.fn().mockReturnValue({
				read: vi.fn().mockResolvedValue(null),
				write: vi.fn().mockResolvedValue(undefined),
				list: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(false),
			}),
		},
		timezone: 'America/New_York',
	};
}

function createHouseholdYaml() {
	return `id: h1\nname: Test Household\ncreatedBy: user1\nmembers:\n  - user1\n  - user2\njoinCode: ABC123\ncreatedAt: "2026-01-01T00:00:00.000Z"`;
}

describe('weekly-nutrition-summary handler', () => {
	it('sends weekly summary to the targeted household member only', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(createHouseholdYaml());
			return Promise.resolve(null);
		});

		// User stores have some macro data
		const userStore = services.data.forUser('');
		userStore.read.mockResolvedValue(
			`month: "2026-04"\nuserId: user1\ndays:\n  - date: "2026-04-01"\n    meals: []\n    totals: { calories: 2000, protein: 100 }`,
		);

		await handleWeeklyNutritionSummaryJob(services as never, 'user1');

		// One invocation → exactly one send to the targeted member
		expect(services.telegram.send).toHaveBeenCalledTimes(1);
		expect(services.telegram.send).toHaveBeenCalledWith('user1', expect.any(String));
	});

	it('skips when no household exists', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockResolvedValue(null);

		await handleWeeklyNutritionSummaryJob(services as never, 'user1');
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('no-ops for system users who are not in the food household', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(createHouseholdYaml());
			return Promise.resolve(null);
		});

		// user3 exists as a system user but has not joined the food household.
		await handleWeeklyNutritionSummaryJob(services as never, 'user3');

		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('warns and returns when invoked without a userId (misconfigured dispatch)', async () => {
		const services = createMockServices();

		await handleWeeklyNutritionSummaryJob(services as never, undefined);

		expect(services.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('weekly-nutrition-summary'),
		);
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('handles errors gracefully', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(createHouseholdYaml());
			return Promise.resolve(null);
		});
		services.llm.complete.mockRejectedValue(new Error('LLM down'));

		// Should not throw
		await handleWeeklyNutritionSummaryJob(services as never, 'user1');
		// Should still try to send a fallback message to the targeted member
		expect(services.telegram.send).toHaveBeenCalled();
	});
});
