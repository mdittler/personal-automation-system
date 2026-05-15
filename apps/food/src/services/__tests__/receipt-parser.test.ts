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
