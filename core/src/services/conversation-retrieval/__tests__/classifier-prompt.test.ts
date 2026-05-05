/**
 * Tests for CLASSIFIER_SYSTEM_PROMPT template substitution (Hermes P6 Chunk F).
 *
 * Verifies:
 *  - Prompt with today='2026-05-05' contains 'Today: 2026-05-05'
 *  - Prompt contains all 4 pinned example dates
 *  - classifyRecallIntent throws (or rejects) when today is missing
 */

import { describe, expect, it, vi } from 'vitest';
import {
	buildClassifierPrompt,
	classifyRecallIntent,
} from '../recall-classifier.js';

describe('buildClassifierPrompt', () => {
	it("substitutes today into the prompt: 'Today: 2026-05-05'", () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain('Today: 2026-05-05');
	});

	it('contains all 4 pinned example dates', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain('2026-04-28'); // last Tuesday
		expect(prompt).toContain('2026-05-04'); // yesterday
		expect(prompt).toContain('2026-04-14'); // two weeks ago window start
		expect(prompt).toContain('2026-04-22'); // two weeks ago window end
	});

	it('produces different output when different today values are passed', () => {
		const p1 = buildClassifierPrompt('2026-05-05');
		const p2 = buildClassifierPrompt('2026-06-01');
		expect(p1).not.toBe(p2);
		expect(p2).toContain('Today: 2026-06-01');
	});
});

describe('classifyRecallIntent — today parameter', () => {
	it('throws (synchronously via rejection) when today is empty string', async () => {
		const deps = {
			llm: { complete: vi.fn().mockResolvedValue('{}') },
			logger: { warn: vi.fn() },
			today: '',
		};
		await expect(classifyRecallIntent('did we talk about food?', deps)).rejects.toThrow();
	});
});
