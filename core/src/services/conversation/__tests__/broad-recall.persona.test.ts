/**
 * Broad-recall persona tests — Chunk D: ConversationRetrievalService wired into handlers.
 *
 * Integration-style tests: ConversationRetrievalService is instantiated with
 * mocked service deps that return seeded data. LLM is stubbed only at the
 * `llm.complete` boundary. Assertions check the system prompt content (what
 * the LLM was called with), not the LLM output.
 *
 * Persona groups:
 *   P1 - Recipe recall: "what's that pasta recipe I saved" / "find my mushroom risotto" / ...
 *   P2 - Grocery state: "what's on my list" / "what do I need from the store" / ...
 *   P3 - Alert/report inventory: "what alerts do I have" / "show me my reports" / ...
 *   P4 - App capability question: "what can the food app do" / ...
 *   P5 - Cross-user denial: user B asks for user A's data → prompt contains ONLY user B data
 *   P6 - Parity: snapshot path ≡ legacy string path for same DataQueryResult
 *
 * Key constraint (DONE_WITH_CONCERNS):
 *   `gatherContext` (app-data.ts) calls contextStore.listForUser independently
 *   of the snapshot. In these tests contextStore.listForUser returns [] by default,
 *   so there is no observable duplication. The real duplication concern (double
 *   I/O in production when both paths hit the same ContextStore) is noted in
 *   open-items.md but not fixed in this chunk.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { AppKnowledgeBaseService } from '../../../types/app-knowledge.js';
import type { AppMetadataService } from '../../../types/app-metadata.js';
import type { AppLogger, CoreServices } from '../../../types/app-module.js';
import type { DataQueryResult, DataQueryService } from '../../../types/data-query.js';
import { CONTEXT_INTERNAL_BYPASS, ContextStoreServiceImpl } from '../../context-store/index.js';
import { requestContext } from '../../context/request-context.js';
import { ConversationRetrievalServiceImpl } from '../../conversation-retrieval/conversation-retrieval-service.js';
import type { AllowedSourceCategory } from '../../conversation-retrieval/source-policy.js';
import { ConversationService } from '../conversation-service.js';
import type { ConversationServiceDeps } from '../conversation-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNullChatSessions() {
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn().mockResolvedValue({ endedSessionId: null }),
		readSession: vi.fn().mockResolvedValue(undefined),
	};
}

/** Wire up ConversationService with a ConversationRetrievalService. */
function makeServiceWithRetrieval(
	services: CoreServices,
	retrieval: ConversationRetrievalServiceImpl,
): ConversationService {
	const deps: ConversationServiceDeps = {
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: 'UTC',
		systemInfo: services.systemInfo,
		appMetadata: services.appMetadata,
		appKnowledge: services.appKnowledge,
		modelJournal: services.modelJournal,
		contextStore: services.contextStore,
		config: services.config,
		dataQuery: services.dataQuery ?? undefined,
		interactionContext: services.interactionContext ?? undefined,
		conversationRetrieval: retrieval,
		chatSessions: makeNullChatSessions() as any,
	};
	return new ConversationService(deps);
}

/** Extract the system prompt from the standard-tier LLM call. */
function getSystemPromptFromLLMCall(services: CoreServices): string {
	const calls = vi.mocked(services.llm.complete).mock.calls;
	const standardCall = calls.find((c) => c[1]?.tier === 'standard');
	return (standardCall?.[1]?.systemPrompt ?? '') as string;
}

function run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
	// Include householdId so ConversationRetrievalService's householdId guard passes
	// for DataQueryService fan-out. Without it, data-query categories are pushed to failures.
	return requestContext.run({ userId, householdId: `hh-${userId}` }, fn);
}

// ---------------------------------------------------------------------------
// P1: Recipe recall — data in snapshot.dataQueryResult
// ---------------------------------------------------------------------------

