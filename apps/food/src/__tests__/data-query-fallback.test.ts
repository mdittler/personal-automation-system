/**
 * Tests for the D2c gated data query fallback in the food app.
 *
 * Verifies that the fallback correctly gates on recent food context or
 * data-question keywords, calls DataQueryService when appropriate, and
 * falls back to the original help message when nothing matches.
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import type { DataQueryResult } from '@pas/core/types';
import type { InteractionEntry } from '@pas/core/types';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stringify } from 'yaml';
import { handleMessage, init } from '../index.js';
import type { Household } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────

const sampleHousehold: Household = {
	id: 'hh1',
	name: 'Test Household',
	createdBy: 'user1',
	members: ['user1'],
	joinCode: 'ABC123',
	createdAt: '2026-01-01T00:00:00.000Z',
};

function createMockScopedStore(initialData: Record<string, string> = {}) {
	const storage = new Map<string, string>(Object.entries(initialData));
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		append: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(false),
		delete: vi.fn(),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

const nonEmptyResult: DataQueryResult = {
	files: [
		{
			path: 'users/user1/food/recipes/tacos.yaml',
			appId: 'food',
			type: 'recipe',
			title: 'Tacos',
			content: 'ingredients: beef, tortillas\nservings: 4',
		},
	],
	empty: false,
};

const emptyResult: DataQueryResult = { files: [], empty: true };

function makeFoodInteractionEntry(): InteractionEntry {
	return {
		appId: 'food',
		action: 'recipe_saved',
		entityType: 'recipe',
		scope: 'shared',
		timestamp: Date.now(),
		filePaths: ['users/shared/food/recipes/tacos.yaml'],
	};
}

// ─── Helpers ──────────────────────────────────────────────────────

function setupServices(opts: {
	dataQueryResult?: DataQueryResult;
	recentEntries?: InteractionEntry[];
	dataQueryService?: boolean;
	llmAnswer?: string;
} = {}) {
	const sharedStore = createMockScopedStore({
		'household.yaml': stringify(sampleHousehold),
	});

	const services = createMockCoreServices();
	vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	vi.mocked(services.data.forUser).mockReturnValue(createMockScopedStore() as any);

	const mockDataQuery = {
		query: vi.fn().mockResolvedValue(opts.dataQueryResult ?? emptyResult),
	};

	const mockInteractionContext = {
		record: vi.fn(),
		getRecent: vi.fn().mockReturnValue(opts.recentEntries ?? []),
	};

	// LLM: first call returns LLM answer if we want it for formatDataAnswer
	if (opts.llmAnswer !== undefined) {
		vi.mocked(services.llm.complete).mockResolvedValue(opts.llmAnswer);
	}

	(services as any).interactionContext = mockInteractionContext;

	if (opts.dataQueryService !== false) {
		(services as any).dataQuery = mockDataQuery;
	}

	return { services, mockDataQuery, mockInteractionContext };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('food app data query fallback', () => {
	beforeEach(async () => {
		const { services } = setupServices();
		await init(services);
	});

	it('calls DataQueryService when user has recent food interaction', async () => {
		const { services, mockDataQuery } = setupServices({
			dataQueryResult: emptyResult,
			recentEntries: [makeFoodInteractionEntry()],
		});
		await init(services);

		const ctx = createTestMessageContext({
			text: 'something unmatched xyzzy',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(mockDataQuery.query).toHaveBeenCalledWith(
			'something unmatched xyzzy',
			'user1',
			{ recentFilePaths: ['users/shared/food/recipes/tacos.yaml'] },
		);
	});

	it('calls DataQueryService when text contains a data-question keyword', async () => {
		const { services, mockDataQuery } = setupServices({
			dataQueryResult: emptyResult,
			recentEntries: [],
		});
		await init(services);

		// "show me" matches the keyword gate but won't match any food-specific intents
		const ctx = createTestMessageContext({
			text: 'show me that thing I had last time',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(mockDataQuery.query).toHaveBeenCalledWith(
			'show me that thing I had last time',
			'user1',
			undefined,
		);
	});

	it('sends fallback help message without calling DataQueryService when no context or keywords', async () => {
		const { services, mockDataQuery } = setupServices({
			dataQueryResult: emptyResult,
			recentEntries: [],
		});
		await init(services);

		const ctx = createTestMessageContext({
			text: 'xyzzy random nonsense',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(mockDataQuery.query).not.toHaveBeenCalled();
		expect(vi.mocked(services.telegram.send)).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining("I'm not sure what you'd like to do"),
		);
	});

	it('sends fallback help message when DataQueryService returns empty result', async () => {
		const { services } = setupServices({
			dataQueryResult: emptyResult,
			recentEntries: [makeFoodInteractionEntry()],
			llmAnswer: 'some answer',
		});
		await init(services);

		const ctx = createTestMessageContext({
			text: 'something unmatched xyzzy',
			userId: 'user1',
		});

		await handleMessage?.(ctx);

		expect(vi.mocked(services.telegram.send)).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining("I'm not sure what you'd like to do"),
		);
	});

	it('sends data answer when DataQueryService returns results', async () => {
		const { services } = setupServices({
			dataQueryResult: nonEmptyResult,
			recentEntries: [makeFoodInteractionEntry()],
			llmAnswer: 'Your tacos recipe uses beef and tortillas.',
		});
		await init(services);

		const ctx = createTestMessageContext({
			text: 'what is in my tacos recipe?',
			userId: 'user1',
		});

		// "what" is a keyword trigger; also has recent food context
		await handleMessage?.(ctx);

		expect(vi.mocked(services.telegram.send)).toHaveBeenCalledWith(
			'user1',
			'Your tacos recipe uses beef and tortillas.',
		);
	});

	it('does not throw and sends fallback when dataQuery service is not injected', async () => {
		const { services } = setupServices({
			dataQueryService: false,
			recentEntries: [],
		});
		await init(services);

		const ctx = createTestMessageContext({
			text: 'show me something',
			userId: 'user1',
		});

		await expect(handleMessage?.(ctx)).resolves.not.toThrow();
		expect(vi.mocked(services.telegram.send)).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining("I'm not sure what you'd like to do"),
		);
	});
});
