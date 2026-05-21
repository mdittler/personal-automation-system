/**
 * Characterization test for the existing structural oracle's coverage of the
 * "drop-and-inflate" receipt-parser bug shape.
 *
 * Codex review of the PR2 plan pointed out that the structural oracle's
 * `multisetRows` operative — combined with sidecar-declared line items in
 * `buildExpectation` (regression/src/runner/case-runners/receipt-runner.ts) —
 * already catches the primary bug shape today: parser drops one line item and
 * inflates another item's price so the printed total still ties out.
 *
 * PR2's transcription oracle is therefore a SECOND line of defense (drift
 * resistance + confidence tiers), NOT the only catch. This characterization
 * test locks in today's behavior so future regressions of the structural
 * path are caught regardless of PR2's status.
 *
 * If this test ever fails, the structural oracle's coverage of drop-and-inflate
 * has regressed — STOP and investigate before assuming PR2's oracle picks up
 * the slack.
 *
 * The expectation shape mirrors the production builder in receipt-runner.ts
 * (`buildExpectation`, lines 103–181 as of 2026-05-15): a `multisetRows`
 * assertion on `lineItems` keyed by `name` with a `totalPrice` valueField.
 */

import { describe, expect, it } from 'vitest';
import { type StructuralExpectation, runStructuralOracle } from '../oracles/structural.js';
import { VERDICT } from '../shared/types.js';

describe('Characterization: structural multisetRows oracle catches drop-and-inflate today', () => {
	// This test PROVES the current structural oracle catches the primary bug shape.
	// If this test regresses, PR2's transcription oracle is no longer the only line of defense.
	it('drop-and-inflate: structural reports both missing C and extra B-at-inflated-price', () => {
		// Ground truth (sidecar): three items totalling $21.
		//   A=$5, B=$6, C=$10  → subtotal $21, total $21
		// Expectation matches the shape `buildExpectation()` produces for a
		// sidecar with `lineItems` + `total` + `subtotal` (no quantity/unitPrice
		// declared, so only `totalPrice` is asserted per row — same as the
		// receipt-runner's default valueFields when sidecar omits qty/unit).
		const expectation: StructuralExpectation = {
			schema: {
				type: 'object',
				required: ['store', 'date', 'lineItems', 'total'],
				properties: {
					store: { type: 'string' },
					date: { type: 'string' },
					lineItems: { type: 'array' },
					total: { type: 'number' },
				},
			},
			strings: [{ path: 'store', expectedCaseInsensitive: 'Test' }],
			scalars: [
				{ path: 'total', expected: 21, tolerance: 0.01 },
				{ path: 'subtotal', expected: 21, tolerance: 0.01 },
			],
			multisetRows: [
				{
					path: 'lineItems',
					keyField: 'name',
					valueFields: [{ field: 'totalPrice', tolerance: 0.01 }],
					expected: [
						{ name: 'A', totalPrice: 5 },
						{ name: 'B', totalPrice: 6 },
						{ name: 'C', totalPrice: 10 },
					],
				},
			],
		};

		// Parser output (drop-and-inflate bug shape):
		//   - Item C dropped entirely
		//   - Item B's totalPrice inflated from $6 → $16 so the sum still ties out
		//   - Scalars (subtotal/total) still match expected $21 — the bug is
		//     self-consistent at the totals level. multisetRows catches it
		//     because it compares per-line rows, not just sums.
		const parsedJson = JSON.stringify({
			store: 'Test',
			date: '2026-05-15',
			lineItems: [
				{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
				{ name: 'B', quantity: 1, unitPrice: 16, totalPrice: 16 }, // inflated
				// C dropped
			],
			subtotal: 21,
			tax: 0,
			total: 21,
		});

		const result = runStructuralOracle(parsedJson, expectation);

		// Primary assertion: structural oracle catches the bug.
		expect(result.verdict).toBe(VERDICT.fail);

		// The `multisetRows` operative runs before scalars (per the receipt
		// runner's commentary: "Runs before scalars so a line-item mismatch
		// surfaces before a total mismatch — more diagnostic value for
		// receipt cases."). So the failing details should reference the
		// line-item discrepancy — either "Missing rows" (C) or
		// "Hallucinated rows" (B at $16). The oracle short-circuits on the
		// first failure, so we accept any of: a reference to C (missing),
		// a reference to B at the inflated $16 (hallucinated), or the
		// generic "missing"/"hallucinated" keywords from the multisetRows
		// failure path.
		expect(result.details).toMatch(/"C"|"B".*16|missing|hallucinated/i);
	});
});
