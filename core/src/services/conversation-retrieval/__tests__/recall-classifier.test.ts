/**
 * Tests for recall-classifier.ts (Hermes P5, Chunk F).
 *
 * Covers:
 *  - recallPreFilter: slash-command, greeting, too-short, no-text, /ask bypass, normal pass
 *  - classifyRecallIntent: malformed output table (8 cases), happy path, LLM error
 */

import { describe, expect, it, vi } from 'vitest';
import {
	classifyRecallIntent,
	recallPreFilter,
} from '../recall-classifier.js';
import type { RecallClassifierDeps } from '../recall-classifier.js';

// ─── Pre-filter tests ─────────────────────────────────────────────────────────

describe('recallPreFilter', () => {
	it('skips /help slash command', () => {
		const result = recallPreFilter('/help');
		expect(result.skip).toBe(true);
		expect(result.reason).toBe('slash-command');
	});

	it('skips /newchat slash command', () => {
		const result = recallPreFilter('/newchat');
		expect(result.skip).toBe(true);
		expect(result.reason).toBe('slash-command');
	});

	it('skips /ask slash command (handle-ask strips the prefix before calling recallPreFilter)', () => {
		// handle-ask.ts strips "/ask " and passes only the question text to recallPreFilter,
		// so recallPreFilter never sees a "/ask " prefix in practice.
		// Any remaining slash command must be skipped.
		const result = recallPreFilter('/ask what did we discuss about pasta');
		expect(result.skip).toBe(true);
		expect(result.reason).toBe('slash-command');
	});

	it('skips bare "hi" (greeting)', () => {
		const result = recallPreFilter('hi');
		// "hi" is 2 chars → too-short fires first
		expect(result.skip).toBe(true);
	});

	it('skips "hello" (greeting, after too-short check — 5 chars is too short)', () => {
		const result = recallPreFilter('hello');
		expect(result.skip).toBe(true);
	});

	it('skips "ok" (too short)', () => {
		const result = recallPreFilter('ok');
		expect(result.skip).toBe(true);
	});

	it('skips "ok thanks" — greeting after stripping punctuation (and length check passes)', () => {
		// "ok thanks" is 9 chars → too-short (< 10)
		const result = recallPreFilter('ok thanks');
		expect(result.skip).toBe(true);
	});

	it('skips "thanks!" — greeting after stripping punctuation', () => {
		// "thanks!" → stripped = "thanks", length is 7 chars < 10 → too-short
		const result = recallPreFilter('thanks!');
		expect(result.skip).toBe(true);
	});

	it('skips single emoji 👋 (short → too-short fires before no-text check)', () => {
		const result = recallPreFilter('👋');
		expect(result.skip).toBe(true);
		// Length check fires before the ASCII-only check (emoji is short)
		expect(result.reason).toBe('too-short');
	});

	it('skips emoji sequence with no ASCII letters (short → too-short fires first)', () => {
		const result = recallPreFilter('🎉🎊🎈');
		expect(result.skip).toBe(true);
		// The length of emoji sequences < 10 triggers too-short before no-text
		expect(result.reason).toBe('too-short');
	});

	it('skips a longer emoji-only message (no-text check fires after length check passes)', () => {
		// 10+ emoji chars (each emoji is 2 UTF-16 code units), total .length >= 10
		// so the length check passes and the no-text check fires
		const result = recallPreFilter('🎉🎊🎈🎁🎀🎂🎃🎄🎅🎆');
		expect(result.skip).toBe(true);
		expect(result.reason).toBe('no-text');
	});

	it('skips message shorter than 10 chars', () => {
		const result = recallPreFilter('short');
		expect(result.skip).toBe(true);
		expect(result.reason).toBe('too-short');
	});

	it('does NOT skip a normal question', () => {
		const result = recallPreFilter('What is the weather like today in Seattle?');
		expect(result.skip).toBe(false);
		expect(result.reason).toBe('proceed');
	});

	it('does NOT skip a recall question', () => {
		const result = recallPreFilter('Did we talk about the pasta recipe last week?');
		expect(result.skip).toBe(false);
		expect(result.reason).toBe('proceed');
	});

	it('skips empty string (too-short)', () => {
		const result = recallPreFilter('');
		expect(result.skip).toBe(true);
		expect(result.reason).toBe('too-short');
	});
});

