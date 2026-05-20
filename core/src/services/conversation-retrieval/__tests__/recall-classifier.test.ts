/**
 * Tests for recall-classifier.ts (Hermes P5/P6).
 *
 * Covers:
 *  - recallPreFilter: slash-command, greeting, too-short, no-text, /ask bypass, normal pass
 *  - classifyRecallIntent: malformed output table, happy path, LLM error
 */

import { describe, expect, it, vi } from 'vitest';
import {
	RECALL_SAFE_DEFAULT,
	buildClassifierPrompt,
	classifyRecallIntent,
	recallPreFilter,
} from '../recall-classifier.js';

const TODAY = '2026-05-05';

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

function makeDeps(rawResponse: string) {
	return {
		llm: {
			complete: vi.fn().mockResolvedValue(rawResponse),
		},
		logger: { warn: vi.fn() },
		today: TODAY,
	};
}

describe('classifyRecallIntent — malformed output', () => {
	it.each([
		[
			'shouldRecall is string "true" instead of boolean',
			JSON.stringify({ shouldRecall: 'true', query: 'pasta', timeAnchor: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is null',
			JSON.stringify({ shouldRecall: true, query: null, timeAnchor: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is empty string',
			JSON.stringify({ shouldRecall: true, query: '', timeAnchor: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is a number (123)',
			JSON.stringify({ shouldRecall: true, query: 123, timeAnchor: null, reason: 'test' }),
		],
		[
			'shouldRecall=true but query is an array',
			JSON.stringify({ shouldRecall: true, query: ['pasta'], timeAnchor: null, reason: 'test' }),
		],
		['non-JSON response (plain text)', 'just plain text with no JSON'],
		['truncated/invalid JSON', '{"shouldRecall": tr'],
		[
			'query over 200 chars is rejected',
			JSON.stringify({
				shouldRecall: true,
				query: 'a'.repeat(201),
				timeAnchor: null,
				reason: 'too long',
			}),
		],
	])('returns safe default for: %s', async (_label, rawResponse) => {
		const deps = makeDeps(rawResponse);
		const result = await classifyRecallIntent('did we talk about pasta?', deps);
		expect(result.shouldRecall).toBe(false);
		expect(result.query).toBeNull();
	});

	it('tolerates legacy top-level timeWindow field (top-level extras are accepted)', async () => {
		// Old format: has timeWindow but no timeAnchor → timeAnchor is undefined → treated as null (ok)
		// Actually: timeWindow is a top-level extra field (tolerated), and timeAnchor undefined → null
		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'pasta recipe',
			timeWindow: 'recent', // old P5 field — extra top-level field, tolerated
			reason: 'user asked',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('did we talk about pasta?', deps);
		// shouldRecall=true, query is valid, timeAnchor is absent (treated as null) → accepted
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('pasta recipe');
		expect(result.timeAnchor).toBeNull();
	});
});

// ─── classifyRecallIntent — happy path ───────────────────────────────────────

describe('classifyRecallIntent — happy path', () => {
	it('returns correctly parsed verdict with absolute timeAnchor', async () => {
		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'pasta recipe',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'user asked about past',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('what did we say about pasta last Tuesday?', deps);
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('pasta recipe');
		expect(result.timeAnchor).toEqual({ type: 'absolute', on: '2026-04-28' });
		expect(result.reason).toBe('user asked about past');
	});

	it('returns correctly parsed verdict with window timeAnchor', async () => {
		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'budget planning',
			timeAnchor: { type: 'window', after: '2026-04-14', before: '2026-04-22' },
			reason: 'two weeks ago reference',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('two weeks ago we discussed budgets', deps);
		expect(result.shouldRecall).toBe(true);
		expect(result.timeAnchor).toEqual({
			type: 'window',
			after: '2026-04-14',
			before: '2026-04-22',
		});
	});

	it('handles shouldRecall=false correctly (query is null, timeAnchor null)', async () => {
		const raw = JSON.stringify({
			shouldRecall: false,
			query: null,
			timeAnchor: null,
			reason: 'no recall intent detected',
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('what is the weather like?', deps);
		expect(result.shouldRecall).toBe(false);
		expect(result.query).toBeNull();
		expect(result.timeAnchor).toBeNull();
	});

	it('strips markdown code fences before parsing', async () => {
		const raw = `\`\`\`json\n${JSON.stringify({
			shouldRecall: true,
			query: 'exercise routine',
			timeAnchor: null,
			reason: 'past discussion reference',
		})}\n\`\`\``;
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('did we discuss exercise?', deps);
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('exercise routine');
	});

	it('LLM throws → returns safe default without rethrowing', async () => {
		const deps = {
			llm: {
				complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
			},
			logger: { warn: vi.fn() },
			today: TODAY,
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
			timeAnchor: null,
			reason: longReason,
		});
		const deps = makeDeps(raw);
		const result = await classifyRecallIntent('just chatting here ok?', deps);
		expect(result.reason.length).toBeLessThanOrEqual(100);
	});
});

// ─── buildClassifierPrompt — maxWindowDays interpolation ─────────────────────

describe('buildClassifierPrompt — maxWindowDays', () => {
	it('default (no second arg) includes 365 days reference', () => {
		const prompt = buildClassifierPrompt('2026-05-07');
		expect(prompt).toContain('365 days');
	});

	it('custom maxWindowDays=30 interpolates 30 into the prompt', () => {
		const prompt = buildClassifierPrompt('2026-05-07', 30);
		expect(prompt).toContain('30 days');
		expect(prompt).not.toContain('365 days');
	});

	it('custom maxWindowDays=730 interpolates 730 into the prompt', () => {
		const prompt = buildClassifierPrompt('2026-05-07', 730);
		expect(prompt).toContain('730 days');
		expect(prompt).not.toContain('365 days');
	});
});

// ─── classifyRecallIntent — maxWindowDays threading ──────────────────────────

describe('classifyRecallIntent — maxWindowDays threading', () => {
	const TODAY_7 = '2026-05-07';

	it('threads deps.maxWindowDays=30 into parseRecallVerdict — rejects 401-day-old anchor', async () => {
		// 2025-04-01 is 401 days before 2026-05-07; cap=30 → rejected
		const deps = {
			...makeDeps(
				JSON.stringify({
					shouldRecall: true,
					query: 'x',
					timeAnchor: { type: 'absolute', on: '2025-04-01' },
					reason: 'r',
				}),
			),
			today: TODAY_7,
			maxWindowDays: 30,
		};
		const result = await classifyRecallIntent('test', deps);
		expect(result).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('uses default 365 when maxWindowDays is omitted (back-compat)', async () => {
		// 2025-12-01 is 157 days before 2026-05-07; default 365 → accepted
		const deps = {
			...makeDeps(
				JSON.stringify({
					shouldRecall: true,
					query: 'x',
					timeAnchor: { type: 'absolute', on: '2025-12-01' },
					reason: 'r',
				}),
			),
			today: TODAY_7,
		};
		const result = await classifyRecallIntent('test', deps);
		expect(result.shouldRecall).toBe(true);
	});

	it('accepts beyond-365 windows when cap is higher (maxWindowDays=730)', async () => {
		// 2024-08-01 is 645 days before 2026-05-07; cap=730 → accepted
		const deps = {
			...makeDeps(
				JSON.stringify({
					shouldRecall: true,
					query: 'x',
					timeAnchor: { type: 'window', after: '2024-08-01', before: '2026-04-01' },
					reason: 'r',
				}),
			),
			today: TODAY_7,
			maxWindowDays: 730,
		};
		const result = await classifyRecallIntent('test', deps);
		expect(result.shouldRecall).toBe(true);
	});
});

// ─── Batch 2 — responseFormat: 'json' + retry-on-empty ────────────────────────

/** Helper: LLM that returns a queued sequence of responses, one per call. */
function makeQueuedDeps(responses: string[]) {
	let i = 0;
	return {
		llm: {
			complete: vi.fn().mockImplementation(async () => {
				if (i >= responses.length) throw new Error('queuedLLM: exhausted');
				return responses[i++]!;
			}),
		},
		logger: { warn: vi.fn() },
		today: TODAY,
	};
}

describe('classifyRecallIntent — JSON mode + retry-on-empty (Batch 2)', () => {
	it('passes responseFormat: "json" to llm.complete', async () => {
		const deps = makeDeps(
			JSON.stringify({ shouldRecall: false, query: null, timeAnchor: null, reason: 'r' }),
		);
		await classifyRecallIntent('what did we talk about yesterday?', deps);
		const callOptions = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		expect(callOptions).toMatchObject({ responseFormat: 'json' });
	});

	it('retries once with full-context repair when first response is empty', async () => {
		const good = JSON.stringify({
			shouldRecall: true,
			query: 'pasta',
			timeAnchor: null,
			reason: 'recovered on retry',
		});
		const deps = makeQueuedDeps(['', good]);
		const result = await classifyRecallIntent('did we discuss pasta?', deps);

		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('pasta');
		expect(deps.llm.complete).toHaveBeenCalledTimes(2);

		// Retry must include the original user message (Codex correction #5)
		const retryPrompt = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
		expect(retryPrompt).toContain('did we discuss pasta?');
		// responseFormat: 'json' on retry too
		const retryOptions = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[1]?.[1];
		expect(retryOptions).toMatchObject({ responseFormat: 'json' });
	});

	it('hard cap: max 2 LLM calls (empty twice → safe default)', async () => {
		const deps = makeQueuedDeps(['', '']);
		const result = await classifyRecallIntent('did we talk about pasta?', deps);
		expect(result).toEqual(RECALL_SAFE_DEFAULT);
		expect(deps.llm.complete).toHaveBeenCalledTimes(2);
	});

	it('does NOT retry when first call returns valid JSON', async () => {
		const good = JSON.stringify({
			shouldRecall: true,
			query: 'pasta',
			timeAnchor: null,
			reason: 'first-call success',
		});
		const deps = makeDeps(good);
		await classifyRecallIntent('did we discuss pasta?', deps);
		expect(deps.llm.complete).toHaveBeenCalledTimes(1);
	});

	it('does NOT retry on non-empty invalid JSON (only retries on empty output)', async () => {
		// Codex evidence is specifically about empty output from Gemma. Non-empty
		// unparseable output (rare, and any retry would likely produce the same
		// garbage) falls through to safe default without a second call.
		const deps = makeDeps('not valid json at all');
		const result = await classifyRecallIntent('hello', deps);
		expect(result).toEqual(RECALL_SAFE_DEFAULT);
		expect(deps.llm.complete).toHaveBeenCalledTimes(1);
	});
});

// ─── Batch 3 — Vague-temporal prompt-tightening (Chunk C evidence) ────────────

describe('buildClassifierPrompt — vague-temporal guidance (Batch 3)', () => {
	it('prompt explicitly lists vague recall words as NOT time references', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toMatch(/vague recall words.*earlier.*last time.*not time references/i);
	});

	it('prompt contains the "earlier?" negative example with timeAnchor:null', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('what did we say about the leak earlier?');
		// The example must show timeAnchor:null for this phrasing
		expect(prompt).toMatch(/leak[\s\S]{0,200}"timeAnchor":null/);
	});

	it('prompt contains the "last time" negative example with timeAnchor:null', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('what did we decide last time');
		expect(prompt).toMatch(/decision[\s\S]{0,200}"timeAnchor":null/);
	});
});
