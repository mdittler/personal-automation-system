import { describe, expect, it } from 'vitest';
import type { ReceiptLineItem } from '../../types.js';
import { buildReceiptSummary } from '../photo-summary.js';

function makeItems(count: number): ReceiptLineItem[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `Item ${i + 1}`,
		quantity: 1,
		unitPrice: 1.0 + i * 0.01,
		totalPrice: 1.0 + i * 0.01,
	}));
}

describe('buildReceiptSummary — item inclusion', () => {
	it('includes all items when count is 21 (≤30)', () => {
		const result = buildReceiptSummary({
			store: 'Costco',
			date: '2026-05-01',
			total: 50.0,
			lineItems: makeItems(21),
		});
		for (let i = 1; i <= 21; i++) {
			expect(result.assistantTurn).toContain(`Item ${i}`);
		}
		expect(result.assistantTurn).not.toMatch(/and \d+ more/i);
	});

	it('truncates to 30 and shows "and N more" marker when count > 30', () => {
		const result = buildReceiptSummary({
			store: 'Costco',
			date: '2026-05-01',
			total: 100.0,
			lineItems: makeItems(31),
		});
		for (let i = 1; i <= 30; i++) {
			expect(result.assistantTurn).toContain(`Item ${i}`);
		}
		expect(result.assistantTurn).not.toContain('Item 31');
		expect(result.assistantTurn).toContain('and 1 more');
		expect(result.assistantTurn).toContain('show all items');
	});

	it('includes all items when count is 10 (no truncation)', () => {
		const result = buildReceiptSummary({
			store: 'Test Store',
			date: '2026-05-01',
			total: 20.0,
			lineItems: makeItems(10),
		});
		for (let i = 1; i <= 10; i++) {
			expect(result.assistantTurn).toContain(`Item ${i}`);
		}
		expect(result.assistantTurn).not.toMatch(/and \d+ more/i);
	});
});
