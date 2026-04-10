/**
 * Cultural Calendar Handler Tests (H12b)
 *
 * Tests for handleCulturalCalendarJob (weekly scheduled job) and
 * handleCulturalCalendarMessage (on-demand NL handler).
 *
 * Uses vi.setSystemTime to freeze time for deterministic upcoming holiday checks.
 * Frozen date: 2025-12-20 → Christmas Dec 25 is 5 days away (within 14-day window).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stringify } from 'yaml';
import { generateFrontmatter } from '@pas/core/utils/frontmatter';
import type { CoreServices } from '@pas/core/types';
import {
	handleCulturalCalendarJob,
	handleCulturalCalendarMessage,
	isCulturalCalendarIntent,
} from '../../handlers/cultural-calendar-handler.js';
import type { CulturalCalendar } from '../../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const FROZEN_DATE = '2025-12-20'; // Christmas Dec 25 is within 14-day window

function createMockServices(overrides: Partial<{
	llmResponse: string;
	configEnabled: boolean;
	location: string;
}> = {}) {
	const { llmResponse = 'Try this holiday recipe!', configEnabled = true, location = 'Raleigh, NC' } = overrides;
	return {
		telegram: { send: vi.fn().mockResolvedValue(undefined) },
		llm: { complete: vi.fn().mockResolvedValue(llmResponse) },
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		config: {
			get: vi.fn().mockImplementation((key: string) => {
				if (key === 'cultural_calendar') return Promise.resolve(configEnabled);
				if (key === 'location') return Promise.resolve(location);
				return Promise.resolve(undefined);
			}),
		},
		data: {
			forShared: vi.fn().mockReturnValue({
				read: vi.fn().mockResolvedValue(null),
				write: vi.fn().mockResolvedValue(undefined),
				list: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(false),
				append: vi.fn().mockResolvedValue(undefined),
				archive: vi.fn().mockResolvedValue(undefined),
			}),
			forUser: vi.fn().mockReturnValue({
				read: vi.fn().mockResolvedValue(null),
				write: vi.fn().mockResolvedValue(undefined),
				list: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(false),
				append: vi.fn().mockResolvedValue(undefined),
				archive: vi.fn().mockResolvedValue(undefined),
			}),
		},
	};
}

function makeHouseholdYaml(members = ['user1', 'user2']): string {
	return `id: h1\nname: Test Household\ncreatedBy: user1\nmembers:\n${members.map(m => `  - ${m}`).join('\n')}\njoinCode: ABC123\ncreatedAt: "2025-01-01T00:00:00.000Z"`;
}

function makeCalendarYaml(calendar: CulturalCalendar): string {
	const fm = generateFrontmatter({ title: 'Cultural Calendar', date: new Date().toISOString(), tags: ['food'] });
	return fm + stringify({ holidays: calendar.holidays });
}

/** A minimal calendar with just Christmas (Dec 25) for deterministic testing. */
function makeChristmasCalendar(): CulturalCalendar {
	return {
		holidays: [{
			id: 'christmas',
			name: 'Christmas',
			dateRule: { type: 'fixed', month: 12, day: 25 },
			cuisine: 'American',
			traditionalFoods: ['roast turkey', 'glazed ham', 'mashed potatoes'],
			region: 'US',
			enabled: true,
		}],
	};
}

// ─── handleCulturalCalendarJob ────────────────────────────────────────────