// ─── classifyRecallIntent — malformed output table ────────────────────────────

function makeDeps(rawResponse: string): RecallClassifierDeps {
	return {
		llm: {
			// LLMService.complete returns Promise<string> (not { content: string })
			complete: vi.fn().mockResolvedValue(rawResponse),
		},
		logger: { warn: vi.fn() },
	};
}

describe('classifyRecallIntent — malformed output', () => {
	it.each([
		[
			'shouldRecall is string "true" instead of boolean',
			JSON.stringify({ shouldRecall: 'true', query: 'pasta', timeWindow: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is null',
			JSON.stringify({ shouldRecall: true, query: null, timeWindow: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is empty string',
			JSON.stringify({ shouldRecall: true, query: '', timeWindow: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is a number (123)',
			JSON.stringify({ shouldRecall: true, query: 123, timeWindow: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is an array',
			JSON.stringify({ shouldRecall: true, query: ['pasta'], timeWindow: null, reason: 'test' }),
		],
		[
			'non-JSON response (plain text)',
			'just plain text with no JSON',
		],
		[
			'truncated/invalid JSON',
			'{"shouldRecall": tr',
		],
		[
			'query over 200 chars is rejected',
			JSON.stringify({ shouldRecall: true, query: 'a'.repeat(201), timeWindow: null, reason: 'too long' }),
		],
	])('returns safe default for: %s', async (_label, rawResponse) => {
		const deps = makeDeps(rawResponse);
		const result = await classifyRecallIntent('did we talk about pasta?', deps);
		expect(result.shouldRecall).toBe(false);
		expect(result.query).toBeNull();
	});

	it('coerces invalid timeWindow to null but returns valid result when shouldRecall=true and query is valid', async () => {
		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'pasta recipe',
			timeWindow: 'unknown',
			reason: 'user asked',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('did we talk about pasta?', deps);
		// shouldRecall=true, query is valid → result is NOT the safe default
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('pasta recipe');
		// timeWindow 'unknown' is coerced to null
		expect(result.timeWindow).toBeNull();
	});
});

// ─── classifyRecallIntent — happy path ───────────────────────────────────────

describe('classifyRecallIntent — happy path', () => {
	it('returns correctly parsed verdict for valid JSON', async () => {
		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'pasta recipe',
			timeWindow: 'recent',
			reason: 'user asked about past',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('did we talk about pasta recently?', deps);
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('pasta recipe');
		expect(result.timeWindow).toBe('recent');
		expect(result.reason).toBe('user asked about past');
	});

	it('handles timeWindow "older" correctly', async () => {
		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'budget planning',
			timeWindow: 'older',
			reason: 'reference to past discussion',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('months ago we discussed budgets', deps);
		expect(result.shouldRecall).toBe(true);
		expect(result.timeWindow).toBe('older');
	});

	it('handles shouldRecall=false correctly (query is null)', async () => {
		const raw = JSON.stringify({
			shouldRecall: false,
			query: null,
			timeWindow: null,
			reason: 'no recall intent detected',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('what is the weather like?', deps);
		expect(result.shouldRecall).toBe(false);
		expect(result.query).toBeNull();
		expect(result.timeWindow).toBeNull();
	});

	it('strips markdown code fences before parsing', async () => {
		const raw = '```json\n' + JSON.stringify({
			shouldRecall: true,
			query: 'exercise routine',
			timeWindow: 'recent',
			reason: 'past discussion reference',
		}) + '\n```';
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('did we discuss exercise?', deps);
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('exercise routine');
	});

	it('LLM throws → returns safe default without rethrowing', async () => {
		const deps: RecallClassifierDeps = {
			llm: {
				complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
			},
			logger: { warn: vi.fn() },
		};
		const result = await classifyRecallIntent('what did we say about sleep?', deps);
		expect(result.shouldRecall).toBe(false);
		expect(result.query).toBeNull();
		expect(result.reason).toBe('llm-error');
		// Should NOT have thrown
	});

	it('truncates reason to 100 chars', async () => {
		const longReason = 'x'.repeat(200);
		const raw = JSON.stringify({
			shouldRecall: false,
			query: null,
			timeWindow: null,
			reason: longReason,
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('just chatting here ok?', deps);
		expect(result.reason.length).toBeLessThanOrEqual(100);
	});
});
