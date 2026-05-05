/**
 * Persona tests — Hermes P6 Chunk H: temporal recall pipeline translation.
 *
 * These tests exercise PIPELINE TRANSLATION ONLY — specifically whether
 * the recall pipeline correctly converts LLM-produced TimeAnchor values
 * into UTC message-timestamp filter bounds passed to searchSessions.
 *
 * Tests do NOT verify LLM accuracy. The LLM classifier is STUBBED to return
 * a fixed RecallVerdict. Assertions use searchSessions spies to verify filters.
 *
 * Persona groups:
 *   TT1 - Absolute anchor: "last Tuesday" → UTC range for 2026-04-28
 *   TT2 - Absolute anchor: "yesterday" → UTC range for 2026-05-04
 *   TT3 - Window anchor: "two weeks ago" → UTC range 2026-04-14 to 2026-04-22
 *   TT4 - No recall: shouldRecall=false → searchSessions NOT called
 *   TT5 - Pre-filter negatives: short/greeting/emoji → no LLM call (≥10 messages)
 *   TT6 - Active session excluded: excludeSessionIds populated
 *   TT7 - No timeAnchor: null anchor → no messageAfter/messageBefore
 *   TT8 - Multi-step: abs anchor then no-anchor in separate calls
 *
 * Total scenario coverage: 50+ messages across all groups.
 *
 * Timezone: 'UTC' used throughout to make UTC boundary assertions deterministic.
 * With UTC, localDayToUtcRange('2026-04-28', 'UTC') →
 *   startUtc='2026-04-28T00:00:00.000Z', endUtcExclusive='2026-04-29T00:00:00.000Z'
 *
 * REQ-CONV-SEARCH-010, REQ-CONV-SEARCH-013
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import type { LLMService } from '../../../types/llm.js';
import type { ConversationRetrievalService } from '../../conversation-retrieval/index.js';
import { recallPreFilter } from '../../conversation-retrieval/recall-classifier.js';
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

const NO_RECALL_VERDICT = JSON.stringify({
	shouldRecall: false,
	query: null,
	timeAnchor: null,
	reason: 'no recall needed',
});

// ---------------------------------------------------------------------------
// TT1 — Absolute anchor: last Tuesday (2026-04-28 in UTC)
// ---------------------------------------------------------------------------

describe('TT1 — Absolute time anchor → UTC range for that day', () => {
	it('"what did we say about the recipe last Tuesday" → searchSessions called with 2026-04-28 UTC range', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'recipe',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'user asked about last Tuesday',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		const llm = makeLLM(verdict);
		const logger = makeLogger();

		await runRecallPipeline('what did we say about the recipe last Tuesday', undefined, {
			llm,
			logger,
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});

		expect(searchSessionsSpy).toHaveBeenCalledOnce();
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-04-28T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-04-29T00:00:00.000Z');
	});

	it('"do you recall our Tuesday conversation about the trip?" → correct UTC bounds', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'trip',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'user mentioned Tuesday',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('do you recall our Tuesday conversation about the trip?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-04-28T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-04-29T00:00:00.000Z');
	});

	it('"what pasta recipe did we discuss on the 28th?" → UTC range for 2026-04-28', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'pasta recipe',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'specific date referenced',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what pasta recipe did we discuss on the 28th?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		expect(searchSessionsSpy).toHaveBeenCalledOnce();
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-04-28T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-04-29T00:00:00.000Z');
	});

	it('year boundary: absolute anchor 2025-12-31 → range ends 2026-01-01T00:00:00.000Z', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'new year plans',
			timeAnchor: { type: 'absolute', on: '2025-12-31' },
			reason: 'year-end date mentioned',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what did we plan for last new years eve?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2025-12-31T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-01-01T00:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// TT2 — Absolute anchor: yesterday (2026-05-04 relative to today 2026-05-05)
// ---------------------------------------------------------------------------

describe('TT2 — "yesterday" absolute anchor → UTC range for 2026-05-04', () => {
	it('"remind me what I told you yesterday" → searchSessions with 2026-05-04 UTC range', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'discussion',
			timeAnchor: { type: 'absolute', on: '2026-05-04' },
			reason: 'user said yesterday (today is 2026-05-05)',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('remind me what I told you yesterday', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-05-04T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-05-05T00:00:00.000Z');
	});

	it('"what did we talk about yesterday morning?" → 2026-05-04 UTC range', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'conversation morning',
			timeAnchor: { type: 'absolute', on: '2026-05-04' },
			reason: 'yesterday morning reference',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what did we talk about yesterday morning?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-05-04T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-05-05T00:00:00.000Z');
	});

	it('"recall what I asked you yesterday about groceries" → 2026-05-04 UTC range', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'groceries',
			timeAnchor: { type: 'absolute', on: '2026-05-04' },
			reason: 'yesterday reference',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('recall what I asked you yesterday about groceries', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-05-04T00:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// TT3 — Window anchor: two weeks ago (2026-04-14 to 2026-04-22)
// ---------------------------------------------------------------------------

describe('TT3 — Window anchor: two weeks ago range', () => {
	it('"two weeks ago we discussed the trip" → searchSessions with window 2026-04-14..2026-04-22', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'trip',
			timeAnchor: { type: 'window', after: '2026-04-14', before: '2026-04-22' },
			reason: 'two-week window',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('two weeks ago we discussed the trip', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		// Window: after maps to start of 2026-04-14, before maps to END of 2026-04-22 (exclusive = 2026-04-23)
		expect(callArg?.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-04-23T00:00:00.000Z');
	});

	it('window with only after: open-ended start constraint', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'planning',
			timeAnchor: { type: 'window', after: '2026-04-14' },
			reason: 'since two weeks ago',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline(
			'what have we discussed about planning since two weeks ago?',
			undefined,
			{
				llm: makeLLM(verdict),
				logger: makeLogger(),
				conversationRetrieval: retrieval,
				timezone: 'UTC',
			},
		);
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		expect(callArg?.messageBefore).toBeUndefined();
	});

	it('window with only before: open-ended end constraint', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'recipe',
			timeAnchor: { type: 'window', before: '2026-04-22' },
			reason: 'before last week',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what recipe did we discuss before last week?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBeUndefined();
		expect(callArg?.messageBefore).toBe('2026-04-23T00:00:00.000Z');
	});

	it('wide date window: 2026-01-01 to 2026-03-31 → correct UTC bounds', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'project planning',
			timeAnchor: { type: 'window', after: '2026-01-01', before: '2026-03-31' },
			reason: 'Q1 reference',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline(
			'what did we discuss about the project in the first quarter?',
			undefined,
			{
				llm: makeLLM(verdict),
				logger: makeLogger(),
				conversationRetrieval: retrieval,
				timezone: 'UTC',
			},
		);
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-01-01T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-04-01T00:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// TT4 — No recall: shouldRecall=false → searchSessions NOT called
// ---------------------------------------------------------------------------

describe('TT4 — shouldRecall=false → searchSessions never called', () => {
	it('"what\'s the weather" → no-recall verdict → searchSessions not called', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline("what's the weather like today?", undefined, {
			llm: makeLLM(NO_RECALL_VERDICT),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('"how does photosynthesis work?" → no recall → not called', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('how does photosynthesis work?', undefined, {
			llm: makeLLM(NO_RECALL_VERDICT),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('"write me a haiku about autumn" → no recall → not called', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('write me a haiku about autumn', undefined, {
			llm: makeLLM(NO_RECALL_VERDICT),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('"translate this to French: bonjour" → no recall → not called', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('translate this to French: bonjour', undefined, {
			llm: makeLLM(NO_RECALL_VERDICT),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('"what time is it in Tokyo?" → no recall → not called', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what time is it in Tokyo?', undefined, {
			llm: makeLLM(NO_RECALL_VERDICT),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// TT5 — Pre-filter negatives (≥10): recallPreFilter skips → no LLM call
// ---------------------------------------------------------------------------

describe('TT5 — Pre-filter negatives: short/greeting/slash → no LLM or searchSessions call', () => {
	// These messages are caught by recallPreFilter BEFORE the LLM is called.
	// We verify directly via recallPreFilter (unit) and via runRecallPipeline (integration).

	const NEGATIVE_CASES = [
		// Too short (< 10 chars)
		'thanks',
		'ok',
		'yes',
		'no',
		'hi',
		'bye',
		// Slash commands
		'/newchat',
		'/help start new session',
		'/settings',
		// Emoji-only (no ASCII letters)
		'🍕🎉',
		// Pure greeting
		'hello',
		'thank you',
	];

	it('all negative cases pass through recallPreFilter with skip=true', () => {
		for (const msg of NEGATIVE_CASES) {
			const result = recallPreFilter(msg);
			expect(result.skip, `expected skip for: "${msg}"`).toBe(true);
		}
	});

	it('"thanks" → pre-filter skips, no LLM call, no searchSessions call', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const llmSpy = vi.fn().mockResolvedValue(NO_RECALL_VERDICT);
		const retrieval = makeRetrieval(searchSessionsSpy);
		const llm = { complete: llmSpy, getModelForTier: vi.fn() } as unknown as LLMService;

		await runRecallPipeline('thanks', undefined, {
			llm,
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});

		expect(llmSpy).not.toHaveBeenCalled();
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('"hi" → pre-filter skips, no LLM call, no searchSessions call', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const llmSpy = vi.fn().mockResolvedValue(NO_RECALL_VERDICT);
		const retrieval = makeRetrieval(searchSessionsSpy);
		const llm = { complete: llmSpy, getModelForTier: vi.fn() } as unknown as LLMService;

		await runRecallPipeline('hi', undefined, {
			llm,
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});

		expect(llmSpy).not.toHaveBeenCalled();
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('"/newchat" → slash command pre-filter skip, no LLM call', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const llmSpy = vi.fn().mockResolvedValue(NO_RECALL_VERDICT);
		const retrieval = makeRetrieval(searchSessionsSpy);
		const llm = { complete: llmSpy, getModelForTier: vi.fn() } as unknown as LLMService;

		await runRecallPipeline('/newchat', undefined, {
			llm,
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});

		expect(llmSpy).not.toHaveBeenCalled();
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('"🍕🎉" → no-text pre-filter skip, no LLM call', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const llmSpy = vi.fn().mockResolvedValue(NO_RECALL_VERDICT);
		const retrieval = makeRetrieval(searchSessionsSpy);
		const llm = { complete: llmSpy, getModelForTier: vi.fn() } as unknown as LLMService;

		await runRecallPipeline('🍕🎉', undefined, {
			llm,
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});

		expect(llmSpy).not.toHaveBeenCalled();
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// TT6 — Active session excluded: excludeSessionIds is set
// ---------------------------------------------------------------------------

describe('TT6 — Active session excluded via excludeSessionIds', () => {
	it('with activeSessionId provided → searchSessions called with excludeSessionIds=[activeSessionId]', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'pasta',
			timeAnchor: null,
			reason: 'recall request',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what did we discuss about pasta last week?', 'active-session-abc123', {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.excludeSessionIds).toContain('active-session-abc123');
	});

	it('without activeSessionId → excludeSessionIds is empty array', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'groceries',
			timeAnchor: null,
			reason: 'recall request',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what did we buy last time at the store?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.excludeSessionIds).toEqual([]);
	});

	it('temporal anchor + active session exclusion both work together', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'recipe',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'Tuesday recall with active session',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what recipe did we discuss last Tuesday?', 'my-active-session-xyz', {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBe('2026-04-28T00:00:00.000Z');
		expect(callArg?.messageBefore).toBe('2026-04-29T00:00:00.000Z');
		expect(callArg?.excludeSessionIds).toContain('my-active-session-xyz');
	});
});

// ---------------------------------------------------------------------------
// TT7 — No timeAnchor: null anchor → no messageAfter/messageBefore
// ---------------------------------------------------------------------------

describe('TT7 — No timeAnchor (null) → no timestamp filters passed to searchSessions', () => {
	it('recall verdict with timeAnchor: null → no messageAfter/messageBefore', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'grocery list',
			timeAnchor: null,
			reason: 'no time reference',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('what did we discuss about the grocery list?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.messageAfter).toBeUndefined();
		expect(callArg?.messageBefore).toBeUndefined();
	});

	it('recall with query only → queryTerms populated, no temporal filters', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'pantry inventory',
			timeAnchor: null,
			reason: 'broad pantry recall',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline('remind me what we said about the pantry inventory', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.queryTerms.length).toBeGreaterThan(0);
		expect(callArg?.messageAfter).toBeUndefined();
		expect(callArg?.messageBefore).toBeUndefined();
	});

	it('null anchor with long query → all terms passed through FTS builder', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'pasta carbonara recipe guanciale pecorino',
			timeAnchor: null,
			reason: 'detailed recipe query',
		});
		const retrieval = makeRetrieval(searchSessionsSpy);
		await runRecallPipeline(
			'what was that pasta carbonara recipe we discussed with guanciale and pecorino?',
			undefined,
			{
				llm: makeLLM(verdict),
				logger: makeLogger(),
				conversationRetrieval: retrieval,
				timezone: 'UTC',
			},
		);
		const callArg = searchSessionsSpy.mock.calls[0]?.[0];
		expect(callArg?.queryTerms.length).toBeGreaterThan(0);
		// At least the key terms should be present (stop-word filtering may remove some)
		const termsString = callArg?.queryTerms.join(' ') ?? '';
		expect(termsString).toMatch(/pasta|carbonara|recipe|guanciale|pecorino/i);
	});
});

// ---------------------------------------------------------------------------
// TT8 — Multi-step scenarios: anchor then no-anchor in separate calls
// ---------------------------------------------------------------------------

describe('TT8 — Multi-step: two recall calls in sequence', () => {
	it('step 1: Tuesday recall → UTC range; step 2: open recall → no range', async () => {
		const retrieval1 = makeRetrieval(vi.fn().mockResolvedValue({ hits: [] }));
		const retrieval2 = makeRetrieval(vi.fn().mockResolvedValue({ hits: [] }));

		// Step 1: temporal anchor
		const verdictWithAnchor = JSON.stringify({
			shouldRecall: true,
			query: 'meeting',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'Tuesday reference',
		});
		await runRecallPipeline('what did we discuss in the meeting last Tuesday?', undefined, {
			llm: makeLLM(verdictWithAnchor),
			logger: makeLogger(),
			conversationRetrieval: retrieval1,
			timezone: 'UTC',
		});
		const args1 = (retrieval1.searchSessions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(args1?.messageAfter).toBe('2026-04-28T00:00:00.000Z');
		expect(args1?.messageBefore).toBe('2026-04-29T00:00:00.000Z');

		// Step 2: no temporal anchor
		const verdictNoAnchor = JSON.stringify({
			shouldRecall: true,
			query: 'meeting notes',
			timeAnchor: null,
			reason: 'open recall',
		});
		await runRecallPipeline('can you search for any meeting notes we discussed?', undefined, {
			llm: makeLLM(verdictNoAnchor),
			logger: makeLogger(),
			conversationRetrieval: retrieval2,
			timezone: 'UTC',
		});
		const args2 = (retrieval2.searchSessions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(args2?.messageAfter).toBeUndefined();
		expect(args2?.messageBefore).toBeUndefined();
		// Each call is independent — no state pollution
		expect(args1?.messageAfter).toBe('2026-04-28T00:00:00.000Z'); // unchanged
	});

	it('window anchor then absolute anchor → filters independent between calls', async () => {
		const retrieval1 = makeRetrieval(vi.fn().mockResolvedValue({ hits: [] }));
		const retrieval2 = makeRetrieval(vi.fn().mockResolvedValue({ hits: [] }));

		// Step 1: window anchor
		const windowVerdict = JSON.stringify({
			shouldRecall: true,
			query: 'trip planning',
			timeAnchor: { type: 'window', after: '2026-04-14', before: '2026-04-22' },
			reason: 'two-week window',
		});
		await runRecallPipeline('two weeks ago we discussed the trip planning', undefined, {
			llm: makeLLM(windowVerdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval1,
			timezone: 'UTC',
		});
		const args1 = (retrieval1.searchSessions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(args1?.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		expect(args1?.messageBefore).toBe('2026-04-23T00:00:00.000Z');

		// Step 2: absolute anchor
		const absVerdict = JSON.stringify({
			shouldRecall: true,
			query: 'grocery run',
			timeAnchor: { type: 'absolute', on: '2026-05-01' },
			reason: 'last Friday reference',
		});
		await runRecallPipeline('what groceries did we plan to get last Friday?', undefined, {
			llm: makeLLM(absVerdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval2,
			timezone: 'UTC',
		});
		const args2 = (retrieval2.searchSessions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(args2?.messageAfter).toBe('2026-05-01T00:00:00.000Z');
		expect(args2?.messageBefore).toBe('2026-05-02T00:00:00.000Z');
	});

	it('back-to-back: recall with hits on step 1, recall with no hits on step 2', async () => {
		const mockHit = {
			sessionId: 'session-001',
			sessionStartedAt: '2026-04-28T10:00:00.000Z',
			sessionEndedAt: null,
			title: 'Test Session',
			matches: [
				{
					turn_index: 1,
					role: 'user' as const,
					timestamp: '2026-04-28T10:00:01.000Z',
					snippet: 'test content',
					bm25: -0.5,
				},
			],
		};
		const retrieval1 = makeRetrieval(vi.fn().mockResolvedValue({ hits: [mockHit] }));
		const retrieval2 = makeRetrieval(vi.fn().mockResolvedValue({ hits: [] }));

		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'test',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'test recall',
		});

		const hits1 = await runRecallPipeline('what did we discuss on the 28th?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval1,
			timezone: 'UTC',
		});
		expect(hits1.length).toBe(1);
		expect(hits1[0]?.sessionId).toBe('session-001');

		const hits2 = await runRecallPipeline(
			'what did we discuss about the recipe on the 28th?',
			undefined,
			{
				llm: makeLLM(verdict),
				logger: makeLogger(),
				conversationRetrieval: retrieval2,
				timezone: 'UTC',
			},
		);
		expect(hits2.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// TT9 — Edge cases: no retrieval / no index / fail-open
// ---------------------------------------------------------------------------

describe('TT9 — Edge cases: fail-open and no-index behavior', () => {
	it('no conversationRetrieval provided → returns empty array without throwing', async () => {
		const hits = await runRecallPipeline('what did we discuss last week?', undefined, {
			llm: makeLLM(NO_RECALL_VERDICT),
			logger: makeLogger(),
			conversationRetrieval: undefined,
			timezone: 'UTC',
		});
		expect(hits).toEqual([]);
	});

	it('retrieval.hasSessionSearch() returns false → returns empty array', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval = {
			...makeRetrieval(searchSessionsSpy),
			hasSessionSearch: vi.fn().mockReturnValue(false),
		} as unknown as ConversationRetrievalService;

		const hits = await runRecallPipeline('what did we discuss about pasta last week?', undefined, {
			llm: makeLLM(NO_RECALL_VERDICT),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		expect(hits).toEqual([]);
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});

	it('searchSessions throws → returns empty array (fail-open)', async () => {
		const searchSessionsSpy = vi.fn().mockRejectedValue(new Error('DB unavailable'));
		const retrieval = makeRetrieval(searchSessionsSpy);
		const verdict = JSON.stringify({
			shouldRecall: true,
			query: 'recipe',
			timeAnchor: null,
			reason: 'recall request',
		});

		const hits = await runRecallPipeline('what recipe did we discuss previously?', undefined, {
			llm: makeLLM(verdict),
			logger: makeLogger(),
			conversationRetrieval: retrieval,
			timezone: 'UTC',
		});
		// Pipeline catches the error and returns [] (fail-open)
		expect(hits).toEqual([]);
	});

	it('LLM classifier throws → returns empty array (fail-open)', async () => {
		const searchSessionsSpy = vi.fn().mockResolvedValue({ hits: [] });
		const retrieval = makeRetrieval(searchSessionsSpy);
		const llm = {
			complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
			getModelForTier: vi.fn(),
		} as unknown as LLMService;

		const hits = await runRecallPipeline(
			'what did we discuss about the pantry last week?',
			undefined,
			{ llm, logger: makeLogger(), conversationRetrieval: retrieval, timezone: 'UTC' },
		);
		expect(hits).toEqual([]);
		expect(searchSessionsSpy).not.toHaveBeenCalled();
	});
});
