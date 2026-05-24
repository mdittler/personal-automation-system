import { describe, expect, it, vi } from 'vitest';
import type { LLMService } from '../../../types/llm.js';
import { classifyPASMessage } from '../pas-classifier.js';

/**
 * REQ-CONV-PAS-CLASSIFY-001 — PLATFORM_INVITE_RE deterministic prefilter.
 *
 * Background: 2026-05-24 regression run for pas-invite-platform-positive
 * showed Gemma 4 31B returns pasRelated:false for all 7 invite phrasings.
 * This file pins the new prefilter so the LLM path is bypassed entirely
 * for platform-invite questions.
 */

function makeNoCallLLM(): LLMService {
	return {
		// LLM must NOT be called when a prefilter matches. We throw so any
		// stray call shows up as a loud test failure rather than a silent
		// shape-mismatch.
		complete: vi.fn(async () => {
			throw new Error('LLM was called but a prefilter should have short-circuited');
		}),
	} as unknown as LLMService;
}

describe('PAS classifier — PLATFORM_INVITE_RE prefilter', () => {
	const positivePhrasings = [
		'Can you tell me about inviting people?',
		'how do I invite someone to PAS',
		'how do invite codes work',
		'add a new user to the platform',
		'invite my wife to use this',
		'how do I add my partner',
		'can I give my kids access',
	];

	for (const text of positivePhrasings) {
		it(`"${text}" → pasRelated:true via prefilter, no LLM call`, async () => {
			const llm = makeNoCallLLM();
			const result = await classifyPASMessage(text, { llm });
			expect(result).toEqual({ pasRelated: true });
		});
	}

	const negativePhrasings = [
		// Food hosting — must NOT match (the original collision risk)
		'hosting a dinner party next Saturday',
		"we're having 8 people over for dinner",
		'planning a dinner for guests',
		// Generic conversational — must NOT match
		"what's the weather like",
		'tell me a joke',
		// Generic "invite" with no PAS / platform / user / access marker — Codex #6
		'I want to invite my friends to a concert',
		'who invites the band on Saturday Night Live',
		'inviting people to dinner',
		'inviting people to a birthday party',
		'inviting people to a concert',
		'inviting users to my party',
		'add a new user to the test database',
		'how do I register a new user in postgres',
	];

	for (const text of negativePhrasings) {
		it(`"${text}" → no prefilter short-circuit, LLM is called`, async () => {
			let llmCalls = 0;
			const llm = {
				complete: vi.fn(async () => {
					llmCalls += 1;
					return 'NO_PAS';
				}),
			} as unknown as LLMService;
			await classifyPASMessage(text, { llm });
			expect(llmCalls).toBe(1);
		});
	}

	it('prefilter is case-insensitive', async () => {
		const llm = makeNoCallLLM();
		const result = await classifyPASMessage('HOW DO I INVITE SOMEONE TO PAS', { llm });
		expect(result).toEqual({ pasRelated: true });
	});

	it('prefilter does not set dataQueryCandidate or settingsCandidate', async () => {
		// Platform-invite is a PAS meta-question, not a data query and not a
		// settings question — same shape as PAS_META_RE.
		const llm = makeNoCallLLM();
		const result = await classifyPASMessage('how do I invite someone to PAS', { llm });
		expect(result.dataQueryCandidate).toBeFalsy();
		expect(result.settingsCandidate).toBeFalsy();
	});

	it('handles surrounding punctuation', async () => {
		const llm = makeNoCallLLM();
		expect(await classifyPASMessage('"how do invite codes work"', { llm })).toEqual({
			pasRelated: true,
		});
		expect(await classifyPASMessage('  how do I invite someone to PAS?  ', { llm })).toEqual({
			pasRelated: true,
		});
	});
});
