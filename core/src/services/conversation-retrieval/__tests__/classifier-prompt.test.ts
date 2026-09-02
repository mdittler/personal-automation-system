/**
 * Tests for buildClassifierPrompt (Hermes P6 Chunk F / Codex correction).
 *
 * Verifies:
 *  - Today date is injected correctly
 *  - Examples are generated relative to the supplied today (not hardcoded)
 *  - A different today produces different example dates (no stale May-5 dates)
 *  - classifyRecallIntent throws when today is missing
 */

import { describe, expect, it, vi } from 'vitest';
import { withCompleteWithMeta } from '../../../testing/llm-meta-stub.js';
import { buildClassifierPrompt, classifyRecallIntent } from '../recall-classifier.js';

describe('buildClassifierPrompt', () => {
	it("substitutes today into the prompt: 'Today: 2026-05-05'", () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain('Today: 2026-05-05');
	});

	it('generates examples relative to today — prompt for 2026-05-05 (Tuesday) has correct relative dates', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		// yesterday = 2026-05-04
		expect(prompt).toContain('2026-05-04');
		// last Tuesday (today is Tue, so go back 7) = 2026-04-28
		expect(prompt).toContain('2026-04-28');
	});

	it('buildClassifierPrompt("2026-06-01") contains no stale 2026-05-05 example dates', () => {
		const prompt = buildClassifierPrompt('2026-06-01');
		expect(prompt).toContain('Today: 2026-06-01');
		// Stale May-5 anchor dates must NOT appear
		expect(prompt).not.toContain('2026-04-28'); // last-Tuesday relative to 2026-05-05
		expect(prompt).not.toContain('2026-05-04'); // yesterday relative to 2026-05-05
	});

	it('different today values produce different example dates', () => {
		const p1 = buildClassifierPrompt('2026-05-05');
		const p2 = buildClassifierPrompt('2026-06-01');
		expect(p1).not.toBe(p2);
		expect(p2).toContain('Today: 2026-06-01');
		// Yesterday relative to 2026-06-01
		expect(p2).toContain('2026-05-31');
	});
});

describe('classifyRecallIntent — today parameter', () => {
	it('throws (synchronously via rejection) when today is empty string', async () => {
		const deps = {
			llm: withCompleteWithMeta({ complete: vi.fn().mockResolvedValue('{}') }),
			logger: { warn: vi.fn() },
			today: '',
		};
		await expect(classifyRecallIntent('did we talk about food?', deps)).rejects.toThrow();
	});
});
