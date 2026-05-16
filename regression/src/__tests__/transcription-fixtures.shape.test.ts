import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTranscription } from '../cases/receipt/transcription-loader.js';
import type { ReceiptTranscription } from '../types/transcription.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(here, '../../fixtures/receipts');
const FIXTURES = ['costco-long', 'trader-joes-correction', 'trader-joes-long', 'trader-joes-short'] as const;

describe.each(FIXTURES)('%s.transcription.yaml', (name) => {
	const yamlPath = resolve(FIXTURES_DIR, `${name}.transcription.yaml`);
	const shaPath = resolve(FIXTURES_DIR, `${name}.transcription.sha256`);

	let trx: ReceiptTranscription;
	beforeAll(() => {
		trx = loadTranscription(yamlPath);
	});

	it('yaml file exists', () => {
		expect(existsSync(yamlPath)).toBe(true);
	});
	it('sha256 sidecar exists', () => {
		expect(existsSync(shaPath)).toBe(true);
	});

	it('sha256 matches yaml content', () => {
		// Re-reads from disk to verify integrity, not just shape — independent
		// of the cached `loadTranscription` result.
		const yaml = readFileSync(yamlPath, 'utf8');
		const expected = readFileSync(shaPath, 'utf8').trim();
		const actual = createHash('sha256').update(yaml).digest('hex');
		expect(actual).toBe(expected);
	});

	it('loads via loadTranscription without error', () => {
		expect(() => loadTranscription(yamlPath)).not.toThrow();
	});

	it('has at least one high-confidence line item', () => {
		expect(trx.lineItems.some((li) => li.confidence === 'high')).toBe(true);
	});

	it('sum of line-item totalPrice equals subtotal within $0.01 (when subtotal present)', () => {
		if (trx.subtotal !== undefined) {
			const sum = trx.lineItems.reduce((acc, li) => acc + li.totalPrice, 0);
			expect(Math.abs(sum - trx.subtotal)).toBeLessThanOrEqual(0.011);
		}
	});

	it('subtotal + tax equals total within $0.01 (when both subtotal and tax present)', () => {
		if (trx.subtotal !== undefined && trx.tax !== undefined) {
			expect(Math.abs(trx.subtotal + trx.tax - trx.total)).toBeLessThanOrEqual(0.011);
		}
	});
});

describe('per-fixture invariants', () => {
	it('costco-long: 23 line items, includes negative discount line', () => {
		const trx = loadTranscription(resolve(FIXTURES_DIR, 'costco-long.transcription.yaml'));
		expect(trx.lineItems).toHaveLength(23);
		expect(trx.lineItems.some((li) => li.totalPrice < 0)).toBe(true);
	});

	it('trader-joes-long: contains a multiplier item (quantity > 1)', () => {
		const trx = loadTranscription(resolve(FIXTURES_DIR, 'trader-joes-long.transcription.yaml'));
		expect(trx.lineItems.some((li) => li.quantity !== undefined && li.quantity > 1)).toBe(true);
	});

	it('trader-joes-long: omits date (cropped photo)', () => {
		expect(loadTranscription(resolve(FIXTURES_DIR, 'trader-joes-long.transcription.yaml')).date).toBeUndefined();
	});

	it('trader-joes-short: omits date (cropped photo)', () => {
		expect(loadTranscription(resolve(FIXTURES_DIR, 'trader-joes-short.transcription.yaml')).date).toBeUndefined();
	});

	it('trader-joes-short: exactly 10 line items, includes duplicates of CROISSANTS 4 CHOCOLATE', () => {
		const trx = loadTranscription(resolve(FIXTURES_DIR, 'trader-joes-short.transcription.yaml'));
		expect(trx.lineItems).toHaveLength(10);
		const croissants = trx.lineItems.filter((li) => li.name === 'CROISSANTS 4 CHOCOLATE');
		expect(croissants).toHaveLength(2);
	});
});

describe('cross-reference with .expected.json (Codex #12)', () => {
	it.each(FIXTURES)('%s: every high-confidence transcription name appears in .expected.json (byte-exact)', (name) => {
		const trx = loadTranscription(resolve(FIXTURES_DIR, `${name}.transcription.yaml`));
		const expectedRaw = readFileSync(resolve(FIXTURES_DIR, `${name}.expected.json`), 'utf8');
		const expected = JSON.parse(expectedRaw) as { lineItems: Array<{ name: string }> };
		const expectedNames = new Set(expected.lineItems.map((li) => li.name));
		for (const li of trx.lineItems) {
			if (li.confidence === 'high') {
				expect(
					expectedNames.has(li.name),
					`'${li.name}' from ${name}.transcription.yaml not in ${name}.expected.json`,
				).toBe(true);
			}
		}
	});
});
