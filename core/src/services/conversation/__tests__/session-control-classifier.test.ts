/**
 * Tests for session-control-classifier.ts.
 *
 * Covers:
 *  - preFilterSessionControl: exact keyword, command keyword, phrase containing keyword,
 *    non-keyword, case-insensitivity
 *  - detectSessionControl: prefilter short-circuits LLM; LLM called for non-keyword message
 *  - classifySessionControl: parse error, markdown fence stripping, invalid intent value
 */

import { describe, expect, it, vi } from 'vitest';
import { withCompleteWithMeta } from '../../../testing/llm-meta-stub.js';
import type { LLMFinishReason } from '../../../types/llm.js';
import {
	classifySessionControl,
	detectSessionControl,
	preFilterSessionControl,
} from '../session-control-classifier.js';
import type { SessionControlClassifierDeps } from '../session-control-classifier.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDeps(
	rawResponse: string,
	finishReason: LLMFinishReason = 'stop',
): SessionControlClassifierDeps & {
	llm: { complete: ReturnType<typeof vi.fn> };
	logger: { warn: ReturnType<typeof vi.fn> };
} {
	return {
		llm: withCompleteWithMeta(
			{
				complete: vi.fn().mockResolvedValue(rawResponse),
			},
			finishReason,
		),
		logger: { warn: vi.fn() },
	};
}

function makeThrowingDeps(): SessionControlClassifierDeps {
	return {
		llm: withCompleteWithMeta({
			complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
		}),
		logger: { warn: vi.fn() },
	};
}

// ─── preFilterSessionControl ─────────────────────────────────────────────────

describe('preFilterSessionControl', () => {
	it('returns matched for "/newchat" command (exact equality)', () => {
		const result = preFilterSessionControl('/newchat');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.confidence).toBe(1.0);
			expect(result.reason).toContain('/newchat');
		}
	});

	it('returns matched for "/new" command (exact equality)', () => {
		const result = preFilterSessionControl('/new');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.reason).toContain('/new');
		}
	});

	it('returns matched for "/reset" command (exact equality)', () => {
		const result = preFilterSessionControl('/reset');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.reason).toContain('/reset');
		}
	});

	it('is case-insensitive for commands ("/NEWCHAT" matches)', () => {
		const result = preFilterSessionControl('/NEWCHAT');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.reason).toContain('/newchat');
		}
	});

	// NL phrases are NO LONGER matched by the prefilter (they go to LLM)
	it('returns not-matched for NL phrase "new chat" (NL phrases go to LLM)', () => {
		const result = preFilterSessionControl('new chat');
		expect(result.matched).toBe(false);
	});

	it('returns not-matched for phrase containing keyword ("I want to start fresh please")', () => {
		const result = preFilterSessionControl('I want to start fresh please');
		expect(result.matched).toBe(false);
	});

	it('returns not-matched for "NEW CHAT" (NL phrase, even uppercased)', () => {
		const result = preFilterSessionControl('NEW CHAT');
		expect(result.matched).toBe(false);
	});

	it('returns not-matched for a regular message ("what\'s the weather today")', () => {
		const result = preFilterSessionControl("what's the weather today");
		expect(result.matched).toBe(false);
	});

	it.each([['clear chat'], ['forget everything'], ['reset conversation']])(
		'returns not-matched for NL phrase "%s" (handled by LLM classifier)',
		(phrase) => {
			const result = preFilterSessionControl(phrase);
			expect(result.matched).toBe(false);
		},
	);

	// Safety: negations and meta-questions must NOT match
	it('returns not-matched for "don\'t start over"', () => {
		expect(preFilterSessionControl("don't start over").matched).toBe(false);
	});

	// Batch 3: this used to be a "no-match → goes to LLM" case. Now the
	// meta-question prefilter catches it and returns intent:'continue'. Old
	// LLM-pathing behavior preserved for non-meta NL phrases (see "new chat"
	// case above).
	it('matches "what does /new do?" as a meta-question (Batch 3 — was previously unmatched)', () => {
		const result = preFilterSessionControl('what does /new do?');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.intent).toBe('continue');
		}
	});
});

// ─── detectSessionControl ────────────────────────────────────────────────────

