import { describe, expect, it } from 'vitest';
import type {
	OracleKind,
	PersonaCase,
	RunResult,
	TierModelSnapshot,
	Verdict,
} from '../shared/types.js';

describe('regression types', () => {
	it('PersonaCase requires all required fields', () => {
		const c: PersonaCase = {
			id: 'x',
			description: 'd',
			bucket: 'receipt',
			coverage: ['a.ts'],
			inputs: [{ payload: 1, expected: 2 }],
			oracle: 'structural',
			budgetUsd: 0.05,
		};
		expect(c.id).toBe('x');
	});

	it('OracleKind covers structural | rubric | judge', () => {
		const kinds: OracleKind[] = ['structural', 'rubric', 'judge'];
		expect(kinds).toHaveLength(3);
	});

	it('Verdict union matches spec', () => {
		const v: Verdict[] = ['pass', 'fail', 'error', 'budget-exceeded'];
		expect(v).toHaveLength(4);
	});

	it('TierModelSnapshot allows reasoning to be null', () => {
		const s: TierModelSnapshot = { fast: 'f', standard: 's', reasoning: null };
		expect(s.reasoning).toBeNull();
	});

	it('RunResult does NOT have a judgeModelId field (regression guard)', () => {
		// The early plan added judgeModelId; current plan drops it. This typecheck
		// guard catches accidental re-introduction.
		type HasJudgeModelId = 'judgeModelId' extends keyof RunResult ? true : false;
		const _noJudgeModelId: HasJudgeModelId = false;
		expect(_noJudgeModelId).toBe(false);
	});
});
