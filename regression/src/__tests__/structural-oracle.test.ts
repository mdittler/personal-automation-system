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

describe('structural — multisetRows operative (row-level correlation + duplicate preservation)', () => {
	it('pass on happy path with single valueField (totalPrice only)', () => {
		const v = runStructuralOracle(
			'{"lineItems":[{"name":"Eggs","totalPrice":4.99},{"name":"Milk","totalPrice":3.49}]}',
			{
				schema: { type: 'object' },
				multisetRows: [
					{
						path: 'lineItems',
						keyField: 'name',
						valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
						expected: [
							{ name: 'Eggs', totalPrice: 4.99 },
							{ name: 'Milk', totalPrice: 3.49 },
						],
					},
				],
			},
		);
		expect(v.verdict).toBe('pass');
	});

	it('pass on row-correlated quantity + unitPrice (matched per row)', () => {
		const v = runStructuralOracle(
			'{"lineItems":[{"name":"BANANA EACH","quantity":8,"unitPrice":0.23,"totalPrice":1.84}]}',
			{
				schema: { type: 'object' },
				multisetRows: [
					{
						path: 'lineItems',
						keyField: 'name',
						valueFields: [
							{ field: 'totalPrice', tolerance: 0.01 },
							{ field: 'quantity', tolerance: 0.001 },
							{ field: 'unitPrice', tolerance: 0.01 },
						],
						expected: [{ name: 'BANANA EACH', quantity: 8, unitPrice: 0.23, totalPrice: 1.84 }],
					},
				],
			},
		);
		expect(v.verdict).toBe('pass');
	});

	// The critical case: same-name duplicates with DIFFERENT multipliers
	// must not cross-pair. Without row-level correlation, separate
	// `(name, quantity)` and `(name, unitPrice)` multisets could pass with
	// values distributed across the wrong rows.
	it('fail when row-level correlation breaks (same name, swapped quantity/unitPrice across actuals)', () => {
		const v = runStructuralOracle(
			// Two BANANA rows, but the parser swapped (quantity, unitPrice) across them.
			// Expected: { q=8, u=0.23, total=1.84 } AND { q=5, u=0.30, total=1.50 }
			// Actual:   { q=5, u=0.23, total=1.84 } AND { q=8, u=0.30, total=1.50 }
			'{"lineItems":[{"name":"BANANA EACH","quantity":5,"unitPrice":0.23,"totalPrice":1.84},{"name":"BANANA EACH","quantity":8,"unitPrice":0.30,"totalPrice":1.50}]}',
			{
				schema: { type: 'object' },
				multisetRows: [
					{
						path: 'lineItems',
						keyField: 'name',
						valueFields: [
							{ field: 'totalPrice', tolerance: 0.01 },
							{ field: 'quantity', tolerance: 0.001 },
							{ field: 'unitPrice', tolerance: 0.01 },
						],
						expected: [
							{ name: 'BANANA EACH', quantity: 8, unitPrice: 0.23, totalPrice: 1.84 },
							{ name: 'BANANA EACH', quantity: 5, unitPrice: 0.3, totalPrice: 1.5 },
						],
					},
				],
			},
		);
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/BANANA EACH/);
	});

	it('expected rows that omit a valueField only assert declared fields', () => {
		// Sidecar declares quantity for one line but NOT for the other.
		// The undeclared field should not be asserted.
		const v = runStructuralOracle(
			'{"lineItems":[{"name":"BANANA EACH","quantity":8,"unitPrice":0.23,"totalPrice":1.84},{"name":"Eggs","quantity":42,"unitPrice":99,"totalPrice":4.99}]}',
			{
				schema: { type: 'object' },
				multisetRows: [
					{
						path: 'lineItems',
						keyField: 'name',
						valueFields: [
							{ field: 'totalPrice', tolerance: 0.01 },
							{ field: 'quantity', tolerance: 0.001 },
							{ field: 'unitPrice', tolerance: 0.01 },
						],
						expected: [
							// BANANA EACH asserts all three fields
							{ name: 'BANANA EACH', quantity: 8, unitPrice: 0.23, totalPrice: 1.84 },
							// Eggs asserts ONLY totalPrice — the parser's wildly wrong
							// quantity (42) and unitPrice (99) should NOT cause failure
							// because the sidecar doesn't declare them for this row.
							{ name: 'Eggs', totalPrice: 4.99 },
						],
					},
				],
			},
		);
		expect(v.verdict).toBe('pass');
	});

	it('fails when actual numeric field is NaN-equivalent (null)', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"X","totalPrice":null,"quantity":1}]}', {
			schema: { type: 'object' },
			multisetRows: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
					expected: [{ name: 'X', totalPrice: 1.0 }],
				},
			],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/not finite|totalPrice/i);
	});

	it('errors when expected row missing the keyField (operator misconfig)', () => {
		const v = runStructuralOracle('{"lineItems":[]}', {
			schema: { type: 'object' },
			multisetRows: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
					expected: [{ totalPrice: 1.0 } as Record<string, unknown>],
				},
			],
		});
		expect(v.verdict).toBe('error');
		expect(v.details).toMatch(/missing string key/i);
	});

	it('fails on extra actual rows (hallucinated line)', () => {
		const v = runStructuralOracle(
			'{"lineItems":[{"name":"Eggs","totalPrice":4.99},{"name":"Caviar","totalPrice":99}]}',
			{
				schema: { type: 'object' },
				multisetRows: [
					{
						path: 'lineItems',
						keyField: 'name',
						valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
						expected: [{ name: 'Eggs', totalPrice: 4.99 }],
					},
				],
			},
		);
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/hallucinated|caviar/i);
	});

	it('fails when path is not an array', () => {
		const v = runStructuralOracle('{"lineItems":"not an array"}', {
			schema: { type: 'object' },
			multisetRows: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
					expected: [{ name: 'X', totalPrice: 1 }],
				},
			],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/not an array/);
	});

	it('pass on duplicate same-name same-price (preserves count for Costco PE GRANOLA case)', () => {
		const v = runStructuralOracle(
			'{"lineItems":[{"name":"PE GRANOLA","totalPrice":10.99},{"name":"PE GRANOLA","totalPrice":10.99}]}',
			{
				schema: { type: 'object' },
				multisetRows: [
					{
						path: 'lineItems',
						keyField: 'name',
						valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
						expected: [
							{ name: 'PE GRANOLA', totalPrice: 10.99 },
							{ name: 'PE GRANOLA', totalPrice: 10.99 },
						],
					},
				],
			},
		);
		expect(v.verdict).toBe('pass');
	});

	it('fail on missing duplicate (expected 2 PE GRANOLA, actual 1)', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"PE GRANOLA","totalPrice":10.99}]}', {
			schema: { type: 'object' },
			multisetRows: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
					expected: [
						{ name: 'PE GRANOLA', totalPrice: 10.99 },
						{ name: 'PE GRANOLA', totalPrice: 10.99 },
					],
				},
			],
		});
		expect(v.verdict).toBe('fail');
		expect(v.details).toMatch(/PE GRANOLA/);
	});

	it('pass at tolerance edge (diff 0.004 with tolerance 0.005)', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"X","totalPrice":1.004}]}', {
			schema: { type: 'object' },
			multisetRows: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueFields: [{ field: 'totalPrice', tolerance: 0.005 }],
					expected: [{ name: 'X', totalPrice: 1.0 }],
				},
			],
		});
		expect(v.verdict).toBe('pass');
	});

	it('fail just outside tolerance (diff 0.006 with tolerance 0.005)', () => {
		const v = runStructuralOracle('{"lineItems":[{"name":"X","totalPrice":1.006}]}', {
			schema: { type: 'object' },
			multisetRows: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueFields: [{ field: 'totalPrice', tolerance: 0.005 }],
					expected: [{ name: 'X', totalPrice: 1.0 }],
				},
			],
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
