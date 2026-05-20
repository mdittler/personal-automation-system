/**
 * Persona tests — Hermes P6.next: NL temporal pipeline translation.
 *
 * SECONDARY coverage. These tests verify PIPELINE TRANSLATION only:
 * given a TimeAnchor produced by the classifier (stubbed LLM), does
 * timeAnchorToFilters produce the correct UTC bounds?
 *
 * The LLM is stubbed in all cases. These tests do NOT verify that the
 * LLM correctly interprets "last Friday" as an absolute anchor — that
 * is the role of manual evidence (non-deterministic, not a CI gate).
 *
 * Frozen clock: vi.useFakeTimers().setSystemTime('2026-05-05T12:00:00Z')
 * (Tuesday) for multi-step tests that call runRecallPipeline with real today computation.
 *
 * Persona groups:
 *   TT-NL1 — Absolute anchor (3 scenarios): LLM stub returns absolute anchor → UTC range
 *   TT-NL2 — Window anchor (3 scenarios): LLM stub returns window anchor → bounded UTC range
 *   TT-NL3 — Null anchor (3 scenarios): null anchor → no filters
 *   TT-NL4 — Pre-filter negatives (≥10): short/greeting/emoji/slash → no LLM call
 *   TT-NL5 — Multi-step (3 scenarios): two consecutive queries → independent anchors
 *
 * Total: ≥15 unique scenarios + ≥10 negatives.
 *
 * Timezone: 'UTC' for deterministic assertions; one 'America/New_York' scenario.
 *
 * REQ-CONV-TEMPORAL-007..012 (pipeline-translation surface only)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import type { LLMService } from '../../../types/llm.js';
import type { ConversationRetrievalService } from '../../conversation-retrieval/index.js';
import { recallPreFilter } from '../../conversation-retrieval/recall-classifier.js';
import { timeAnchorToFilters } from '../recall-pipeline.js';
import { runRecallPipeline } from '../recall-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): AppLogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(),
	} as unknown as AppLogger;
}

function makeLLM(verdictJson: string): LLMService {
	return {
		complete: vi.fn().mockResolvedValue(verdictJson),
		getModelForTier: vi.fn().mockReturnValue('claude-haiku'),
	} as unknown as LLMService;
}

function makeRetrieval(searchSessionsSpy: ReturnType<typeof vi.fn>): ConversationRetrievalService {
	return {
		hasSessionSearch: vi.fn().mockReturnValue(true),
		searchSessions: searchSessionsSpy,
		buildMemorySnapshot: vi.fn(),
		buildContextSnapshot: vi.fn(),
		listContextEntries: vi.fn(),
		getRecentInteractions: vi.fn(),
		getEnabledApps: vi.fn(),
		searchAppKnowledge: vi.fn(),
		buildSystemDataBlock: vi.fn(),
		listScopedReports: vi.fn(),
		listScopedAlerts: vi.fn(),
		searchData: vi.fn(),
	} as unknown as ConversationRetrievalService;
}

function absoluteVerdict(on: string, query = 'topic'): string {
	return JSON.stringify({
		shouldRecall: true,
		query,
		timeAnchor: { type: 'absolute', on },
		reason: 'test stub',
	});
}

function windowVerdict(
	after: string | undefined,
	before: string | undefined,
	query = 'topic',
): string {
	const timeAnchor: Record<string, unknown> = { type: 'window' };
	if (after !== undefined) timeAnchor.after = after;
	if (before !== undefined) timeAnchor.before = before;
	return JSON.stringify({ shouldRecall: true, query, timeAnchor, reason: 'test stub' });
}

function noRecallVerdict(): string {
	return JSON.stringify({
		shouldRecall: false,
		query: null,
		timeAnchor: null,
		reason: 'no recall needed',
	});
}

// ---------------------------------------------------------------------------
// TT-NL1 — Absolute anchor: NL phrase → exact-day UTC range
// ---------------------------------------------------------------------------

describe('TT-NL1 — Absolute anchor → exact-day UTC range (tz=UTC)', () => {
	it('"what did we discuss last Friday" — anchor on 2026-05-01 → UTC range for that day', async () => {
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		await runRecallPipeline('what did we discuss last Friday', undefined, {
			llm: makeLLM(absoluteVerdict('2026-05-01', 'discuss')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy),
			timezone: 'UTC',
		});
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBe('2026-05-01T00:00:00.000Z');
		expect(arg?.messageBefore).toBe('2026-05-02T00:00:00.000Z');
	});

	it('"remind me of the conversation the day before yesterday" — anchor on 2026-05-03 → correct UTC range', async () => {
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		await runRecallPipeline('remind me of the conversation the day before yesterday', undefined, {
			llm: makeLLM(absoluteVerdict('2026-05-03', 'conversation')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy),
			timezone: 'UTC',
		});
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBe('2026-05-03T00:00:00.000Z');
		expect(arg?.messageBefore).toBe('2026-05-04T00:00:00.000Z');
	});

	it('"what did we talk about last weekend, specifically Saturday" — anchor on 2026-05-02 → UTC range with tz=America/New_York', async () => {
		// May 2, 2026 in EDT (UTC-4): midnight EDT = 04:00Z
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		await runRecallPipeline(
			'what did we talk about last weekend, specifically Saturday',
			undefined,
			{
				llm: makeLLM(absoluteVerdict('2026-05-02', 'weekend')),
				logger: makeLogger(),
				conversationRetrieval: makeRetrieval(spy),
				timezone: 'America/New_York',
			},
		);
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBe('2026-05-02T04:00:00.000Z');
		expect(arg?.messageBefore).toBe('2026-05-03T04:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// TT-NL2 — Window anchor: NL phrase → bounded UTC range
// ---------------------------------------------------------------------------

describe('TT-NL2 — Window anchor → bounded UTC range (tz=UTC)', () => {
	it('"earlier this month we discussed the budget" — window 2026-05-01 to 2026-05-05 → correct UTC bounds', async () => {
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		await runRecallPipeline('earlier this month we discussed the budget', undefined, {
			llm: makeLLM(windowVerdict('2026-05-01', '2026-05-05', 'budget')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy),
			timezone: 'UTC',
		});
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBe('2026-05-01T00:00:00.000Z');
		expect(arg?.messageBefore).toBe('2026-05-06T00:00:00.000Z');
	});

	it('"a couple weeks ago we talked about the trip" — window 2026-04-14 to 2026-04-28 → correct UTC bounds', async () => {
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		await runRecallPipeline('a couple weeks ago we talked about the trip', undefined, {
			llm: makeLLM(windowVerdict('2026-04-14', '2026-04-28', 'trip')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy),
			timezone: 'UTC',
		});
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		expect(arg?.messageBefore).toBe('2026-04-29T00:00:00.000Z');
	});

	it('"during March we planned the holiday" — window 2026-03-01 to 2026-03-31 → correct UTC bounds', async () => {
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		await runRecallPipeline('during March we planned the holiday', undefined, {
			llm: makeLLM(windowVerdict('2026-03-01', '2026-03-31', 'holiday')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy),
			timezone: 'UTC',
		});
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBe('2026-03-01T00:00:00.000Z');
		expect(arg?.messageBefore).toBe('2026-04-01T00:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// TT-NL3 — Null anchor: no time filter in query
// ---------------------------------------------------------------------------

describe('TT-NL3 — Null anchor → no messageAfter / messageBefore', () => {
	it('"what did we talk about the recipe?" — null anchor → no date filters', async () => {
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'recipe',
			timeAnchor: null,
			reason: 'no time reference',
		});
		await runRecallPipeline('what did we talk about the recipe?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy),
			timezone: 'UTC',
		});
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBeUndefined();
		expect(arg?.messageBefore).toBeUndefined();
	});

	it('timeAnchorToFilters(null, "UTC") returns empty object', () => {
		expect(timeAnchorToFilters(null, 'UTC')).toEqual({});
	});

	it('"do you remember when we discussed budgets" — null anchor → searchSessions called without date filters', async () => {
		const spy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'budgets',
			timeAnchor: null,
			reason: 'vague time reference',
		});
		await runRecallPipeline('do you remember when we discussed budgets', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy),
			timezone: 'UTC',
		});
		const arg = spy.mock.calls[0]?.[0];
		expect(arg?.messageAfter).toBeUndefined();
		expect(arg?.messageBefore).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// TT-NL4 — Pre-filter negatives: messages that bypass recall entirely (≥10)
// ---------------------------------------------------------------------------

describe('TT-NL4 — Pre-filter negatives: recall pre-filter skips these (≥10)', () => {
	const NEGATIVES = [
		// Too short
		'hi',
		'ok',
		'yes',
		'no',
		'bye',
		// Greeting (after length check)
		'hello',
		'thanks',
		'thank you',
		// Slash commands
		'/help',
		'/newchat',
		'/recall',
		'/ask',
		// Emoji/sticker only
		'🍕',
		'👍',
		'😂',
		// No ASCII letters
		'123456789012345',
	];

	for (const msg of NEGATIVES) {
		it(`recallPreFilter skips: "${msg.slice(0, 30)}"`, () => {
			const result = recallPreFilter(msg);
			expect(result.skip).toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// TT-NL5 — Multi-step: two consecutive NL recall queries are independent
// ---------------------------------------------------------------------------

describe('TT-NL5 — Multi-step: consecutive NL queries produce independent anchors', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('first query with absolute anchor, second with null anchor — second has no date filters', async () => {
		const spy1 = vi.fn().mockResolvedValue({ hits: [] });
		const spy2 = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval1 = makeRetrieval(spy1);
		const retrieval2 = makeRetrieval(spy2);

		// First query: absolute anchor
		await runRecallPipeline('what did we say last Friday about the trip', undefined, {
			llm: makeLLM(absoluteVerdict('2026-05-01', 'trip')),
			logger: makeLogger(),
			conversationRetrieval: retrieval1,
			timezone: 'UTC',
		});

		// Second query: null anchor (different LLM verdict)
		await runRecallPipeline('what did we discuss about the recipe', undefined, {
			llm: makeLLM(
				JSON.stringify({
					shouldRecall: true,
					query: 'recipe',
					timeAnchor: null,
					reason: 'no time reference',
				}),
			),
			logger: makeLogger(),
			conversationRetrieval: retrieval2,
			timezone: 'UTC',
		});

		// First call has date filters
		const arg1 = spy1.mock.calls[0]?.[0];
		expect(arg1?.messageAfter).toBe('2026-05-01T00:00:00.000Z');
		expect(arg1?.messageBefore).toBe('2026-05-02T00:00:00.000Z');

		// Second call has NO date filters (no carryover from first query)
		const arg2 = spy2.mock.calls[0]?.[0];
		expect(arg2?.messageAfter).toBeUndefined();
		expect(arg2?.messageBefore).toBeUndefined();
	});

	it('first query with window anchor, second with different window — filters are independent', async () => {
		const spy1 = vi.fn().mockResolvedValue({ hits: [] });
		const spy2 = vi.fn().mockResolvedValue({ hits: [] });

		await runRecallPipeline('earlier this month we talked about the budget', undefined, {
			llm: makeLLM(windowVerdict('2026-05-01', '2026-05-05', 'budget')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy1),
			timezone: 'UTC',
		});

		await runRecallPipeline('a couple weeks ago we discussed the project', undefined, {
			llm: makeLLM(windowVerdict('2026-04-14', '2026-04-28', 'project')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy2),
			timezone: 'UTC',
		});

		const arg1 = spy1.mock.calls[0]?.[0];
		expect(arg1?.messageAfter).toBe('2026-05-01T00:00:00.000Z');
		expect(arg1?.messageBefore).toBe('2026-05-06T00:00:00.000Z');

		const arg2 = spy2.mock.calls[0]?.[0];
		expect(arg2?.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		expect(arg2?.messageBefore).toBe('2026-04-29T00:00:00.000Z');
	});

	it('two queries with same phrase but different stubbed anchors — each uses its own stub result', async () => {
		const spy1 = vi.fn().mockResolvedValue({ hits: [] });
		const spy2 = vi.fn().mockResolvedValue({ hits: [] });

		// Same message, but each pipeline call has its own LLM stub returning a different anchor
		const phrase = 'what did we say about last Friday';

		await runRecallPipeline(phrase, undefined, {
			llm: makeLLM(absoluteVerdict('2026-05-01', 'friday1')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy1),
			timezone: 'UTC',
		});

		await runRecallPipeline(phrase, undefined, {
			llm: makeLLM(absoluteVerdict('2026-04-30', 'friday2')),
			logger: makeLogger(),
			conversationRetrieval: makeRetrieval(spy2),
			timezone: 'UTC',
		});

		const arg1 = spy1.mock.calls[0]?.[0];
		expect(arg1?.messageAfter).toBe('2026-05-01T00:00:00.000Z');

		const arg2 = spy2.mock.calls[0]?.[0];
		expect(arg2?.messageAfter).toBe('2026-04-30T00:00:00.000Z');
	});
});