describe('detectSessionControl', () => {
	it('returns source:"prefilter" for exact command match (/newchat) and never calls LLM', async () => {
		const deps = makeDeps('{"intent":"new_session","confidence":0.9,"reason":"llm says yes"}');
		const result = await detectSessionControl('/newchat', deps);
		expect(result.source).toBe('prefilter');
		expect(result.intent).toBe('new_session');
		expect(result.confidence).toBe(1.0);
		expect(result.reason).toMatch(/command/);
		// LLM should never have been called
		expect(deps.llm.complete).not.toHaveBeenCalled();
	});

	it('calls LLM for NL phrase "lets start over" (no longer a prefilter match)', async () => {
		const deps = makeDeps('{"intent":"new_session","confidence":0.9,"reason":"llm says yes"}');
		const result = await detectSessionControl('lets start over', deps);
		// NL phrases go to LLM; source is 'llm'
		expect(result.source).toBe('llm');
		expect(deps.llm.complete).toHaveBeenCalledOnce();
	});

	it('calls LLM for non-keyword message and returns source:"llm"', async () => {
		const deps = makeDeps(
			JSON.stringify({ intent: 'continue', confidence: 0.95, reason: 'normal message' }),
		);
		const result = await detectSessionControl('what is the capital of France?', deps);
		expect(result.source).toBe('llm');
		expect(deps.llm.complete).toHaveBeenCalledOnce();
	});
});

// ─── classifySessionControl ──────────────────────────────────────────────────

describe('classifySessionControl', () => {
	it('handles LLM parse error gracefully (returns unclear/0/parse-error)', async () => {
		const deps = makeDeps('this is not json at all');
		const result = await classifySessionControl('whatever', deps);
		expect(result.intent).toBe('unclear');
		expect(result.confidence).toBe(0);
		expect(result.reason).toBe('parse error');
		expect(result.source).toBe('llm');
	});

	it('strips markdown fences from LLM response before parsing', async () => {
		const payload = JSON.stringify({
			intent: 'new_session',
			confidence: 0.88,
			reason: 'user wants fresh start',
		});
		const fenced = `\`\`\`json\n${payload}\n\`\`\``;
		const deps = makeDeps(fenced);
		const result = await classifySessionControl('can we begin again?', deps);
		expect(result.intent).toBe('new_session');
		expect(result.confidence).toBe(0.88);
		expect(result.source).toBe('llm');
	});

	it('handles invalid intent value gracefully (returns parse-error default)', async () => {
		const deps = makeDeps(
			JSON.stringify({ intent: 'reset_please', confidence: 0.9, reason: 'bad intent' }),
		);
		const result = await classifySessionControl('something', deps);
		expect(result.intent).toBe('unclear');
		expect(result.confidence).toBe(0);
		expect(result.reason).toBe('parse error');
	});

	it('returns LLM error default when LLM throws', async () => {
		const deps = makeThrowingDeps();
		const result = await classifySessionControl('let me think', deps);
		expect(result.intent).toBe('unclear');
		expect(result.confidence).toBe(0);
		expect(result.source).toBe('llm');
		expect(result.reason).toBe('parse error');
	});

	it('returns safeDefault for confidence below 0', async () => {
		const deps = makeDeps(JSON.stringify({ intent: 'continue', confidence: -0.1, reason: 'bad' }));
		const result = await classifySessionControl('something', deps);
		expect(result.intent).toBe('unclear');
		expect(result.confidence).toBe(0);
		expect(result.source).toBe('llm');
		expect(result.reason).toBe('parse error');
	});

	it('returns safeDefault for confidence above 1', async () => {
		const deps = makeDeps(
			JSON.stringify({ intent: 'new_session', confidence: 1.1, reason: 'too high' }),
		);
		const result = await classifySessionControl('something', deps);
		expect(result.intent).toBe('unclear');
		expect(result.confidence).toBe(0);
		expect(result.source).toBe('llm');
		expect(result.reason).toBe('parse error');
	});

	it('returns safeDefault when confidence is a string instead of number', async () => {
		const deps = makeDeps(
			JSON.stringify({ intent: 'new_session', confidence: '0.9', reason: 'string type' }),
		);
		const result = await classifySessionControl('something', deps);
		expect(result.intent).toBe('unclear');
		expect(result.confidence).toBe(0);
		expect(result.source).toBe('llm');
		expect(result.reason).toBe('parse error');
	});
});

// ─── Batch 3 — Meta-question prefilter ────────────────────────────────────────
// Evidence: chunk-c verification showed "what does /newchat do?" classified as
// `new_session` by Gemma 4 e4b. Deterministic prefilter shortcuts the LLM for
// these meta-questions.

