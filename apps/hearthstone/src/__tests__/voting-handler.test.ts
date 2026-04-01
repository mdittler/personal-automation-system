/**
 * Tests for the voting handler — Telegram message orchestration for meal plan voting.
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleFinalizeVotesJob,
	handleVoteCallback,
	sendVotingMessages,
} from '../handlers/voting.js';
import type { Household, MealPlan, PlannedMeal } from '../types.js';

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'chicken-stir-fry-abc',
		recipeTitle: 'Chicken Stir Fry',
		date: '2026-04-01',
		mealType: 'dinner',
		votes: {},
		cooked: false,
		rated: false,
		isNew: false,
		...overrides,
	};
}

function makePlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan-001',
		startDate: '2026-03-31',
		endDate: '2026-04-06',
		meals: [
			makeMeal({ date: '2026-04-01' }),
			makeMeal({ date: '2026-04-02', recipeTitle: 'Pasta Carbonara', recipeId: 'pasta-abc' }),
		],
		status: 'draft',
		createdAt: '2026-03-31T10:00:00.000Z',
		updatedAt: '2026-03-31T10:00:00.000Z',
		...overrides,
	};
}

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'household-001',
		name: 'Test Family',
		createdBy: 'user1',
		members: ['user1', 'user2'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function createMockScopedStore(overrides: Partial<Record<keyof ScopedDataStore, unknown>> = {}): ScopedDataStore {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as ScopedDataStore;
}

/** Build a YAML string from a plan (no frontmatter, for store mock). */
function planYaml(plan: MealPlan): string {
	return stringify(plan);
}

/** Build a YAML string from a household (no frontmatter, for store mock). */
function householdYaml(household: Household): string {
	return stringify(household);
}

// ─── sendVotingMessages ───────────────────────────────────────────────────────