describe('P1 — recipe recall: snapshot.dataQueryResult surfaces user recipe data', () => {
	let services: CoreServices;
	let retrieval: ConversationRetrievalServiceImpl;

	const RECIPE_RESULT: DataQueryResult = {
		files: [
			{
				path: 'users/alice/food/recipes/pasta.md',
				appId: 'food',
				type: 'recipe',
				title: 'Mushroom Risotto',
				content:
					'## Mushroom Risotto\n\nIngredients: arborio rice, porcini mushrooms, parmesan, white wine.\n\nMethod: toast rice, add stock gradually, fold in mushrooms.',
			},
		],
		empty: false,
	};

	beforeEach(() => {
		services = createMockCoreServices({
			dataQuery: {
				query: vi.fn().mockResolvedValue(RECIPE_RESULT),
			},
		});
		// Enable auto_detect_pas
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });

		retrieval = new ConversationRetrievalServiceImpl({
			dataQuery: services.dataQuery as DataQueryService,
			logger: services.logger as AppLogger,
		});
	});

	it.each([
		"what's that pasta recipe I saved",
		'find my mushroom risotto',
		'remind me how I made the carbonara',
	])('"%s" → classifier YES_DATA → system prompt contains recipe data', async (question) => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES_DATA') // classifier (fast tier)
			.mockResolvedValueOnce('Here is your recipe.');

		const ctx = createTestMessageContext({ userId: 'alice', text: question });
		const svc = makeServiceWithRetrieval(services, retrieval);

		await run('alice', () => svc.handleMessage(ctx));

		const prompt = getSystemPromptFromLLMCall(services);
		expect(prompt).toContain('Mushroom Risotto');
		expect(prompt).toContain('arborio rice');
		expect(prompt).toContain('<memory-context label="recalled-data">');
	});
});

// ---------------------------------------------------------------------------
// P2: Grocery state — data in snapshot.dataQueryResult
// ---------------------------------------------------------------------------

describe('P2 — grocery state: snapshot.dataQueryResult surfaces grocery list', () => {
	let services: CoreServices;
	let retrieval: ConversationRetrievalServiceImpl;

	const GROCERY_RESULT: DataQueryResult = {
		files: [
			{
				path: 'users/alice/food/grocery/list.md',
				appId: 'food',
				type: 'grocery-list',
				title: 'Current Grocery List',
				content:
					'## Active\n- Tomatoes\n- Mozzarella\n- Basil\n- Olive oil\n\n## Archive\n- Eggs (bought)',
			},
		],
		empty: false,
	};

	beforeEach(() => {
		services = createMockCoreServices({
			dataQuery: {
				query: vi.fn().mockResolvedValue(GROCERY_RESULT),
			},
		});
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });

		retrieval = new ConversationRetrievalServiceImpl({
			dataQuery: services.dataQuery as DataQueryService,
			logger: services.logger as AppLogger,
		});
	});

	it.each(["what's on my list", 'what do I need from the store', 'did I add tomatoes'])(
		'"%s" → classifier YES_DATA → system prompt contains grocery list',
		async (question) => {
			vi.mocked(services.llm.complete)
				.mockResolvedValueOnce('YES_DATA')
				.mockResolvedValueOnce("Here's your grocery list.");

			const ctx = createTestMessageContext({ userId: 'alice', text: question });
			const svc = makeServiceWithRetrieval(services, retrieval);

			await run('alice', () => svc.handleMessage(ctx));

			const prompt = getSystemPromptFromLLMCall(services);
			expect(prompt).toContain('Tomatoes');
			expect(prompt).toContain('Current Grocery List');
			expect(prompt).toContain('<memory-context label="recalled-data">');
		},
	);
});

// ---------------------------------------------------------------------------
// P3: Alert/report inventory — data in snapshot.reports + snapshot.alerts
// ---------------------------------------------------------------------------

