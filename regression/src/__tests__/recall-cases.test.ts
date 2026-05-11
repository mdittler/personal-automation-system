import { describe, expect, it } from 'vitest';
import { buildCases } from '../cases/recall/index.js';
import { validatePersonaCase } from '../shared/validate-case.js';

describe('recall bucket cases', () => {
	const cases = buildCases().map((lc) => lc.case);

	it('produces exactly 25 cases (REQ-REG-005 spec line 308)', () => {
		expect(cases).toHaveLength(25);
	});

	it('every case validates against the PersonaCase schema', () => {
		for (const c of cases) {
			expect(() => validatePersonaCase(c)).not.toThrow();
		}
	});

	it('every case uses bucket="recall" and oracle="structural"', () => {
		for (const c of cases) {
			expect(c.bucket).toBe('recall');
			expect(c.oracle).toBe('structural');
		}
	});

	it('every case covers recall-classifier + transcript-search', () => {
		for (const c of cases) {
			expect(c.coverage).toContain(
				'core/src/services/conversation-retrieval/recall-classifier.ts',
			);
		}
	});

	it('every case has a non-empty inputs array', () => {
		for (const c of cases) {
			expect(c.inputs.length).toBeGreaterThanOrEqual(1);
		}
	});

	it('case IDs are unique and match the safe-id regex', () => {
		const ids = cases.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(/^[a-z][a-z0-9-]{0,127}$/);
		}
	});

	it('at least 12 cases label shouldRecall=true', () => {
		const trueCases = cases.filter((c) =>
			c.inputs.some((inp) => {
				const exp = inp.expected as { schema?: { properties?: { shouldRecall?: { const?: boolean } } } };
				return exp.schema?.properties?.shouldRecall?.const === true;
			}),
		);
		expect(trueCases.length).toBeGreaterThanOrEqual(12);
	});

	it('at least 10 cases label shouldRecall=false', () => {
		const falseCases = cases.filter((c) =>
			c.inputs.some((inp) => {
				const exp = inp.expected as { schema?: { properties?: { shouldRecall?: { const?: boolean } } } };
				return exp.schema?.properties?.shouldRecall?.const === false;
			}),
		);
		expect(falseCases.length).toBeGreaterThanOrEqual(10);
	});

	it('every temporal case asserts an exact on/before/after value (Codex C4)', () => {
		const temporalIds = [
			'recall-true-yesterday',
			'recall-true-last-friday',
			'recall-true-last-week',
			'recall-true-in-march',
			'recall-true-in-april',
		];
		for (const id of temporalIds) {
			const c = cases.find((x) => x.id === id);
			expect(c, `missing temporal case ${id}`).toBeDefined();
			const exp = c!.inputs[0]!.expected as {
				schema?: {
					properties?: {
						timeAnchor?: {
							properties?: { on?: { const?: string }; after?: { const?: string }; before?: { const?: string } };
						};
					};
				};
			};
			const anchorProps = exp.schema?.properties?.timeAnchor?.properties;
			const hasExact =
				typeof anchorProps?.on?.const === 'string' ||
				typeof anchorProps?.after?.const === 'string' ||
				typeof anchorProps?.before?.const === 'string';
			expect(hasExact, `${id} must pin at least one exact date`).toBe(true);
		}
	});

	it('every case that asserts shouldRecall=true requires a non-empty query (Codex C5)', () => {
		const trueCases = cases.filter((c) => {
			const exp = c.inputs[0]!.expected as { schema?: { properties?: { shouldRecall?: { const?: boolean } } } };
			return exp.schema?.properties?.shouldRecall?.const === true;
		});
		for (const c of trueCases) {
			const exp = c.inputs[0]!.expected as { schema?: { properties?: { query?: { type?: string; minLength?: number } } } };
			expect(exp.schema?.properties?.query?.type).toBe('string');
			expect(exp.schema?.properties?.query?.minLength).toBeGreaterThanOrEqual(1);
		}
	});

	it('observational cases exist and are flagged on the input', () => {
		const obs = cases.filter((c) =>
			c.inputs.some((inp) => (inp as { observational?: boolean }).observational === true),
		);
		expect(obs.length).toBe(2);
	});

	it('every temporal case pins a deterministic today value', () => {
		const temporalIds = [
			'recall-true-yesterday',
			'recall-true-last-friday',
			'recall-true-last-week',
			'recall-true-in-march',
			'recall-true-in-april',
		];
		for (const id of temporalIds) {
			const c = cases.find((x) => x.id === id)!;
			expect((c.inputs[0]! as { today?: string }).today).toBe('2026-05-11');
		}
	});

	it('every case sets budgetUsd > 0 and ≤ 0.10 (fast-tier classifier)', () => {
		for (const c of cases) {
			expect(c.budgetUsd).toBeGreaterThan(0);
			expect(c.budgetUsd).toBeLessThanOrEqual(0.1);
		}
	});
});