describe('sendVotingMessages', () => {
	let services: CoreServices;
	let sharedStore: ScopedDataStore;

	beforeEach(() => {
		services = createMockCoreServices();
		const plan = makePlan();
		sharedStore = createMockScopedStore({
			read: vi.fn().mockResolvedValue(planYaml(plan)),
		});
	});

	it('sends one message per meal per member (2 meals × 2 members = 4 calls)', async () => {
		const household = makeHousehold({ members: ['user1', 'user2'] });
		await sendVotingMessages(services, sharedStore, household);
		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(4);
	});

	it('sends one message per meal per member (2 meals × 1 member = 2 calls)', async () => {
		const household = makeHousehold({ members: ['user1'] });
		await sendVotingMessages(services, sharedStore, household);
		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(2);
	});

	it('sets plan status to "voting" and writes it to the store', async () => {
		const household = makeHousehold();
		await sendVotingMessages(services, sharedStore, household);
		expect(sharedStore.write).toHaveBeenCalled();
		const writeCall = vi.mocked(sharedStore.write).mock.calls[0];
		expect(writeCall).toBeDefined();
		// Written content should include status: voting
		expect(writeCall![1]).toContain('voting');
	});

	it('sets votingStartedAt on the plan', async () => {
		const household = makeHousehold();
		await sendVotingMessages(services, sharedStore, household);
		const writeCall = vi.mocked(sharedStore.write).mock.calls[0];
		expect(writeCall![1]).toContain('votingStartedAt');
	});

	it('does nothing when no plan exists', async () => {
		const emptyStore = createMockScopedStore({
			read: vi.fn().mockResolvedValue(null),
		});
		const household = makeHousehold();
		await sendVotingMessages(services, emptyStore, household);
		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('sends messages to each member individually', async () => {
		const household = makeHousehold({ members: ['user1', 'user2'] });
		await sendVotingMessages(services, sharedStore, household);
		const calls = vi.mocked(services.telegram.sendWithButtons).mock.calls;
		const recipients = calls.map((c) => c[0]);
		expect(recipients).toContain('user1');
		expect(recipients).toContain('user2');
	});

	it('sends vote buttons with each meal message', async () => {
		const household = makeHousehold({ members: ['user1'] });
		await sendVotingMessages(services, sharedStore, household);
		const calls = vi.mocked(services.telegram.sendWithButtons).mock.calls;
		for (const call of calls) {
			const buttons = call[2] as unknown[][];
			expect(Array.isArray(buttons)).toBe(true);
			expect(buttons.length).toBeGreaterThan(0);
		}
	});
});

// ─── handleVoteCallback ───────────────────────────────────────────────────────

describe('handleVoteCallback', () => {
	let services: CoreServices;
	let sharedStore: ScopedDataStore;

	function setupStore(plan: MealPlan, household: Household = makeHousehold()): ScopedDataStore {
		return createMockScopedStore({
			read: vi.fn().mockImplementation(async (path: string) => {
				if (path === 'meal-plans/current.yaml') return planYaml(plan);
				if (path === 'household.yaml') return householdYaml(household);
				if (path.startsWith('recipes/')) return null;
				return '';
			}),
			list: vi.fn().mockResolvedValue([]),
		});
	}

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.get).mockResolvedValue(undefined);
	});

	it('records the vote and edits the message with a confirmation', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date().toISOString() });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'up:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(100, 200, expect.stringContaining('👍'));
	});

	it('edits message with thumbs down for a down vote', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date().toISOString() });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'down:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(100, 200, expect.stringContaining('👎'));
	});

	it('edits message with neutral emoji for a neutral vote', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date().toISOString() });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'neutral:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(100, 200, expect.stringContaining('😐'));
	});

	it('confirmation message includes the recipe title', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date().toISOString() });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'up:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			200,
			expect.stringContaining('Chicken Stir Fry'),
		);
	});

	it('saves the updated plan to the store after recording vote', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date().toISOString() });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'up:2026-04-01', 'user1', 100, 200);

		expect(sharedStore.write).toHaveBeenCalled();
	});

	it('rejects vote with "Voting has ended" when plan not in voting status', async () => {
		const plan = makePlan({ status: 'active' });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'up:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			200,
			'Voting has ended',
		);
	});

	it('rejects vote with "Voting has ended" when no plan exists', async () => {
		sharedStore = createMockScopedStore({
			read: vi.fn().mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return householdYaml(makeHousehold());
				return null;
			}),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'up:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(100, 200, 'Voting has ended');
	});

	it('returns early without editing message when meal date not found', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date().toISOString() });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		// Use a date not in the plan
		await handleVoteCallback(services, 'up:2099-12-31', 'user1', 100, 200);

		expect(services.telegram.editMessage).not.toHaveBeenCalled();
	});

	it('ignores invalid vote type', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date().toISOString() });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'badvalue:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).not.toHaveBeenCalled();
		expect(sharedStore.write).not.toHaveBeenCalled();
	});

	it('sends plan to all members when all have voted', async () => {
		// Both members have already voted on 2026-04-02; user1 is voting on 2026-04-01 last
		const plan = makePlan({
			status: 'voting',
			votingStartedAt: new Date().toISOString(),
			meals: [
				makeMeal({ date: '2026-04-01', votes: {} }), // user1 votes here
				makeMeal({ date: '2026-04-02', recipeTitle: 'Pasta', recipeId: 'pasta-abc', votes: { user1: 'up', user2: 'up' } }),
			],
		});
		// After user1 votes on 2026-04-01, allMembersVoted returns true (user2 also votes)
		// We need user2 to already have voted on 2026-04-01
		const fullPlan = makePlan({
			status: 'voting',
			votingStartedAt: new Date().toISOString(),
			meals: [
				makeMeal({ date: '2026-04-01', votes: { user2: 'up' } }), // user1 is the last voter
				makeMeal({ date: '2026-04-02', recipeTitle: 'Pasta', recipeId: 'pasta-abc', votes: { user1: 'up', user2: 'up' } }),
			],
		});
		sharedStore = setupStore(fullPlan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);
		// LLM not needed since no meals are net-negative
		vi.mocked(services.config.get).mockResolvedValue('Raleigh, NC');

		await handleVoteCallback(services, 'up:2026-04-01', 'user1', 100, 200);

		// After all voted, plan should be sent to all members (2 sendWithButtons for finalization)
		// Plus 0 sendWithButtons for the vote callback itself (editMessage is used)
		const sendCalls = vi.mocked(services.telegram.sendWithButtons).mock.calls;
		expect(sendCalls.length).toBeGreaterThanOrEqual(2);
	});

	it('returns "Voting has ended" when no household exists', async () => {
		sharedStore = createMockScopedStore({
			read: vi.fn().mockResolvedValue(null), // no household, no plan
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleVoteCallback(services, 'up:2026-04-01', 'user1', 100, 200);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(100, 200, 'Voting has ended');
	});
});

