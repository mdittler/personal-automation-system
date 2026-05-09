import { describe, expect, it } from 'vitest';
import type { PersonaCase } from '../shared/types.js';
import { validatePersonaCase } from '../shared/validate-case.js';

const valid: PersonaCase = {
	id: 'receipt-walmart-basic',
	description: 'd',
	bucket: 'receipt',
	coverage: ['apps/food/src/services/receipt-parser.ts'],
	inputs: [{ payload: 1, expected: 1 }],
	oracle: 'structural',
	budgetUsd: 0.05,
};

describe('validatePersonaCase', () => {
	it('passes a well-formed case', () => {
		expect(() => validatePersonaCase(valid)).not.toThrow();
	});

	it.each([
		['Receipt-Walmart', /lowercase|id/i], // uppercase
		['has spaces', /id/i],
		['', /id/i],
		['/etc/passwd', /id/i],
		['1-leading-digit', /id/i], // must start with letter
		['CamelCase', /lowercase|id/i],
	])('rejects bad id %j', (id, pattern) => {
		expect(() => validatePersonaCase({ ...valid, id })).toThrow(pattern);
	});

	it('rejects unknown bucket', () => {
		expect(() => validatePersonaCase({ ...valid, bucket: 'wat' as PersonaCase['bucket'] })).toThrow(
			/bucket/i,
		);
	});

	it('rejects empty coverage', () => {
		expect(() => validatePersonaCase({ ...valid, coverage: [] })).toThrow(/coverage/i);
	});

	it.each([
		'/abs/path.ts',
		'..\\sneaky.ts',
		'../escape.ts',
		'apps/food/../sneaky.ts',
		'C:\\windows\\path.ts',
		'C:/windows/path.ts',
	])('rejects bad coverage path %j', (p) => {
		expect(() => validatePersonaCase({ ...valid, coverage: [p] })).toThrow(
			/coverage|relative|traversal/i,
		);
	});

	it('rejects negative budget', () => {
		expect(() => validatePersonaCase({ ...valid, budgetUsd: -1 })).toThrow(/budget/i);
	});

	it('rejects zero budget', () => {
		expect(() => validatePersonaCase({ ...valid, budgetUsd: 0 })).toThrow(/budget/i);
	});

	it('rejects NaN/Infinity budget', () => {
		expect(() => validatePersonaCase({ ...valid, budgetUsd: Number.NaN })).toThrow(/budget/i);
		expect(() => validatePersonaCase({ ...valid, budgetUsd: Number.POSITIVE_INFINITY })).toThrow(
			/budget/i,
		);
	});

	it('rejects oracle: rubric in Chunk A', () => {
		expect(() => validatePersonaCase({ ...valid, oracle: 'rubric' })).toThrow(/rubric|chunk c/i);
	});

	it('rejects oracle: judge always (REQ-REG-014)', () => {
		expect(() => validatePersonaCase({ ...valid, oracle: 'judge' })).toThrow(/judge|reserved/i);
	});

	it('rejects empty inputs', () => {
		expect(() => validatePersonaCase({ ...valid, inputs: [] })).toThrow(/inputs/i);
	});
});
