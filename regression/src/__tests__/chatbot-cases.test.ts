import { describe, expect, it } from 'vitest';
import { buildCases } from '../cases/chatbot/index.js';
import { validatePersonaCase } from '../shared/validate-case.js';

describe('chatbot bucket cases (migrated from v0)', () => {
	const cases = buildCases().map((lc) => lc.case);

	it('produces exactly 10 cases (v0 corpus has 10 entries)', () => {
		expect(cases).toHaveLength(10);
	});

	it('every case validates against the PersonaCase schema', () => {
		for (const c of cases) {
			expect(() => validatePersonaCase(c)).not.toThrow();
		}
	});

	it('every case uses bucket="chatbot" and oracle="rubric"', () => {
		for (const c of cases) {
			expect(c.bucket).toBe('chatbot');
			expect(c.oracle).toBe('rubric');
			expect(typeof c.rubric).toBe('string');
			expect(c.rubric!.length).toBeGreaterThan(10);
		}
	});

	it('case IDs cover the migrated v0 corpus (renamed to drop "or-routing" prefix)', () => {
		const expected = new Set([
			'chatbot-costco-21-items',
			'chatbot-last-costco-trip',
			'chatbot-receipt-vs-meal-plan',
			'chatbot-receipt-items-and-total',
			'chatbot-cheapest-blueberries',
			'chatbot-store-spending',
			'chatbot-grocery-list-empty',
			'chatbot-blueberries-at-costco',
			'chatbot-costco-last-items',
			'chatbot-new-receipt-items',
		]);
		expect(new Set(cases.map((c) => c.id))).toEqual(expected);
	});

	// Codex I6 follow-up: expectedHandler is INTENTIONALLY ABSENT pending
	// Router instrumentation. Re-introduce this test (asserting presence +
	// taxonomy alignment with apps/food/src/index.ts regexWinner values) once
	// the chatbot env factory's captureHandler returns a real handler id.
	it('no chatbot case declares expectedHandler (deferred — Router instrumentation pending)', () => {
		for (const c of cases) {
			const exp = c.inputs[0]!.expected as { expectedHandler?: string };
			expect(exp.expectedHandler).toBeUndefined();
		}
	});

	it('every chatbot prompt is self-contained (no context-dependent pronouns; Codex C3)', () => {
		const BANNED = /\b(those items|that receipt|I just sent|the receipt I just|the items I just)\b/i;
		for (const c of cases) {
			const payload = String(c.inputs[0]!.payload);
			expect(payload).not.toMatch(BANNED);
		}
	});

	it('every rubric mentions at least one expected content keyword', () => {
		for (const c of cases) {
			expect(c.rubric!.toLowerCase()).toMatch(
				/costco|trader|blueberr|receipt|grocery|spend|\$|store|item/,
			);
		}
	});

	it('every case covers receipt-query + food index', () => {
		for (const c of cases) {
			expect(c.coverage).toContain('apps/food/src/index.ts');
		}
	});

	it('every case sets a positive budgetUsd ≤ 0.5', () => {
		for (const c of cases) {
			expect(c.budgetUsd).toBeGreaterThan(0);
			expect(c.budgetUsd).toBeLessThanOrEqual(0.5);
		}
	});
});