describe('handleCulturalCalendarJob', () => {
	beforeEach(() => {
		vi.setSystemTime(new Date(`${FROZEN_DATE}T12:00:00Z`));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends holiday recipe suggestion to all household members when a holiday is upcoming', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(makeChristmasCalendar()));
			return Promise.resolve(null);
		});

		await handleCulturalCalendarJob(services as unknown as CoreServices);

		expect(services.llm.complete).toHaveBeenCalledOnce();
		expect(services.telegram.send).toHaveBeenCalledTimes(2); // user1 + user2
		const [, message] = services.telegram.send.mock.calls[0]!;
		expect(message).toBe('Try this holiday recipe!');
	});

	it('sends nothing when no holidays are within the 14-day window', async () => {
		const services = createMockServices();
		const emptyCalendar: CulturalCalendar = { holidays: [] };
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(emptyCalendar));
			return Promise.resolve(null);
		});

		await handleCulturalCalendarJob(services as unknown as CoreServices);

		expect(services.llm.complete).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('returns early when cultural_calendar config is false', async () => {
		const services = createMockServices({ configEnabled: false });

		await handleCulturalCalendarJob(services as unknown as CoreServices);

		expect(services.llm.complete).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('returns early when no household exists', async () => {
		const services = createMockServices();
		// sharedStore.read returns null for all → household.yaml missing

		await handleCulturalCalendarJob(services as unknown as CoreServices);

		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('handles LLM failure gracefully without throwing', async () => {
		const services = createMockServices();
		services.llm.complete.mockRejectedValue(new Error('LLM down'));
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(makeChristmasCalendar()));
			return Promise.resolve(null);
		});

		// Should not throw
		await expect(handleCulturalCalendarJob(services as unknown as CoreServices)).resolves.toBeUndefined();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('writes defaults to shared store when cultural-calendar.yaml is missing (first run)', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
			// cultural-calendar.yaml missing → ensureCalendar writes defaults
			return Promise.resolve(null);
		});

		await handleCulturalCalendarJob(services as unknown as CoreServices);

		// ensureCalendar should have written defaults to the store
		expect(sharedStore.write).toHaveBeenCalledWith(
			'cultural-calendar.yaml',
			expect.stringContaining('thanksgiving'),
		);
	});

	it('LLM prompt includes upcoming holiday name', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(makeChristmasCalendar()));
			return Promise.resolve(null);
		});

		await handleCulturalCalendarJob(services as unknown as CoreServices);

		const prompt = services.llm.complete.mock.calls[0]![0] as string;
		expect(prompt).toContain('Christmas');
		expect(prompt).toContain('roast turkey');
	});

	it('sends both holiday names in LLM prompt when two holidays are in the window', async () => {
		const services = createMockServices();
		// Christmas Eve (Dec 24) and Christmas (Dec 25) — both within 14 days of Dec 20
		const twoHolidayCalendar: CulturalCalendar = {
			holidays: [
				{
					id: 'christmas-eve',
					name: 'Christmas Eve',
					dateRule: { type: 'fixed', month: 12, day: 24 },
					cuisine: 'American',
					traditionalFoods: ['seafood', 'prime rib', 'eggnog'],
					region: 'US',
					enabled: true,
				},
				{
					id: 'christmas',
					name: 'Christmas',
					dateRule: { type: 'fixed', month: 12, day: 25 },
					cuisine: 'American',
					traditionalFoods: ['roast turkey', 'glazed ham'],
					region: 'US',
					enabled: true,
				},
			],
		};
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(twoHolidayCalendar));
			return Promise.resolve(null);
		});

		await handleCulturalCalendarJob(services as unknown as CoreServices);

		const prompt = services.llm.complete.mock.calls[0]![0] as string;
		expect(prompt).toContain('Christmas Eve');
		expect(prompt).toContain('Christmas');
	});
});

// ─── handleCulturalCalendarMessage ───────────────────────────────────────