describe('P3 — alert/report inventory: snapshot surfaces reports and alerts', () => {
	let services: CoreServices;
	let retrieval: ConversationRetrievalServiceImpl;

	const MOCK_REPORTS = [
		{
			id: 'r1',
			name: 'Weekly Food Summary',
			description: 'Summarizes weekly food intake',
			enabled: true,
			schedule: '0 9 * * 1',
			delivery: ['alice'],
			sections: [],
			llm: { enabled: false },
		},
	];

	const MOCK_ALERTS = [
		{
			id: 'a1',
			name: 'Pantry Low Stock',
			enabled: true,
			condition: { type: 'fuzzy' as const, query: 'pantry is running low' },
			actions: [],
			trigger: 'schedule' as const,
			schedule: '0 8 * * *',
		},
	];

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });

		const reportService = { listForUser: vi.fn().mockResolvedValue(MOCK_REPORTS) };
		const alertService = { listForUser: vi.fn().mockResolvedValue(MOCK_ALERTS) };

		retrieval = new ConversationRetrievalServiceImpl({
			reportService,
			alertService,
			logger: services.logger as AppLogger,
		});
	});

	it.each(['what alerts do I have', 'show me my reports', 'what automated tasks are running'])(
		'"%s" → classifier YES → system prompt contains reports + alerts',
		async (question) => {
			vi.mocked(services.llm.complete)
				.mockResolvedValueOnce('YES') // classifier — PAS but not data query
				.mockResolvedValueOnce('Here are your configured items.');

			const ctx = createTestMessageContext({ userId: 'alice', text: question });
			const svc = makeServiceWithRetrieval(services, retrieval);

			await run('alice', () => svc.handleMessage(ctx));

			const prompt = getSystemPromptFromLLMCall(services);
			// Reports and alerts blocks only appear in ask mode or when question mentions
			// reports/alerts/scheduling. The question "what alerts do I have" matches
			// the 'alerts' keyword trigger in chooseSources.
			// For "show me my reports" → matches 'report' keyword.
			// For "what automated tasks are running" → matches scheduling category.
			expect(prompt).toContain('PAS');
			// At least one of the seeded alert or report names must appear — this verifies
			// that reports/alerts content was actually injected into the system prompt,
			// not just that the generic PAS system prompt was rendered.
			const hasAlertContent = prompt.includes('Pantry Low Stock');
			const hasReportContent = prompt.includes('Weekly Food Summary');
			expect(hasAlertContent || hasReportContent).toBe(true);
		},
	);

	it('"what alerts do I have" → reports + alerts section in system prompt', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce('You have 1 alert configured.');

		const ctx = createTestMessageContext({ userId: 'alice', text: 'what alerts do I have' });
		const svc = makeServiceWithRetrieval(services, retrieval);

		await run('alice', () => svc.handleMessage(ctx));

		const prompt = getSystemPromptFromLLMCall(services);
		expect(prompt).toContain('Pantry Low Stock');
		expect(prompt).toContain('configured alerts');
	});

	it('"show me my reports" → reports section in system prompt', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce('You have 1 report configured.');

		const ctx = createTestMessageContext({ userId: 'alice', text: 'show me my reports' });
		const svc = makeServiceWithRetrieval(services, retrieval);

		await run('alice', () => svc.handleMessage(ctx));

		const prompt = getSystemPromptFromLLMCall(services);
		expect(prompt).toContain('Weekly Food Summary');
		expect(prompt).toContain('configured reports');
	});

	it('"what automated tasks are running" triggers alert + report content in prompt', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce('Here are your automated tasks.');

		const ctx = createTestMessageContext({
			userId: 'alice',
			text: 'what automated tasks are running',
		});
		const svc = makeServiceWithRetrieval(services, retrieval);

		await run('alice', () => svc.handleMessage(ctx));

		const prompt = getSystemPromptFromLLMCall(services);
		expect(prompt).toContain('Pantry Low Stock');
		expect(prompt).toContain('Weekly Food Summary');
	});
});

// ---------------------------------------------------------------------------
// P4: App capability question — data in snapshot.enabledApps / snapshot.appKnowledge
// ---------------------------------------------------------------------------

describe('P4 — app capability question: snapshot.enabledApps + appKnowledge in prompt', () => {
	let services: CoreServices;
	let retrieval: ConversationRetrievalServiceImpl;

	const MOCK_APPS = [
		{
			id: 'food',
			name: 'Food',
			description: 'Food tracker, recipe manager, grocery list, and pantry tracking',
			version: '1.0.0',
			commands: [
				{ name: '/food', description: 'Food commands' },
				{ name: '/recipe', description: 'Add a recipe', args: ['title'] },
			],
			intents: ['add recipe', 'grocery list', 'pantry check'],
			hasSchedules: true,
			hasEvents: false,
			acceptsPhotos: true,
		},
	];

	const MOCK_KNOWLEDGE = [
		{
			appId: 'food',
			source: 'food-app-guide.md',
			content:
				'The food app lets you track recipes, manage your grocery list, and monitor pantry stock.',
		},
	];

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });

		const appMetadata = { getEnabledApps: vi.fn().mockResolvedValue(MOCK_APPS) };
		const appKnowledge = { search: vi.fn().mockResolvedValue(MOCK_KNOWLEDGE) };

		retrieval = new ConversationRetrievalServiceImpl({
			appMetadata: appMetadata as AppMetadataService,
			appKnowledge: appKnowledge as AppKnowledgeBaseService,
			logger: services.logger as AppLogger,
		});
	});

	it.each([
		'what can the food app do',
		'remind me how to add a recipe',
		'how does grocery list work',
	])('"%s" → classifier YES → system prompt contains food app capabilities', async (question) => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce('The food app can track recipes and groceries.');

		const ctx = createTestMessageContext({ userId: 'alice', text: question });
		const svc = makeServiceWithRetrieval(services, retrieval);

		await run('alice', () => svc.handleMessage(ctx));

		const prompt = getSystemPromptFromLLMCall(services);
		expect(prompt).toContain('Food');
		expect(prompt).toContain('recipe');
		expect(prompt).toContain('Installed apps');
	});
});

