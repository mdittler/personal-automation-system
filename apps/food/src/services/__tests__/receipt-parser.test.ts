/**
 * Focused tests for receipt-parser robustness improvements.
 *
 * Existing happy-path coverage lives in `apps/food/src/__tests__/photo-parsers.test.ts`.
 * This file adds the receipt-specific assertions:
 *   - Anti-reconciliation prompt block (Batch 2)
 *   - maxTokens: 8192 + completeWithMeta (Batch 2)
 *   - Integrity warnings on the returned ParsedReceipt (Batch 3)
 *   - Continuation pass on finishReason=length (Batch 5)
 *
 * The redistribution failure mode (drop one item + inflate another) is
 * intentionally documented as a parser limitation here; the regression
 * suite is the primary defense against that. See validateReceiptIntegrity's
 * JSDoc.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CoreServices } from '@pas/core/types';
import { buildReceiptPrompt, parseReceiptFromPhoto } from '../receipt-parser.js';

const testPhoto = Buffer.from('fake-jpeg-data');
const testMimeType = 'image/jpeg';

function makeServices(llmText: string | string[], finishReasons: ('stop' | 'length' | 'error' | 'other')[] = ['stop']) {
	const texts = Array.isArray(llmText) ? llmText : [llmText];
	const reasons = finishReasons.length === texts.length ? finishReasons : texts.map(() => finishReasons[0] ?? 'stop');
	const completeWithMeta = vi.fn();
	for (let i = 0; i < texts.length; i++) {
		completeWithMeta.mockResolvedValueOnce({ text: texts[i], finishReason: reasons[i] });
	}
	return {
		services: {
			llm: {
				complete: vi.fn(),
				completeWithMeta,
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			timezone: 'UTC',
		} as unknown as CoreServices,
		completeWithMeta,
	};
}

describe('buildReceiptPrompt — anti-reconciliation guidance (REQ-FOOD-RECEIPT-INTEGRITY-001)', () => {
	const prompt = buildReceiptPrompt('2026-05-15');

	it('mentions not adjusting prices', () => {
		expect(prompt.toLowerCase()).toMatch(/do not adjust/);
	});

	it('mentions omitting unreadable items rather than guessing', () => {
		expect(prompt.toLowerCase()).toMatch(/omit/);
	});

	it('explicitly allows the line items not to sum to subtotal', () => {
		expect(prompt.toLowerCase()).toMatch(/not to sum to/);
	});

	it('mentions discount/coupon/return lines (negative totalPrice support)', () => {
		expect(prompt.toLowerCase()).toMatch(/discount|coupon|negative/);
	});
});

describe('parseReceiptFromPhoto — request shape (REQ-FOOD-RECEIPT-INTEGRITY-002)', () => {
	const valid = JSON.stringify({
		store: 'X',
		date: '2026-05-15',
		lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }],
		subtotal: 5,
		tax: 0,
		total: 5,
	});

	it('uses completeWithMeta (NOT complete) so finishReason flows back', async () => {
		const { services, completeWithMeta } = makeServices(valid);
		await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(completeWithMeta).toHaveBeenCalledTimes(1);
		expect((services.llm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
	});

	it('passes maxTokens: 8192 with the standard tier and the photo', async () => {
		const { services, completeWithMeta } = makeServices(valid);
		await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(completeWithMeta).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				tier: 'standard',
				maxTokens: 8192,
				images: [{ data: testPhoto, mimeType: testMimeType }],
			}),
		);
	});
});

describe('parseReceiptFromPhoto — continuation pass (REQ-FOOD-RECEIPT-INTEGRITY-007, -008)', () => {
	const firstTruncatedTwoItems = JSON.stringify({
		store: 'Costco',
		date: '2026-05-15',
		lineItems: [
			{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
			{ name: 'B', quantity: 1, unitPrice: 6, totalPrice: 6 },
		],
		subtotal: 21,
		tax: 0,
		total: 21,
	});
	const continuationOneItem = JSON.stringify({
		lineItems: [{ name: 'C', quantity: 1, unitPrice: 10, totalPrice: 10 }],
	});

	it('fires continuation when first call returns finishReason=length', async () => {
		const { services, completeWithMeta } = makeServices(
			[firstTruncatedTwoItems, continuationOneItem],
			['length', 'stop'],
		);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(completeWithMeta).toHaveBeenCalledTimes(2);
		expect(result.lineItems.map((li) => li.name)).toEqual(['A', 'B', 'C']);
	});

	it('SUCCESSFUL continuation strips output_truncated from warnings', async () => {
		const { services } = makeServices(
			[firstTruncatedTwoItems, continuationOneItem],
			['length', 'stop'],
		);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(result.verification_warnings).toBeUndefined();
	});

	it('UNRESOLVED continuation emits BOTH output_truncated AND continuation_unresolved', async () => {
		// first response: subtotal=50 but only 2 items summing to $11 — sum mismatch
		// continuation: empty
		const firstWithMismatch = JSON.stringify({
			store: 'X',
			date: '2026-05-15',
			lineItems: [
				{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
				{ name: 'B', quantity: 1, unitPrice: 6, totalPrice: 6 },
			],
			subtotal: 50,
			tax: 0,
			total: 50,
		});
		const { services } = makeServices(
			[firstWithMismatch, JSON.stringify({ lineItems: [] })],
			['length', 'stop'],
		);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(result.verification_warnings).toContain('output_truncated');
		expect(result.verification_warnings).toContain('continuation_unresolved');
		expect(result.verification_warnings).toContain('sum_mismatch');
	});

	it('passes the photo through to the continuation call', async () => {
		const { services, completeWithMeta } = makeServices(
			[firstTruncatedTwoItems, continuationOneItem],
			['length', 'stop'],
		);
		await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		const continuationOpts = completeWithMeta.mock.calls[1]?.[1];
		expect(continuationOpts).toMatchObject({
			tier: 'standard',
			maxTokens: 8192,
			images: [{ data: testPhoto, mimeType: testMimeType }],
		});
	});

	it('caps at one retry even when continuation also hits length AND flags the merged result as suspect (Codex P1)', async () => {
		// Continuation extracts the missing $10 item, so post-merge the sum
		// ties out cleanly. But the continuation itself returned finishReason='length',
		// which means there were MORE items past the continuation's cap that the
		// model couldn't emit. The merged result is incomplete by construction.
		const { services, completeWithMeta } = makeServices(
			[firstTruncatedTwoItems, continuationOneItem],
			['length', 'length'],
		);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(completeWithMeta).toHaveBeenCalledTimes(2); // NEVER 3 — hard cap
		// Per REQ-FOOD-RECEIPT-INTEGRITY-008: continuation truncation surfaces
		// both warnings even though sum mismatch resolves.
		expect(result.verification_warnings).toContain('output_truncated');
		expect(result.verification_warnings).toContain('continuation_unresolved');
	});

	it('does NOT fire continuation when first call returns finishReason=stop', async () => {
		const { services, completeWithMeta } = makeServices(firstTruncatedTwoItems, ['stop']);
		await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(completeWithMeta).toHaveBeenCalledTimes(1);
	});

	it('handles malformed continuation JSON gracefully (warnings flagged, no crash)', async () => {
		const { services } = makeServices(
			[firstTruncatedTwoItems, '{ this is not valid json'],
			['length', 'stop'],
		);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(result.lineItems).toHaveLength(2); // only first call's items survive
		// Sum is fine ($11 vs subtotal $21 → delta=$10, 47%) — mismatch persists,
		// so continuation_unresolved + output_truncated both emit
		expect(result.verification_warnings).toContain('continuation_unresolved');
		expect(result.verification_warnings).toContain('output_truncated');
	});

	it('dedupes when continuation repeats items already in the first response', async () => {
		const continuationOverlapping = JSON.stringify({
			lineItems: [
				{ name: 'B', quantity: 1, unitPrice: 6, totalPrice: 6 },
				{ name: 'C', quantity: 1, unitPrice: 10, totalPrice: 10 },
			],
		});
		const { services } = makeServices(
			[firstTruncatedTwoItems, continuationOverlapping],
			['length', 'stop'],
		);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		// B should not be duplicated
		expect(result.lineItems.map((li) => li.name)).toEqual(['A', 'B', 'C']);
	});

	it('preserves duplicate items at DIFFERENT prices across calls (BANANAS $1.77 + BANANAS $2.55)', async () => {
		const firstBanana = JSON.stringify({
			store: 'X',
			date: '2026-05-15',
			lineItems: [{ name: 'BANANAS', quantity: 1, unitPrice: 1.77, totalPrice: 1.77 }],
			subtotal: 4.32,
			tax: 0,
			total: 4.32,
		});
		const continuationBanana = JSON.stringify({
			lineItems: [{ name: 'BANANAS', quantity: 1, unitPrice: 2.55, totalPrice: 2.55 }],
		});
		const { services } = makeServices([firstBanana, continuationBanana], ['length', 'stop']);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		// Both BANANAS preserved — different totalPrice means different multiset entry
		expect(result.lineItems).toHaveLength(2);
		const totals = result.lineItems.map((li) => li.totalPrice).sort();
		expect(totals).toEqual([1.77, 2.55]);
	});
});

describe('parseReceiptFromPhoto — verification_warnings flow (REQ-FOOD-RECEIPT-INTEGRITY-004..-006)', () => {
	it('clean receipt → verification_warnings omitted entirely', async () => {
		const valid = JSON.stringify({
			store: 'X',
			date: '2026-05-15',
			lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }],
			subtotal: 5,
			tax: 0,
			total: 5,
		});
		const { services } = makeServices(valid);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(result.verification_warnings).toBeUndefined();
	});

	it('sum_mismatch surfaces when subtotal does not tie to line items', async () => {
		const mismatched = JSON.stringify({
			store: 'X',
			date: '2026-05-15',
			lineItems: [
				{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
				{ name: 'B', quantity: 1, unitPrice: 11, totalPrice: 11 },
			],
			subtotal: 100,
			tax: 0,
			total: 100,
		});
		const { services } = makeServices(mismatched);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		expect(result.verification_warnings).toContain('sum_mismatch');
	});

	it('SELF-CONSISTENT FUDGING (documented limitation): the exact reported bug shape passes', async () => {
		// User-reported real-world failure: reality was 3 items A=$5, B=$6, C=$10
		// (subtotal $21 printed). The model dropped item C and inflated B's price to
		// $16 so the two remaining items sum to the truthfully-printed subtotal.
		// Per-line arithmetic holds because the model fudged BOTH unitPrice AND
		// totalPrice on the inflated item (q*u still equals total). The aggregate
		// sum ties to the printed subtotal. From the parser's point of view this is
		// a perfectly clean receipt. Only PR2's transcription-based multiset oracle
		// can catch this.
		const fudged = JSON.stringify({
			store: 'X',
			date: '2026-05-15',
			lineItems: [
				{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
				{ name: 'B', quantity: 1, unitPrice: 16, totalPrice: 16 }, // inflated from real $6
			],
			subtotal: 21, // truthfully printed
			tax: 0,
			total: 21,
		});
		const { services } = makeServices(fudged);
		const result = await parseReceiptFromPhoto(services, testPhoto, testMimeType);
		// No warnings emitted — this is the limit of what the parser alone can detect.
		// Documented in docs/open-items.md (accepted risk) and in
		// validateReceiptIntegrity's JSDoc.
		expect(result.verification_warnings).toBeUndefined();
	});
});
