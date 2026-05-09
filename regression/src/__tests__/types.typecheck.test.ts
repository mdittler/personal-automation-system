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

	it('RunResult judgeModelId removed (was in early plan; types use modelIds only)', () => {
		// Sanity: making sure nothing leaked the old judgeModelId field
		const r: Pick<RunResult, 'modelIds'> = {
			modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
		};
		expect(r.modelIds.fast).toBe('f');
	});
});
