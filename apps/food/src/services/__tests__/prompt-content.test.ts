/**
 * Prompt-content assertions for unit-price normalization.
 *
 * REQ-FOOD-PRICE-003.4: receipt and price-update LLM prompts must instruct the
 * model to emit a parseable size token, and the receipt prompt must include the
 * packageSize field in its line-item schema.
 */

import { describe, expect, it } from 'vitest';
import { NORMALIZE_PROMPT, PARSE_PRICE_PROMPT } from '../price-store.js';
import { buildReceiptPrompt } from '../receipt-parser.js';

describe('NORMALIZE_PROMPT (REQ-FOOD-PRICE-003.4)', () => {
	it('mentions parseable size tokens', () => {
		expect(NORMALIZE_PROMPT).toMatch(/parseable/i);
	});

	it('lists recognized units', () => {
		// Spot-check the recognized-unit list is documented.
		expect(NORMALIZE_PROMPT).toContain('oz');
		expect(NORMALIZE_PROMPT).toContain('gal');
		expect(NORMALIZE_PROMPT).toContain('ct');
		expect(NORMALIZE_PROMPT).toContain('lb');
		expect(NORMALIZE_PROMPT).toContain('ml');
	});
});

describe('PARSE_PRICE_PROMPT (REQ-FOOD-PRICE-003.4)', () => {
	it('mentions parseable size tokens', () => {
		expect(PARSE_PRICE_PROMPT).toMatch(/parseable/i);
	});

	it('lists recognized units', () => {
		expect(PARSE_PRICE_PROMPT).toContain('oz');
		expect(PARSE_PRICE_PROMPT).toContain('gal');
		expect(PARSE_PRICE_PROMPT).toContain('ct');
		expect(PARSE_PRICE_PROMPT).toContain('lb');
		expect(PARSE_PRICE_PROMPT).toContain('ml');
	});
});

describe('buildReceiptPrompt (REQ-FOOD-PRICE-003.4)', () => {
	it('includes the packageSize field in the line-item schema', () => {
		const prompt = buildReceiptPrompt('2026-05-07');
		expect(prompt).toContain('packageSize');
	});

	it('mentions parseable token guidance for packageSize', () => {
		const prompt = buildReceiptPrompt('2026-05-07');
		expect(prompt).toMatch(/parseable/i);
	});

	it('preserves the today-date instruction', () => {
		expect(buildReceiptPrompt('2026-05-07')).toContain('Today is 2026-05-07');
	});
});
