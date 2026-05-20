/**
 * Receipt runner integration tests (REQ-REG-008).
 *
 * These tests prove that the regression runner invokes the REAL production
 * `parseReceiptFromPhoto` from `apps/food/src/services/receipt-parser.ts`.
 * If the production prompt or post-processing changes in a regressive way,
 * the suite must catch it — and that requires consuming the real function,
 * not duplicating its prompt locally.
 *
 * The LLM is mocked here (via `vi.fn()`) because we test the runner's wiring,
 * not the model. End-to-end runs against real LLMs happen via the CLI in
 * later tasks.
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { combineVerdicts, runReceiptCase } from '../runner/case-runners/receipt-runner.js';
import type { Verdict } from '../shared/types.js';
import {
	llmShim,
	llmShimFromMock,
	makeCase,
	makeReceiptDeps,
	makeTempDir,
	removeTempDir,
	stagePhoto as stagePhotoIn,
	stageSidecar as stageSidecarIn,
} from './_buildcase-helper.js';

let tempDir: string;
beforeEach(async () => {
	tempDir = await makeTempDir();
});
afterEach(async () => {
	await removeTempDir(tempDir);
});

async function stagePhoto(name: string): Promise<string> {
	return stagePhotoIn(tempDir, name);
}

async function stageSidecar(name: string, sidecar: object): Promise<string> {
	return stageSidecarIn(tempDir, name, sidecar);
}

describe('runReceiptCase — production parser integration', () => {
	it('passes when LLM extraction matches sidecar exactly', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 47.82,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'Milk', totalPrice: 3.49 },
			],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [
					{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
					{ name: 'Milk', quantity: 1, unitPrice: 3.49, totalPrice: 3.49 },
				],
				subtotal: 8.48,
				tax: 39.34,
				total: 47.82,
			}),
		);
		const deps = makeReceiptDeps(llmShimFromMock(llmComplete));
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath), deps);
		expect(result.verdict).toBe('pass');
		expect(result.actuals).toHaveLength(1);
		expect(result.costUsd).toBeCloseTo(0.02, 4);
		expect(llmComplete).toHaveBeenCalledTimes(1);
		const callArgs = llmComplete.mock.calls[0];
		if (!callArgs) throw new Error('expected llm.complete to have been called');
		const prompt = callArgs[0] as string;
		// Sample the food prompt's structure — these regexes catch regressions
		// that strip or rearrange the prompt without breaking JSON parseability.
		expect(prompt).toMatch(/grocery receipt/i);
		expect(prompt).toMatch(/YYYY-MM-DD/);
		expect(prompt).toMatch(/lineItems/);
		expect(prompt).toMatch(/total/i);
		// The LLM-side options carry tier and images
		const opts = callArgs[1] as { tier?: string; images?: Array<{ mimeType: string }> };
		expect(opts.tier).toBe('standard');
		expect(opts.images?.[0]?.mimeType).toBe('image/png');
		expect(result.oracleVerdicts[0]?.verdict).toBe('pass');
	});

	it('fails when LLM hallucinates a line item (set-equality)', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
						{ name: 'Hallucinated Caviar', quantity: 1, unitPrice: 100, totalPrice: 100 },
					],
					subtotal: 104.99,
					tax: 0,
					total: 104.99,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'hallu'), deps);
		expect(result.verdict).toBe('fail');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/caviar/i);
	});

	it('emits verdict=error when LLM returns malformed JSON (parser throws)', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const deps = makeReceiptDeps(llmShim('not json{'));
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'bad-json'), deps);
		expect(result.verdict).toBe('error');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/parser threw/i);
		expect(result.actuals[0]).toBeNull();
	});

	it('expectRejection=true: parser overwrites date to today, preserves rawExtractedDate', async () => {
		const photoPath = await stagePhoto('future');
		const sidecarPath = await stageSidecar('future', {
			expectRejection: true,
			store: 'Walmart',
			total: 47.82,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		// LLM returns a date 70+ years in the future — the production parser's
		// isValidReceiptDate rejects it (MAX_RECEIPT_AGE_DAYS = 90, future
		// dates rejected).
		const futureDate = '2099-12-31';
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: futureDate,
					lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
					subtotal: 4.99,
					tax: 0,
					total: 47.82,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'reject'), deps);
		expect(result.verdict).toBe('pass');
		const parsed = result.actuals[0] as { rawExtractedDate?: string; date: string };
		expect(parsed.rawExtractedDate).toBe(futureDate);
		expect(parsed.date).not.toBe(futureDate); // overwritten to today (parser fallback)
	});

	it('aborts with verdict=budget-exceeded before any LLM call when first call would exceed budget', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [],
				subtotal: 0,
				tax: 0,
				total: 4.99,
			}),
		);
		const deps = makeReceiptDeps(llmShimFromMock(llmComplete), {
			caseBudgetUsd: 0.01,
			estimateUsd: () => 0.05, // every call costs 5x the budget
		});
		const c = makeCase(photoPath, sidecarPath, 'budget');
		c.inputs.push({
			payload: { photoFixture: photoPath, sidecarFixture: sidecarPath },
			expected: { kind: 'sidecar' },
		});
		const result = await runReceiptCase(c, deps);
		expect(result.verdict).toBe('budget-exceeded');
		// Pre-charge gate fires before the first call is dispatched: 0 + 0.05 > 0.01.
		expect(llmComplete).not.toHaveBeenCalled();
		expect(result.costUsd).toBe(0);
	});

	it('preserves prior fail verdict when a later input would trip the budget gate', async () => {
		// Two-input case: input 1 hallucinates a line item (verdict=fail);
		// input 2 would trip the budget gate. Final verdict must be 'fail',
		// NOT 'budget-exceeded' — stronger verdicts must not be clobbered.
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart-precedence', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [
					{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
					{ name: 'Hallucinated Caviar', quantity: 1, unitPrice: 100, totalPrice: 100 },
				],
				subtotal: 104.99,
				tax: 0,
				total: 104.99,
			}),
		);
		// estimate: first call $0.02 (fits in $0.05 budget), second call $0.05 (would push 0.02+0.05=0.07 > 0.05)
		let callIdx = 0;
		const deps = makeReceiptDeps(llmShimFromMock(llmComplete), {
			estimateUsd: () => {
				callIdx += 1;
				return callIdx === 1 ? 0.02 : 0.05;
			},
		});
		const c = makeCase(photoPath, sidecarPath, 'precedence');
		c.inputs.push({
			payload: { photoFixture: photoPath, sidecarFixture: sidecarPath },
			expected: { kind: 'sidecar' },
		});
		const result = await runReceiptCase(c, deps);
		expect(result.verdict).toBe('fail');
		// First input was processed (LLM called once, hallucination → fail).
		// Second input was gated out, but must NOT clobber the prior fail.
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(result.oracleVerdicts).toHaveLength(1);
		expect(result.oracleVerdicts[0]?.verdict).toBe('fail');
	});

	it('passes input to production parseReceiptFromPhoto with correct mime type and tier', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
				subtotal: 4.99,
				tax: 0,
				total: 4.99,
			}),
		);
		const deps = makeReceiptDeps(llmShimFromMock(llmComplete));
		await runReceiptCase(makeCase(photoPath, sidecarPath, 'mime'), deps);
		expect(llmComplete).toHaveBeenCalledTimes(1);
		const callArgs = llmComplete.mock.calls[0];
		expect(callArgs).toBeDefined();
		const opts = callArgs?.[1] as {
			tier?: string;
			images?: Array<{ mimeType: string; data: Buffer }>;
		};
		expect(opts.tier).toBe('standard');
		expect(opts.images).toHaveLength(1);
		expect(opts.images?.[0]?.mimeType).toBe('image/png');
		expect(Buffer.isBuffer(opts.images?.[0]?.data)).toBe(true);
	});

	// Rejection sidecars assert `rawExtractedDate` to prove the parser
	// preserved the LLM's original date extraction for audit.
	it('expectRejection sidecar with rejectedDate asserts rawExtractedDate matches', async () => {
		const photoPath = await stagePhoto('expired');
		const sidecarPath = await stageSidecar('expired', {
			expectRejection: true,
			store: 'Wegmans Food Markets',
			rejectedDate: '2025-08-01',
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Wegmans Food Markets',
					date: '2025-08-01', // >90 days ago → rejected, becomes rawExtractedDate
					lineItems: [{ name: 'Bananas', quantity: 1, unitPrice: 2.49, totalPrice: 2.49 }],
					subtotal: 2.49,
					tax: 0,
					total: 2.49,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCase(photoPath, sidecarPath, 'rejected-date-pass'),
			deps,
		);
		expect(result.verdict).toBe('pass');
		const parsed = result.actuals[0] as { rawExtractedDate?: string };
		expect(parsed.rawExtractedDate).toBe('2025-08-01');
	});

	it('expectRejection sidecar fails when rawExtractedDate disagrees with rejectedDate', async () => {
		const photoPath = await stagePhoto('expired');
		const sidecarPath = await stageSidecar('expired-mismatch', {
			expectRejection: true,
			store: 'Wegmans Food Markets',
			rejectedDate: '2025-08-01',
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Wegmans Food Markets',
					date: '2025-07-15', // different rejected date than sidecar expects
					lineItems: [{ name: 'Bananas', quantity: 1, unitPrice: 2.49, totalPrice: 2.49 }],
					subtotal: 2.49,
					tax: 0,
					total: 2.49,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCase(photoPath, sidecarPath, 'rejected-date-fail'),
			deps,
		);
		expect(result.verdict).toBe('fail');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/rawExtractedDate/i);
	});

	// The multiset operative preserves duplicate counts so receipt sidecars
	// can use faithful printed names (no #1/#2 suffix workarounds).
	it('passes on duplicate-named line items at same price (two PE GRANOLA $10.99)', async () => {
		const photoPath = await stagePhoto('costco');
		const sidecarPath = await stageSidecar('costco-dupes', {
			store: 'Costco',
			date: '2026-04-27',
			total: 21.98,
			lineItems: [
				{ name: 'PE GRANOLA', totalPrice: 10.99 },
				{ name: 'PE GRANOLA', totalPrice: 10.99 },
			],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Costco',
					date: '2026-04-27',
					lineItems: [
						{ name: 'PE GRANOLA', quantity: 1, unitPrice: 10.99, totalPrice: 10.99 },
						{ name: 'PE GRANOLA', quantity: 1, unitPrice: 10.99, totalPrice: 10.99 },
					],
					subtotal: 21.98,
					tax: 0,
					total: 21.98,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'dupes'), deps);
		expect(result.verdict).toBe('pass');
	});

	it('fails when parser collapses two duplicate items into one', async () => {
		const photoPath = await stagePhoto('costco');
		const sidecarPath = await stageSidecar('costco-collapse', {
			store: 'Costco',
			date: '2026-04-27',
			total: 21.98,
			lineItems: [
				{ name: 'PE GRANOLA', totalPrice: 10.99 },
				{ name: 'PE GRANOLA', totalPrice: 10.99 },
			],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Costco',
					date: '2026-04-27',
					// Parser collapsed two lines into one — multiset oracle catches this.
					lineItems: [{ name: 'PE GRANOLA', quantity: 1, unitPrice: 10.99, totalPrice: 10.99 }],
					subtotal: 10.99,
					tax: 0,
					total: 21.98,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'collapse'), deps);
		expect(result.verdict).toBe('fail');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/missing.*PE GRANOLA/i);
	});

	it('disambiguates same-name different-price duplicates (two Grocery non-taxable lines)', async () => {
		const photoPath = await stagePhoto('tj');
		const sidecarPath = await stageSidecar('tj-grocery', {
			store: "Trader Joe's",
			date: '2026-05-12',
			total: 19.42,
			lineItems: [
				{ name: 'Grocery non-taxable', totalPrice: 10.07 },
				{ name: 'Grocery non-taxable', totalPrice: 9.35 },
			],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: "Trader Joe's",
					date: '2026-05-12',
					lineItems: [
						{
							name: 'Grocery non-taxable',
							quantity: 1,
							unitPrice: 10.07,
							totalPrice: 10.07,
						},
						{
							name: 'Grocery non-taxable',
							quantity: 1,
							unitPrice: 9.35,
							totalPrice: 9.35,
						},
					],
					subtotal: 19.42,
					tax: 0,
					total: 19.42,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'grocery-dupes'), deps);
		expect(result.verdict).toBe('pass');
	});

	// quantity/unitPrice on sidecar lines become additional multiset
	// assertions. A parser that ignores the multiplier and emits
	// quantity=1, unitPrice=<totalPrice> for a line that should have
	// quantity=8 is caught here.
	it('passes when parser emits matching quantity + unitPrice for multiplier line', async () => {
		const photoPath = await stagePhoto('tj-bananas');
		const sidecarPath = await stageSidecar('tj-bananas-pass', {
			store: "Trader Joe's",
			date: '2026-05-10',
			total: 1.84,
			lineItems: [{ name: 'BANANA EACH', quantity: 8, unitPrice: 0.23, totalPrice: 1.84 }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: "Trader Joe's",
					date: '2026-05-10',
					lineItems: [{ name: 'BANANA EACH', quantity: 8, unitPrice: 0.23, totalPrice: 1.84 }],
					subtotal: 1.84,
					tax: 0,
					total: 1.84,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'qty-pass'), deps);
		expect(result.verdict).toBe('pass');
	});

	// Subtotal/tax assertions when sidecar provides them.
	it('fails when parser returns wrong subtotal even though total matches', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart-subtotal', {
			store: 'Walmart',
			date: '2026-04-15',
			subtotal: 8.48,
			tax: 0.42,
			total: 8.9,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'Milk', totalPrice: 3.49 },
			],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
						{ name: 'Milk', quantity: 1, unitPrice: 3.49, totalPrice: 3.49 },
					],
					// Wrong subtotal — sidecar says 8.48, parser claims 7.00.
					subtotal: 7.0,
					tax: 0.42,
					total: 8.9,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'sub-fail'), deps);
		expect(result.verdict).toBe('fail');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/subtotal/i);
	});

	it('fails when parser returns wrong tax even though total + subtotal match', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart-tax', {
			store: 'Walmart',
			date: '2026-04-15',
			subtotal: 8.48,
			tax: 0.42,
			total: 8.9,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'Milk', totalPrice: 3.49 },
			],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
						{ name: 'Milk', quantity: 1, unitPrice: 3.49, totalPrice: 3.49 },
					],
					subtotal: 8.48,
					// Wrong tax — sidecar says 0.42, parser claims 1.50.
					tax: 1.5,
					total: 8.9,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'tax-fail'), deps);
		expect(result.verdict).toBe('fail');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/tax/i);
	});

	it('passes when subtotal + tax + total all match within tolerance', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart-all-pass', {
			store: 'Walmart',
			date: '2026-04-15',
			subtotal: 8.48,
			tax: 0.42,
			total: 8.9,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'Milk', totalPrice: 3.49 },
			],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
						{ name: 'Milk', quantity: 1, unitPrice: 3.49, totalPrice: 3.49 },
					],
					subtotal: 8.48,
					tax: 0.42,
					total: 8.9,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'all-pass'), deps);
		expect(result.verdict).toBe('pass');
	});

	it('fails when parser collapses multiplier into quantity=1 unitPrice=totalPrice', async () => {
		const photoPath = await stagePhoto('tj-bananas');
		const sidecarPath = await stageSidecar('tj-bananas-fail', {
			store: "Trader Joe's",
			date: '2026-05-10',
			total: 1.84,
			lineItems: [{ name: 'BANANA EACH', quantity: 8, unitPrice: 0.23, totalPrice: 1.84 }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: "Trader Joe's",
					date: '2026-05-10',
					// Parser collapsed the multiplier — quantity=1, unitPrice=totalPrice.
					lineItems: [{ name: 'BANANA EACH', quantity: 1, unitPrice: 1.84, totalPrice: 1.84 }],
					subtotal: 1.84,
					tax: 0,
					total: 1.84,
				}),
			),
		);
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'qty-fail'), deps);
		expect(result.verdict).toBe('fail');
		// Either the quantity multiset or the unitPrice multiset will surface the failure.
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/quantity|unitPrice/i);
	});
});

// =====================================================================
// PR2 Batch 3 — transcription oracle wiring tests.
//
// Each test wires the new `transcriptionFixture` payload field plus a YAML
// transcription + SHA sidecar on disk. The runner is expected to:
//   - emit a labeled 'structural' verdict (existing behavior)
//   - emit a labeled 'transcription' verdict (new in Batch 3)
//   - aggregate set-based: any 'error' → 'error', else any 'fail' → 'fail',
//     else 'pass'
//   - skip the transcription oracle entirely when `sidecar.expectRejection` is
//     true
//   - emit a `'transcription'` verdict with verdict='error' when the YAML
//     file is referenced but missing OR when the SHA sidecar disagrees
// =====================================================================

import {
	makeCaseWithTranscription,
	stageTranscription as stageTranscriptionIn,
} from './_buildcase-helper.js';

async function stageTranscription(
	baseName: string,
	transcription: Record<string, unknown>,
	shaMode: 'matching' | 'mismatching' = 'matching',
): Promise<string> {
	return stageTranscriptionIn(tempDir, baseName, transcription, shaMode);
}

describe('runReceiptCase — transcription oracle (Batch 3)', () => {
	it('1. PASS: oracleVerdicts has both labels, both pass (happy path)', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart-happy', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 8.48,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'Milk', totalPrice: 3.49 },
			],
		});
		const trxPath = await stageTranscription('walmart-happy', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 8.48,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99, confidence: 'high' },
				{ name: 'Milk', totalPrice: 3.49, confidence: 'high' },
			],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
						{ name: 'Milk', quantity: 1, unitPrice: 3.49, totalPrice: 3.49 },
					],
					subtotal: 8.48,
					tax: 0,
					total: 8.48,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, trxPath, 'happy'),
			deps,
		);
		expect(result.verdict).toBe('pass');
		const structuralEntry = result.oracleVerdicts.find((v) => v.label === 'structural');
		const transcriptionEntry = result.oracleVerdicts.find((v) => v.label === 'transcription');
		expect(structuralEntry).toBeDefined();
		expect(structuralEntry?.verdict).toBe('pass');
		expect(transcriptionEntry).toBeDefined();
		expect(transcriptionEntry?.verdict).toBe('pass');
	});

	it('2. FAIL when structural passes but transcription fails (drift resistance)', async () => {
		// Parser output matches the sidecar AND adds a hallucinated item that's
		// not in the transcription. Sidecar is intentionally lax (no lineItems
		// or weaker line-items list) so structural passes; transcription
		// catches the hallucination.
		const photoPath = await stagePhoto('drift');
		const sidecarPath = await stageSidecar('drift', {
			// No lineItems on sidecar — only total. Structural oracle will pass.
			store: 'Walmart',
			date: '2026-04-15',
			total: 10.0,
		});
		const trxPath = await stageTranscription('drift', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 10.0,
			lineItems: [{ name: 'Eggs', totalPrice: 10.0, confidence: 'high' }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 10.0, totalPrice: 10.0 },
						// Hallucinated — not in transcription. Structural won't
						// notice because sidecar.lineItems is empty.
						{ name: 'Truffle Oil', quantity: 1, unitPrice: 80.0, totalPrice: 80.0 },
					],
					subtotal: 10.0,
					tax: 0,
					total: 10.0,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, trxPath, 'drift'),
			deps,
		);
		expect(result.verdict).toBe('fail');
		const structuralEntry = result.oracleVerdicts.find((v) => v.label === 'structural');
		const transcriptionEntry = result.oracleVerdicts.find((v) => v.label === 'transcription');
		expect(structuralEntry?.verdict).toBe('pass');
		expect(transcriptionEntry?.verdict).toBe('fail');
		expect(transcriptionEntry?.details ?? '').toMatch(/truffle|hallucinated/i);
	});

	it('3. FAIL when transcription passes but structural fails', async () => {
		// Sidecar diverges (e.g., expects an extra line item) while the
		// transcription matches the parser output exactly.
		const photoPath = await stagePhoto('struct-fail');
		const sidecarPath = await stageSidecar('struct-fail', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				// Extra item — sidecar (ground truth) expects 2 items; parser
				// emits only 1. Multiset oracle catches the missing one.
				{ name: 'Milk', totalPrice: 3.49 },
			],
		});
		const trxPath = await stageTranscription('struct-fail', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99, confidence: 'high' }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
					subtotal: 4.99,
					tax: 0,
					total: 4.99,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, trxPath, 'struct-fail'),
			deps,
		);
		expect(result.verdict).toBe('fail');
		const structuralEntry = result.oracleVerdicts.find((v) => v.label === 'structural');
		const transcriptionEntry = result.oracleVerdicts.find((v) => v.label === 'transcription');
		expect(structuralEntry?.verdict).toBe('fail');
		expect(transcriptionEntry?.verdict).toBe('pass');
		expect(structuralEntry?.details ?? '').toMatch(/milk/i);
	});

	it('4. FAIL with both verdicts populated when both oracles fail', async () => {
		// Parser diverges from BOTH sidecar AND transcription in different ways.
		const photoPath = await stagePhoto('both-fail');
		const sidecarPath = await stageSidecar('both-fail', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const trxPath = await stageTranscription('both-fail', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99, confidence: 'high' }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					// Same hallucinated item present in BOTH sidecar diff and
					// transcription diff — structural fails (extra item),
					// transcription fails (hallucinated item).
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
						{ name: 'Caviar', quantity: 1, unitPrice: 200.0, totalPrice: 200.0 },
					],
					subtotal: 204.99,
					tax: 0,
					total: 204.99,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, trxPath, 'both-fail'),
			deps,
		);
		expect(result.verdict).toBe('fail');
		const structuralEntry = result.oracleVerdicts.find((v) => v.label === 'structural');
		const transcriptionEntry = result.oracleVerdicts.find((v) => v.label === 'transcription');
		expect(structuralEntry?.verdict).toBe('fail');
		expect(transcriptionEntry?.verdict).toBe('fail');
	});

	it('5. skips transcription oracle when sidecar declares expectRejection:true', async () => {
		// expectRejection sidecars route the parser through the
		// `isValidReceiptDate` rejection branch; transcription doesn't apply.
		const photoPath = await stagePhoto('reject');
		const sidecarPath = await stageSidecar('reject-skip', {
			expectRejection: true,
			store: 'Wegmans Food Markets',
		});
		// Even though we provide a transcription fixture path, the runner
		// must NOT invoke the transcription oracle.
		const trxPath = await stageTranscription('reject-skip', {
			store: 'Wegmans Food Markets',
			total: 2.49,
			lineItems: [{ name: 'Bananas', totalPrice: 2.49, confidence: 'high' }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Wegmans Food Markets',
					date: '2099-12-31',
					lineItems: [{ name: 'Bananas', quantity: 1, unitPrice: 2.49, totalPrice: 2.49 }],
					subtotal: 2.49,
					tax: 0,
					total: 2.49,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, trxPath, 'reject-skip'),
			deps,
		);
		const labels = result.oracleVerdicts.map((v) => v.label);
		expect(labels).not.toContain('transcription');
		// structural still ran
		expect(labels).toContain('structural');
	});

	it('6. ERROR when transcription file is referenced but missing (fail-closed)', async () => {
		const photoPath = await stagePhoto('missing-trx');
		const sidecarPath = await stageSidecar('missing-trx', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		// Path that does NOT exist on disk.
		const missingPath = join(tempDir, 'does-not-exist.transcription.yaml');
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
					subtotal: 4.99,
					tax: 0,
					total: 4.99,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, missingPath, 'missing'),
			deps,
		);
		expect(result.verdict).toBe('error');
		const transcriptionEntry = result.oracleVerdicts.find((v) => v.label === 'transcription');
		expect(transcriptionEntry).toBeDefined();
		expect(transcriptionEntry?.verdict).toBe('error');
		expect(transcriptionEntry?.details ?? '').toMatch(/load failed|cannot stat|does-not-exist/i);
	});

	it('7. ERROR on SHA mismatch (fail-closed)', async () => {
		const photoPath = await stagePhoto('sha-mismatch');
		const sidecarPath = await stageSidecar('sha-mismatch', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		// Author the YAML with a deliberately-bad SHA sidecar.
		const trxPath = await stageTranscription(
			'sha-mismatch',
			{
				store: 'Walmart',
				date: '2026-04-15',
				total: 4.99,
				lineItems: [{ name: 'Eggs', totalPrice: 4.99, confidence: 'high' }],
			},
			'mismatching',
		);
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
					subtotal: 4.99,
					tax: 0,
					total: 4.99,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, trxPath, 'sha-mismatch'),
			deps,
		);
		expect(result.verdict).toBe('error');
		const transcriptionEntry = result.oracleVerdicts.find((v) => v.label === 'transcription');
		expect(transcriptionEntry?.verdict).toBe('error');
		expect(transcriptionEntry?.details ?? '').toMatch(/sha256/i);
	});

	it('8. charges budget only once per dispatch even with two oracles', async () => {
		// Both oracles are pure / no LLM. Cost should reflect exactly one
		// parser dispatch, not two.
		const photoPath = await stagePhoto('budget-once');
		const sidecarPath = await stageSidecar('budget-once', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const trxPath = await stageTranscription('budget-once', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99, confidence: 'high' }],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
				subtotal: 4.99,
				tax: 0,
				total: 4.99,
			}),
		);
		const deps = makeReceiptDeps(llmShimFromMock(llmComplete));
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, trxPath, 'budget-once'),
			deps,
		);
		expect(result.verdict).toBe('pass');
		// One parser call → one charge of the estimated $0.02 (see makeReceiptDeps).
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(result.costUsd).toBeCloseTo(0.02, 4);
	});

	it('9. error verdict precedence — error trumps fail when both occur on the same input', async () => {
		// Order-of-aggregation guard: a structural fail + a transcription
		// error must yield case verdict 'error' (set-based AND with error
		// dominant), not 'fail'.
		const photoPath = await stagePhoto('err-precedence');
		// Sidecar diverges (structural will fail) — extra item it expects.
		const sidecarPath = await stageSidecar('err-precedence', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'NotEmitted', totalPrice: 1.0 },
			],
		});
		// Transcription file references a nonexistent path → error from loader.
		const missingPath = join(tempDir, 'err-precedence.missing.transcription.yaml');
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
					subtotal: 4.99,
					tax: 0,
					total: 4.99,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, missingPath, 'err-prec'),
			deps,
		);
		expect(result.verdict).toBe('error');
		const structuralEntry = result.oracleVerdicts.find((v) => v.label === 'structural');
		const transcriptionEntry = result.oracleVerdicts.find((v) => v.label === 'transcription');
		expect(structuralEntry?.verdict).toBe('fail');
		expect(transcriptionEntry?.verdict).toBe('error');
	});

	it('10. omits transcription label entirely when payload.transcriptionFixture is undefined', async () => {
		// Backwards-compat: a receipt case without a transcription file must
		// continue to work — runner emits only the 'structural' verdict.
		const photoPath = await stagePhoto('no-trx');
		const sidecarPath = await stageSidecar('no-trx', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const deps = makeReceiptDeps(
			llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
					subtotal: 4.99,
					tax: 0,
					total: 4.99,
				}),
			),
		);
		const result = await runReceiptCase(
			makeCaseWithTranscription(photoPath, sidecarPath, undefined, 'no-trx'),
			deps,
		);
		expect(result.verdict).toBe('pass');
		const labels = result.oracleVerdicts.map((v) => v.label);
		expect(labels).toContain('structural');
		expect(labels).not.toContain('transcription');
	});
});

describe('combineVerdicts', () => {
	it.each([
		['pass', 'pass', 'pass'],
		['pass', 'fail', 'fail'],
		['fail', 'pass', 'fail'],
		['pass', 'error', 'error'],
		['error', 'pass', 'error'],
		['fail', 'error', 'error'],
		['error', 'fail', 'error'],
	])('combine(%s, %s) === %s', (a, b, expected) => {
		expect(combineVerdicts(a as Verdict, b as Verdict)).toBe(expected);
	});
});
