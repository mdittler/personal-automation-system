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
import {
	classifySessionControl,
	detectSessionControl,
	preFilterSessionControl,
} from '../session-control-classifier.js';
import type { SessionControlClassifierDeps } from '../session-control-classifier.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDeps(rawResponse: string): SessionControlClassifierDeps {
	return {
		llm: {
			complete: vi.fn().mockResolvedValue(rawResponse),
		},
		logger: { warn: vi.fn() },
	};
}

function makeThrowingDeps(): SessionControlClassifierDeps {
	return {
		llm: {
			complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
		},
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

	it.each([
		['clear chat'],
		['forget everything'],
		['reset conversation'],
	])('returns not-matched for NL phrase "%s" (handled by LLM classifier)', (phrase) => {
		const result = preFilterSessionControl(phrase);
		expect(result.matched).toBe(false);
	});

	// Safety: negations and meta-questions must NOT match
	it('returns not-matched for "don\'t start over"', () => {
		expect(preFilterSessionControl("don't start over").matched).toBe(false);
	});

	it('returns not-matched for "what does /new do?"', () => {
		expect(preFilterSessionControl('what does /new do?').matched).toBe(false);
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
		const fenced = '```json\n' + payload + '\n```';
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
		const deps = makeDeps(
			JSON.stringify({ intent: 'continue', confidence: -0.1, reason: 'bad' }),
		);
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