describe('preFilterSessionControl — meta-question short-circuit (Batch 3)', () => {
	it('matches "what does /newchat do?" → intent: continue', () => {
		const result = preFilterSessionControl('what does /newchat do?');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.intent).toBe('continue');
			expect(result.reason).toMatch(/meta/i);
		}
	});

	it('matches "what is /reset" → intent: continue', () => {
		const result = preFilterSessionControl('what is /reset');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.intent).toBe('continue');
		}
	});

	it('matches "what do /new commands do?" → intent: continue', () => {
		const result = preFilterSessionControl('what do /new commands do?');
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.intent).toBe('continue');
		}
	});

	it('does NOT match plain "new chat" (no meta-pattern, goes to LLM)', () => {
		const result = preFilterSessionControl('new chat');
		expect(result.matched).toBe(false);
	});

	it('does NOT match the bare command "/newchat" (preserves new_session semantics)', () => {
		const result = preFilterSessionControl('/newchat');
		expect(result.matched).toBe(true);
		if (result.matched) {
			// Existing semantics: bare command → new_session (intent omitted → defaulted in detectSessionControl)
			expect(result.intent === undefined || result.intent === 'new_session').toBe(true);
		}
	});
});

describe('detectSessionControl — meta-question avoids LLM call (Batch 3)', () => {
	it('"what does /newchat do?" returns continue WITHOUT calling LLM', async () => {
		const deps = makeDeps('this should never be returned');
		const result = await detectSessionControl('what does /newchat do?', deps);
		expect(result.intent).toBe('continue');
		expect(result.source).toBe('prefilter');
		expect(deps.llm.complete).not.toHaveBeenCalled();
	});

	it('"what does /reset do?" returns continue WITHOUT calling LLM', async () => {
		const deps = makeDeps('this should never be returned');
		const result = await detectSessionControl('what does /reset do?', deps);
		expect(result.intent).toBe('continue');
		expect(result.source).toBe('prefilter');
		expect(deps.llm.complete).not.toHaveBeenCalled();
	});
});

// ─── Truncation at the output cap ────────────────────────────────────────────
//
// The safe default carries `reason: 'parse error'`, which reads as "the model
// emitted garbage". A reply cut at the 80-token cap now says so instead.

describe('classifySessionControl — truncated output', () => {
	const TRUNCATED =
		'{"intent":"new_session","confidence":0.9,"reason":"the user asked to begin a completely fresh';

	it('returns the safe default with reason "truncated" and makes exactly one call', async () => {
		const deps = makeDeps(TRUNCATED, 'length');
		const result = await classifySessionControl('lets start over', deps);
		expect(result).toEqual({
			intent: 'unclear',
			confidence: 0,
			reason: 'truncated',
			source: 'llm',
		});
		expect(deps.llm.complete).toHaveBeenCalledTimes(1);
	});

	it('logs truncation naming the cap instead of a parse error', async () => {
		const deps = makeDeps(TRUNCATED, 'length');
		await classifySessionControl('lets start over', deps);
		const [, msg] = deps.logger.warn.mock.calls[0] as [unknown, string];
		expect(msg).toContain('truncated');
		expect(msg).toContain('80-token');
		expect(msg).not.toMatch(/parse/i);
	});

	it('keeps reason "parse error" for a complete but malformed reply', async () => {
		const deps = makeDeps(TRUNCATED, 'stop');
		const result = await classifySessionControl('lets start over', deps);
		expect(result.reason).toBe('parse error');
		expect(deps.llm.complete).toHaveBeenCalledTimes(1);
	});

	it('parse-first: a complete verdict still classifies when finishReason is "length"', async () => {
		const deps = makeDeps(
			JSON.stringify({ intent: 'new_session', confidence: 0.9, reason: 'clear' }),
			'length',
		);
		const result = await classifySessionControl('lets start over', deps);
		expect(result.intent).toBe('new_session');
	});

	it('passes maxTokens 80 on the completeWithMeta call', async () => {
		const deps = makeDeps(JSON.stringify({ intent: 'continue', confidence: 0.9, reason: 'r' }));
		await classifySessionControl('hello there', deps);
		const options = deps.llm.complete.mock.calls[0]?.[1];
		expect(options).toMatchObject({ maxTokens: 80, responseFormat: 'json' });
	});
});
