import { describe, expect, it } from 'vitest';
import { runStructuralOracle } from '../oracles/structural.js';

describe('structural — JSON parsability emits error per spec', () => {
	it('emits error on non-JSON', () => {
		const v = runStructuralOracle('not json{', { schema: { type: 'object' } });
		expect(v.verdict).toBe('error');
		expect(v.details).toMatch(/parse/i);
	});
	it('emits error on empty string', () => {
		const v = runStructuralOracle('', { schema: { type: 'object' } });
		expect(v.verdict).toBe('error');
	});
});

describe('structural — schema violation emits fail', () => {
	it('fail on missing required', () => {
		const v = runStructuralOracle('{}', {
			schema: {
				type: 'object',
				required: ['store'],
				properties: { store: { type: 'string' } },
			},
		});
		expect(v.verdict).toBe('fail');
	});
	it('fail on wrong type', () => {
		const v = runStructuralOracle('{"total":"forty"}', {
			schema: { type: 'object', properties: { total: { type: 'number' } } },
		});
		expect(v.verdict).toBe('fail');
	});
});

describe('structural — set equality on multi-value fields', () => {
	it('pass when expected items present', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"Eggs"},{"name":"Milk"}]}', {
			schema: { type: 'object' },
			setEquality: [{ path: 'lineItems', keyField: 'name', expected: ['Eggs', 'Milk'] }],
		});
		expect(v.verdict).toBe('pass');
	});
	it('fail with missing item names listed', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"Eggs"}]}', {
			schema: { type: 'object' },
			setEquality: [{ path: 'lineItems', keyField: 'name', expected: ['Eggs', 'Bread'] }],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/Bread/);
	});
	it('fail on hallucinated item', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"Eggs"},{"name":"Caviar"}]}', {
			schema: { type: 'object' },
			setEquality: [{ path: 'lineItems', keyField: 'name', expected: ['Eggs'] }],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/caviar/i);
	});
});

describe('structural — keyed scalar tolerances on line items', () => {
	it('pass when all keyed prices within tolerance', () => {
		const v = runStructuralOracle(
			'{"lineItems":[{"name":"Eggs","totalPrice":4.99},{"name":"Milk","totalPrice":3.49}]}',
			{
				schema: { type: 'object' },
				keyedScalars: [
					{
						path: 'lineItems',
						keyField: 'name',
						valueField: 'totalPrice',
						tolerance: 0.01,
						expected: { Eggs: 4.99, Milk: 3.49 },
					},
				],
			},
		);
		expect(v.verdict).toBe('pass');
	});
	it('fail when one keyed price drifts', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"Eggs","totalPrice":4.50}]}', {
			schema: { type: 'object' },
			keyedScalars: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueField: 'totalPrice',
					tolerance: 0.01,
					expected: { Eggs: 4.99 },
				},
			],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/eggs/i);
	});
});

describe('structural — scalar with NaN/null guards (LLM-output untrust)', () => {
	it('fail when scalar is null', () => {
		const v = runStructuralOracle('{"total":null}', {
			schema: { type: 'object' },
			scalars: [{ path: 'total', expected: 1, tolerance: 0.01 }],
		});
		expect(v.verdict).toBe('fail');
	});
});

describe('structural — calendar-strict date validation', () => {
	it('fail on calendar-invalid date (Feb 30)', () => {
		const v = runStructuralOracle('{"date":"2026-02-30"}', {
			schema: { type: 'object' },
			dates: [{ path: 'date', minIso: '2024-01-01', maxIso: '2030-12-31' }],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/calendar|invalid/i);
	});
	it('fail on month 13', () => {
		const v = runStructuralOracle('{"date":"2026-13-01"}', {
			schema: { type: 'object' },
			dates: [{ path: 'date', minIso: '2024-01-01', maxIso: '2030-12-31' }],
		});
		expect(v.verdict).toBe('fail');
	});
	it('pass on valid date in range', () => {
		const v = runStructuralOracle('{"date":"2026-04-15"}', {
			schema: { type: 'object' },
			dates: [{ path: 'date', minIso: '2026-01-01', maxIso: '2026-12-31' }],
		});
		expect(v.verdict).toBe('pass');
	});
	it('fail when date is outside range', () => {
		const v = runStructuralOracle('{"date":"2025-12-15"}', {
			schema: { type: 'object' },
			dates: [{ path: 'date', minIso: '2026-01-01', maxIso: '2026-12-31' }],
		});
		expect(v.verdict).toBe('fail');
	});
});

describe('structural — string equality (store name)', () => {
	it('pass on case-insensitive normalized match', () => {
		const v = runStructuralOracle('{"store":"WALMART"}', {
			schema: { type: 'object' },
			strings: [{ path: 'store', expectedCaseInsensitive: 'walmart' }],
		});
		expect(v.verdict).toBe('pass');
	});
	it('fail on completely wrong store', () => {
		const v = runStructuralOracle('{"store":"Target"}', {
			schema: { type: 'object' },
			strings: [{ path: 'store', expectedCaseInsensitive: 'walmart' }],
		});
		expect(v.verdict).toBe('fail');
	});
});

describe('structural — additional LLM-untrust + integration coverage', () => {
	it('fail when scalar is non-numeric (null/string)', () => {
		const v = runStructuralOracle('{"total":"forty-two"}', {
			schema: { type: 'object' },
			scalars: [{ path: 'total', expected: 42, tolerance: 0.01 }],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/finite|scalar/i);
	});

	it('integration: full receipt with all assertion types passes', () => {
		const raw = JSON.stringify({
			store: 'WALMART',
			date: '2026-04-15',
			total: 12.48,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'Milk', totalPrice: 3.49 },
				{ name: 'Bread', totalPrice: 4.0 },
			],
		});
		const v = runStructuralOracle(raw, {
			schema: {
				type: 'object',
				required: ['store', 'date', 'total', 'lineItems'],
				properties: {
					store: { type: 'string' },
					date: { type: 'string' },
					total: { type: 'number' },
					lineItems: { type: 'array' },
				},
			},
			strings: [{ path: 'store', expectedCaseInsensitive: 'walmart' }],
			dates: [{ path: 'date', minIso: '2026-01-01', maxIso: '2026-12-31' }],
			scalars: [{ path: 'total', expected: 12.48, tolerance: 0.01 }],
			setEquality: [{ path: 'lineItems', keyField: 'name', expected: ['Eggs', 'Milk', 'Bread'] }],
			keyedScalars: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueField: 'totalPrice',
					tolerance: 0.01,
					expected: { Eggs: 4.99, Milk: 3.49, Bread: 4.0 },
				},
			],
		});
		expect(v.verdict).toBe('pass');
	});
});

describe('structural — date range misconfig defensive (Task 7 followup)', () => {
	it('emits error when minIso is calendar-invalid', () => {
		const v = runStructuralOracle('{"date":"2026-04-15"}', {
			schema: { type: 'object' },
			dates: [{ path: 'date', minIso: '2024-13-01', maxIso: '2026-12-31' }],
		});
		expect(v.verdict).toBe('error');
		expect(v.details).toMatch(/operator|misconfig/i);
	});

	it('emits error when maxIso is malformed', () => {
		const v = runStructuralOracle('{"date":"2026-04-15"}', {
			schema: { type: 'object' },
			dates: [{ path: 'date', minIso: '2024-01-01', maxIso: 'not-a-date' }],
		});
		expect(v.verdict).toBe('error');
		expect(v.details).toMatch(/operator|misconfig/i);
	});
});