// ─── handleFinalizeVotesJob ───────────────────────────────────────────────────

describe('handleFinalizeVotesJob', () => {
	let services: CoreServices;
	let sharedStore: ScopedDataStore;

	function setupStore(plan: MealPlan | null, household: Household | null = makeHousehold()): ScopedDataStore {
		return createMockScopedStore({
			read: vi.fn().mockImplementation(async (path: string) => {
				if (path === 'meal-plans/current.yaml') return plan ? planYaml(plan) : null;
				if (path === 'household.yaml') return household ? householdYaml(household) : null;
				if (path.startsWith('recipes/')) return null;
				return '';
			}),
			list: vi.fn().mockResolvedValue([]),
		});
	}

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'voting_window_hours') return 12;
			if (key === 'location') return 'Raleigh, NC';
			return undefined;
		});
	});

	it('does nothing when no plan exists', async () => {
		sharedStore = setupStore(null);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleFinalizeVotesJob(services);

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('does nothing when plan is not in voting status', async () => {
		const plan = makePlan({ status: 'active' });
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleFinalizeVotesJob(services);

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('does nothing when no household exists', async () => {
		const plan = makePlan({ status: 'voting', votingStartedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
		sharedStore = setupStore(plan, null);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleFinalizeVotesJob(services);

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('skips finalization when voting window has not expired', async () => {
		// Started 1 hour ago, window is 12 hours
		const plan = makePlan({
			status: 'voting',
			votingStartedAt: new Date(Date.now() - 1 * 3600_000).toISOString(),
		});
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleFinalizeVotesJob(services);

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('finalizes plan when voting window has expired', async () => {
		// Started 25 hours ago, window is 12 hours
		const plan = makePlan({
			status: 'voting',
			votingStartedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
		});
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleFinalizeVotesJob(services);

		// Plan should be sent to all members (2 members in makeHousehold)
		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(2);
	});

	it('sends finalized plan to all household members', async () => {
		const plan = makePlan({
			status: 'voting',
			votingStartedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
		});
		const household = makeHousehold({ members: ['user1', 'user2', 'user3'] });
		sharedStore = setupStore(plan, household);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleFinalizeVotesJob(services);

		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(3);
		const recipients = vi.mocked(services.telegram.sendWithButtons).mock.calls.map((c) => c[0]);
		expect(recipients).toContain('user1');
		expect(recipients).toContain('user2');
		expect(recipients).toContain('user3');
	});

	it('calls LLM swap for net-negative meals before finalizing', async () => {
		// Meal on 2026-04-01 is net-negative (both members voted down)
		const plan = makePlan({
			status: 'voting',
			votingStartedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
			meals: [
				makeMeal({ date: '2026-04-01', votes: { user1: 'down', user2: 'down' } }),
				makeMeal({ date: '2026-04-02', recipeTitle: 'Pasta Carbonara', recipeId: 'pasta-abc', votes: { user1: 'up', user2: 'up' } }),
			],
		});
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		// LLM should return a replacement meal
		vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify({
			recipeId: 'new-soup-abc',
			recipeTitle: 'Tomato Soup',
			date: '2026-04-01',
			isNew: true,
			description: 'A comforting tomato soup',
		}));

		await handleFinalizeVotesJob(services);

		// LLM should have been called for the swap
		expect(services.llm.complete).toHaveBeenCalled();
		// Plan should still be sent to all members
		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(2);
	});

	it('uses default 12-hour window when config not set', async () => {
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'location') return 'Raleigh, NC';
			return undefined; // voting_window_hours not set
		});

		// Started 11 hours ago — should NOT expire with 12-hour default window
		const plan = makePlan({
			status: 'voting',
			votingStartedAt: new Date(Date.now() - 11 * 3600_000).toISOString(),
		});
		sharedStore = setupStore(plan);
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore);

		await handleFinalizeVotesJob(services);

		// Should not finalize (11 hours < 12-hour default window)
		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});
});