describe('handleCulturalCalendarMessage', () => {
	beforeEach(() => {
		vi.setSystemTime(new Date(`${FROZEN_DATE}T12:00:00Z`));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends holiday-specific suggestion when a holiday name is mentioned in the message', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(makeChristmasCalendar()));
			return Promise.resolve(null);
		});

		const ctx = { userId: 'user1', text: 'What should I cook for Christmas?' };
		await handleCulturalCalendarMessage(services as unknown as CoreServices, ctx as never);

		expect(services.llm.complete).toHaveBeenCalledOnce();
		expect(services.telegram.send).toHaveBeenCalledWith('user1', 'Try this holiday recipe!');
		const prompt = services.llm.complete.mock.calls[0]![0] as string;
		expect(prompt).toContain('Christmas');
	});

	it('sends upcoming holidays suggestion when no specific holiday named', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(makeChristmasCalendar()));
			return Promise.resolve(null);
		});

		const ctx = { userId: 'user1', text: 'Any holiday recipes coming up?' };
		await handleCulturalCalendarMessage(services as unknown as CoreServices, ctx as never);

		expect(services.llm.complete).toHaveBeenCalledOnce();
		expect(services.telegram.send).toHaveBeenCalledWith('user1', 'Try this holiday recipe!');
	});

	it('sends "no upcoming holidays" message when nothing is within the window', async () => {
		const services = createMockServices();
		const emptyCalendar: CulturalCalendar = { holidays: [] };
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(emptyCalendar));
			return Promise.resolve(null);
		});

		const ctx = { userId: 'user1', text: 'Any holiday recipes?' };
		await handleCulturalCalendarMessage(services as unknown as CoreServices, ctx as never);

		expect(services.llm.complete).not.toHaveBeenCalled();
		const [, message] = services.telegram.send.mock.calls[0]!;
		expect(message).toMatch(/no.*holidays?/i);
	});

	it('sends "no upcoming holidays" when named holiday has no future dates (table miss)', async () => {
		const services = createMockServices();
		// Calendar has a holiday with table entries only for 2024 — no entry for 2025 or 2026
		const staleCalendar: CulturalCalendar = {
			holidays: [{
				id: 'lunar-new-year',
				name: 'Lunar New Year',
				dateRule: { type: 'table', dates: { 2024: '02-10' } },
				cuisine: 'Chinese',
				traditionalFoods: ['dumplings', 'noodles'],
				region: 'East Asian',
				enabled: true,
			}],
		};
		const sharedStore = services.data.forShared('shared');
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(staleCalendar));
			return Promise.resolve(null);
		});

		const ctx = { userId: 'user1', text: 'What should I cook for Lunar New Year?' };
		await handleCulturalCalendarMessage(services as unknown as CoreServices, ctx as never);

		expect(services.llm.complete).not.toHaveBeenCalled();
		const [, message] = services.telegram.send.mock.calls[0]!;
		expect(message).toMatch(/no.*holidays?/i);
	});

	it('recovers from corrupt cultural-calendar.yaml and uses seed defaults', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');
		// Corrupt YAML in file — ensureCalendar should write defaults and return them
		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'cultural-calendar.yaml') return Promise.resolve('---\n{invalid yaml: [');
			return Promise.resolve(null);
		});

		const ctx = { userId: 'user1', text: 'Any holiday recipes?' };
		// Should not throw — either sends a suggestion or "no upcoming"
		await expect(handleCulturalCalendarMessage(services as unknown as CoreServices, ctx as never)).resolves.toBeUndefined();
		expect(sharedStore.write).toHaveBeenCalledWith('cultural-calendar.yaml', expect.any(String));
		expect(services.telegram.send).toHaveBeenCalledOnce();
	});

	it('includes matching household recipe titles in the LLM prompt', async () => {
		const services = createMockServices();
		const sharedStore = services.data.forShared('shared');

		// Christmas calendar + one matching recipe that contains a traditional food keyword ("ham")
		const fm = generateFrontmatter({ title: 'Glazed Ham', date: '2025-01-01T00:00:00.000Z', tags: ['food', 'recipe'] });
		const recipeYaml = fm + stringify({
			id: 'glazed-ham-r1',
			title: 'Glazed Ham',
			tags: ['holiday', 'dinner'],
			cuisine: 'American',
			servings: 8,
			ingredients: [],
			instructions: [],
			ratings: [],
			history: [],
			status: 'draft',
			createdAt: '2025-01-01T00:00:00.000Z',
			updatedAt: '2025-01-01T00:00:00.000Z',
		});

		sharedStore.read.mockImplementation((path: string) => {
			if (path === 'cultural-calendar.yaml') return Promise.resolve(makeCalendarYaml(makeChristmasCalendar()));
			if (path.startsWith('recipes/') && path.endsWith('.yaml')) return Promise.resolve(recipeYaml);
			return Promise.resolve(null);
		});
		sharedStore.list.mockImplementation((prefix: string) => {
			if (prefix === 'recipes') return Promise.resolve(['recipes/glazed-ham-r1.yaml']);
			return Promise.resolve([]);
		});

		const ctx = { userId: 'user1', text: 'What should I cook for Christmas?' };
		await handleCulturalCalendarMessage(services as unknown as CoreServices, ctx as never);

		const prompt = services.llm.complete.mock.calls[0]![0] as string;
		expect(prompt).toContain('Glazed Ham');
	});
});

// ─── isCulturalCalendarIntent ─────────────────────────────────────────────

describe('isCulturalCalendarIntent', () => {
	it('matches "holiday recipes"', () => {
		expect(isCulturalCalendarIntent('holiday recipes')).toBe(true);
	});

	it('matches "what should I cook for Thanksgiving"', () => {
		expect(isCulturalCalendarIntent('what should I cook for Thanksgiving')).toBe(true);
	});

	it('matches "any upcoming holidays"', () => {
		expect(isCulturalCalendarIntent('any upcoming holidays')).toBe(true);
	});

	it('does not match "host a holiday party"', () => {
		expect(isCulturalCalendarIntent('host a holiday party')).toBe(false);
	});

	it('does not match "what\'s for dinner tonight"', () => {
		expect(isCulturalCalendarIntent("what's for dinner tonight")).toBe(false);
	});

	it('does not match "what should we make for dinner" (meal-planning phrase)', () => {
		expect(isCulturalCalendarIntent('what should we make for dinner')).toBe(false);
	});

	it('does not match "what can I make for lunch"', () => {
		expect(isCulturalCalendarIntent('what can I make for lunch')).toBe(false);
	});

	it('does not match "what am I making for dinner tonight"', () => {
		expect(isCulturalCalendarIntent('what am I making for dinner tonight')).toBe(false);
	});
});