/** Minimal pino-shaped logger stub for ContextStoreServiceImpl. */
function makeStoreLogger(): Logger {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

// ---------------------------------------------------------------------------
// P5: Cross-user denial — real ContextStore with temp dir
// ---------------------------------------------------------------------------

describe('P5 — cross-user denial: user B cannot see user A data in prompt', () => {
	let tempDir: string;
	let contextStore: ContextStoreServiceImpl;
	let retrieval: ConversationRetrievalServiceImpl;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pas-persona-p5-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(tempDir, { recursive: true });

		contextStore = new ContextStoreServiceImpl({ dataDir: tempDir, logger: makeStoreLogger() });

		// Seed Matt's context entry
		await contextStore.save(
			'matt',
			'food-prefs',
			"Matt's grocery list preference: always buy organic",
			CONTEXT_INTERNAL_BYPASS,
		);

		// Seed Bob's context entry
		await contextStore.save(
			'bob',
			'food-prefs',
			"Bob's preference: budget shopping",
			CONTEXT_INTERNAL_BYPASS,
		);

		retrieval = new ConversationRetrievalServiceImpl({
			contextStore,
		});
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("user B's snapshot does NOT contain user A's context data", async () => {
		const services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce("Here is Bob's data.");
		// Also stub contextStore in services (used by gatherContext) to return []
		vi.mocked(services.contextStore.listForUser).mockResolvedValue([]);

		const svc = makeServiceWithRetrieval(services, retrieval);
		const ctx = createTestMessageContext({
			userId: 'bob',
			text: "what's on Matt's grocery list",
		});

		await run('bob', () => svc.handleMessage(ctx));

		const prompt = getSystemPromptFromLLMCall(services);
		// Bob's snapshot only contains Bob's data
		expect(prompt).not.toContain("Matt's grocery list preference");
		// Bob's own data may appear if the snapshot includes it
		// (context-store is selected for all free-text mode queries)
		expect(prompt).not.toContain('always buy organic');
	});

	it("user A's snapshot contains only user A's context entries, not user B's", async () => {
		// Note: context-store entries are not injected into the prompt via snapshot
		// as a dedicated block (buildAppAwareSystemPrompt uses contextEntries from
		// gatherContext for that). This test validates user isolation at the snapshot
		// level — snapshot.contextStore for matt must not include bob's entries.
		const snapshot = await requestContext.run({ userId: 'matt' }, () =>
			retrieval.buildContextSnapshot({
				question: 'what are my food preferences',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);

		const mattEntries = snapshot.contextStore ?? [];
		expect(mattEntries.some((e) => e.content.includes('always buy organic'))).toBe(true);
		expect(mattEntries.some((e) => e.content.includes('budget shopping'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// P6: Parity — snapshot path ≡ legacy string path for same DataQueryResult
// ---------------------------------------------------------------------------

describe('P6 — parity: snapshot.dataQueryResult path is byte-identical to legacy dataContext path', () => {
	it('prompt produced via snapshot matches prompt produced via legacy string path', async () => {
		const { buildAppAwareSystemPrompt } = await import('../prompt-builder.js');
		const { formatDataQueryContext } = await import('../data-query-context.js');

		const RESULT: DataQueryResult = {
			files: [
				{
					path: 'users/alice/food/prices/costco.md',
					appId: 'food',
					type: 'price-list',
					title: 'Costco Prices',
					content: '## Prices\n- Orange $1.99/lb\n- Chicken $3.49/lb',
				},
			],
			empty: false,
		};

		const services = createMockCoreServices();
		vi.mocked(services.appMetadata.getEnabledApps).mockResolvedValue([]);
		vi.mocked(services.appKnowledge.search).mockResolvedValue([]);

		const deps = {
			llm: services.llm,
			logger: services.logger,
			appMetadata: services.appMetadata,
			appKnowledge: services.appKnowledge,
			systemInfo: services.systemInfo,
			data: services.data,
			modelJournal: services.modelJournal,
		};

		const question = 'what are my Costco prices?';
		const userId = 'alice';

		// Legacy path: pass formatted string
		const legacyDataContext = formatDataQueryContext(RESULT);
		const legacyPrompt = await buildAppAwareSystemPrompt(
			question,
			userId,
			[],
			[],
			deps,
			{ modelSlug: 'test-slug', dataContextOrSnapshot: legacyDataContext },
		);

		// Snapshot path: pass snapshot object with dataQueryResult
		const snapshot = {
			dataQueryResult: RESULT,
			failures: [] as AllowedSourceCategory[],
		};
		const snapshotPrompt = await buildAppAwareSystemPrompt(
			question,
			userId,
			[],
			[],
			deps,
			{ modelSlug: 'test-slug', dataContextOrSnapshot: snapshot },
		);

		// The recalled-data block must be byte-identical between both paths
		expect(snapshotPrompt).toContain('Costco Prices');
		expect(legacyPrompt).toContain('Costco Prices');

		// Extract the memory-context block from each prompt for precise comparison
		const extractDataSection = (p: string): string => {
			const start = p.indexOf('<memory-context label="recalled-data">');
			if (start === -1) return '';
			const end = p.indexOf('</memory-context>', start) + '</memory-context>'.length;
			return p.slice(start, end);
		};

		expect(extractDataSection(snapshotPrompt)).toBe(extractDataSection(legacyPrompt));
	});
});

// ---------------------------------------------------------------------------
// P7: /ask mode — ConversationRetrievalService used for /ask handler
// ---------------------------------------------------------------------------

describe('P7 — /ask mode: snapshot wired into handleAsk', () => {
	let services: CoreServices;
	let retrieval: ConversationRetrievalServiceImpl;

	const NOTES_RESULT: DataQueryResult = {
		files: [
			{
				path: 'users/alice/notes/daily/2026-04-27.md',
				appId: 'notes',
				type: 'daily-note',
				title: 'Daily Notes 2026-04-27',
				content: '## Today\n- Meeting with team\n- Reviewed pasta recipe draft\n- Bought tomatoes',
			},
		],
		empty: false,
	};

	beforeEach(() => {
		services = createMockCoreServices({
			dataQuery: {
				query: vi.fn().mockResolvedValue(NOTES_RESULT),
			},
		});

		retrieval = new ConversationRetrievalServiceImpl({
			dataQuery: services.dataQuery as DataQueryService,
			logger: services.logger as AppLogger,
		});
	});

	it.each(['what did I do today', 'show my recent notes', 'what did I work on this week'])(
		'/ask "%s" → YES_DATA → system prompt contains notes content',
		async (question) => {
			vi.mocked(services.llm.complete)
				.mockResolvedValueOnce('YES_DATA') // classifier (fast tier)
				.mockResolvedValueOnce('Here are your recent notes.');

			const ctx = createTestMessageContext({
				userId: 'alice',
				text: `/ask ${question}`,
			});
			const svc = makeServiceWithRetrieval(services, retrieval);

			await run('alice', () => svc.handleAsk(question.split(' '), ctx));

			const prompt = getSystemPromptFromLLMCall(services);
			expect(prompt).toContain('Daily Notes');
			expect(prompt).toContain('pasta recipe draft');
			expect(prompt).toContain('<memory-context label="recalled-data">');
		},
	);
});

// ---------------------------------------------------------------------------
// P8: Graceful degradation — snapshot failure does not break the handler
// ---------------------------------------------------------------------------

describe('P8 — graceful degradation: snapshot failure falls back to plain app-aware prompt', () => {
	it('ConversationRetrievalService.buildContextSnapshot throws → LLM still called, response sent', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce('I can help with that.');

		// Create retrieval service whose buildContextSnapshot always throws
		const badRetrieval = new ConversationRetrievalServiceImpl({});
		// Override the method to simulate a service-level failure
		vi.spyOn(badRetrieval, 'buildContextSnapshot').mockRejectedValue(
			new Error('service unavailable'),
		);

		const svc = makeServiceWithRetrieval(services, badRetrieval);
		const ctx = createTestMessageContext({ userId: 'alice', text: 'what apps do I have' });

		await run('alice', () => svc.handleMessage(ctx));

		// Should not throw; LLM was still called; user got a response
		expect(services.llm.complete).toHaveBeenCalled();
		expect(services.telegram.send).toHaveBeenCalled();
		// Warning was logged
		expect(services.logger.warn).toHaveBeenCalled();
	});
});
