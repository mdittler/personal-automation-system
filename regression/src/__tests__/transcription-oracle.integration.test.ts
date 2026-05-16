/**
 * PR2 Batch 5 — adversarial-persona integration tests.
 *
 * Drives the real `runReceiptCase` pipeline (production
 * `parseReceiptFromPhoto` + structural oracle + transcription oracle +
 * set-based aggregation) against the REAL `costco-long` fixture, varying
 * only the parser output via an LLM stub.
 *
 * Each scenario crafts a `ParsedReceipt` shape FROM the loaded transcription
 * (Codex #12: single source of truth for line-item names) and mutates it to
 * simulate a specific persona of LLM misbehavior. The case asserts the
 * aggregate verdict and, for `expectMatch` scenarios, the transcription
 * oracle's diagnostic substring.
 *
 * The structural oracle's `multisetRows` uses strict byte-equal name match;
 * the transcription oracle's `lineSatisfies` lower-cases and trims+collapses
 * whitespace. Scenarios 5 (lowercase) and 6 (collapsed whitespace) therefore
 * fail structural even though transcription passes — the aggregate verdict
 * is `'fail'`. This documents and locks the divergence; if structural is
 * later relaxed to be case-/whitespace-insensitive, these scenarios will
 * need their expected verdict updated to `'pass'`.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReceiptCase } from '../runner/case-runners/receipt-runner.js';
import { loadTranscription } from '../cases/receipt/transcription-loader.js';
import type { ParsedReceipt } from '@food/services/receipt-parser.js';
import {
	REAL_FIXTURES_DIR,
	buildCase,
	findStructuralVerdict,
	findTranscriptionVerdict,
} from './_buildcase-helper.js';

const COSTCO_TRX = loadTranscription(
	resolve(REAL_FIXTURES_DIR, 'costco-long.transcription.yaml'),
);

/**
 * Build a happy-path `ParsedReceipt` shape from the loaded transcription —
 * the SAME names + prices the operator hand-verified. Quantities default to
 * 1 and unitPrice defaults to `totalPrice` (or null when the line is a
 * negative-priced discount). Mutators clone this object before mutating so
 * scenarios stay independent.
 */
function happyParsed(): ParsedReceipt {
	return {
		store: COSTCO_TRX.store ?? 'Costco',
		date: COSTCO_TRX.date ?? '2026-04-27',
		lineItems: COSTCO_TRX.lineItems.map((li) => ({
			name: li.name,
			quantity: li.quantity ?? 1,
			unitPrice:
				li.unitPrice === undefined
					? li.totalPrice < 0
						? null
						: li.totalPrice
					: (li.unitPrice as number | null),
			totalPrice: li.totalPrice,
		})),
		// Costco transcription has subtotal/tax; cast through `?? null` so the
		// ParsedReceipt shape is satisfied even when the YAML omits them.
		subtotal: COSTCO_TRX.subtotal ?? null,
		tax: COSTCO_TRX.tax ?? null,
		total: COSTCO_TRX.total,
	};
}

type Mutator = (p: ParsedReceipt) => ParsedReceipt;

interface Scenario {
	name: string;
	mutator: Mutator;
	expected: 'pass' | 'fail';
	expectMatch?: RegExp;
}

const SCENARIOS: Scenario[] = [
	// --- HAPPY PATH (#1) ---
	{
		name: 'oracle passes when stub returns exactly the transcription',
		mutator: (p) => p,
		expected: 'pass',
	},

	// --- PRIMARY DRIFT SCENARIO (#2) ---
	// drop-last + inflate-second-last by the same amount: the LLM appears to
	// "balance the books" by inflating an earlier item to cover a dropped one.
	// PR2's whole point is catching this.
	{
		name: 'drop-last-item + inflate-second-last-by-same-amount (drift resistance)',
		mutator: (p) => {
			const dropped = p.lineItems.pop();
			if (!dropped) return p;
			const tail = p.lineItems[p.lineItems.length - 1];
			if (!tail) return p;
			tail.totalPrice += dropped.totalPrice;
			tail.unitPrice = tail.totalPrice;
			return p;
		},
		expected: 'fail',
		expectMatch: /missing high-confidence|hallucinated/i,
	},

	// --- FULL SELF-CONSISTENT FUDGE (#3) ---
	// Drop the last item; inflate lineItems[0] by the same amount so the
	// subtotal/tax/total still tie. The transcription oracle's name-aware
	// matcher catches both the missing PE GRANOLA and the inflated SPINDRIFT.
	{
		name: 'full self-consistent fudge: drop + inflate (subtotal/tax remain matching)',
		mutator: (p) => {
			const dropped = p.lineItems.pop();
			if (!dropped) return p;
			const head = p.lineItems[0];
			if (!head) return p;
			head.totalPrice += dropped.totalPrice;
			head.unitPrice = head.totalPrice;
			return p;
		},
		expected: 'fail',
	},

	// --- HALLUCINATIONS (#4) ---
	{
		name: 'parser hallucinates an extra line item',
		mutator: (p) => {
			p.lineItems.push({ name: 'GHOST TAX', quantity: 1, unitPrice: 5, totalPrice: 5 });
			return p;
		},
		expected: 'fail',
		expectMatch: /hallucinated/i,
	},

	// --- NAME VARIATION (#5–#7) ---
	// #5 — structural's `multisetRows.keyField` uses strict byte equality on
	// name. Even though the transcription oracle normalizes case+whitespace
	// and would pass, structural fails, so the aggregate verdict is 'fail'.
	// This is documented intentional behavior; see the file-level comment.
	{
		name: 'parser uses lowercase names — fails on structural strict-byte name match',
		mutator: (p) => {
			p.lineItems = p.lineItems.map((li) => ({ ...li, name: li.name.toLowerCase() }));
			return p;
		},
		expected: 'fail',
	},
	{
		name: 'parser collapses single-spaces into triple-spaces in names — fails on structural strict-byte name match',
		mutator: (p) => {
			p.lineItems = p.lineItems.map((li) => ({
				...li,
				name: li.name.replace(/ /g, '   '),
			}));
			return p;
		},
		expected: 'fail',
	},
	{
		name: 'parser typos an item name — fails (no fuzzy matching)',
		mutator: (p) => {
			const first = p.lineItems[0];
			if (first) first.name = `${first.name}X`;
			return p;
		},
		expected: 'fail',
	},

	// --- DROPPED LINE (#8) ---
	// costco-long has no multiplier lines (each unit prints on its own line),
	// so the "collapse multiplier" persona doesn't have a target to mutate.
	// Replace with the equally-real persona: parser drops a non-last line
	// item entirely. Both oracles catch this as a missing item.
	{
		name: 'parser drops a non-last line item entirely — fails on missing transcription line',
		mutator: (p) => {
			// Splice out item at index 7 (KS VANILLA $9.99) — well inside the
			// list, not adjacent to the duplicate-PE-GRANOLA tail.
			p.lineItems.splice(7, 1);
			return p;
		},
		expected: 'fail',
		expectMatch: /missing high-confidence/i,
	},

	// --- DUPLICATE EXPANSION (#9) ---
	{
		name: 'parser expands single-item into duplicate — fails on hallucinated duplicate',
		mutator: (p) => {
			const first = p.lineItems[0];
			if (!first) return p;
			p.lineItems.push({ ...first });
			return p;
		},
		expected: 'fail',
	},

	// --- DUPLICATE PRESERVATION (#10) ---
	{
		name: 'parser correctly preserves all line-items including duplicate PE GRANOLA',
		mutator: (p) => p,
		expected: 'pass',
	},

	// --- DUPLICATE COLLAPSE (#11) ---
	// Two PE GRANOLA $10.99 lines in the transcription. Collapsing them into
	// one parser line drops one — the multiset oracle catches the missing
	// duplicate.
	{
		name: 'parser deduplicates two identical line items into one',
		mutator: (p) => {
			const seen = new Set<string>();
			p.lineItems = p.lineItems.filter((li) => {
				const k = `${li.name}|${li.totalPrice}`;
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			});
			return p;
		},
		expected: 'fail',
	},

	// --- DISCOUNT LINES (#12–#13) ---
	{
		name: 'parser correctly preserves the negative discount lines',
		mutator: (p) => p,
		expected: 'pass',
	},
	{
		name: 'parser drops the negative discount lines — fails',
		mutator: (p) => {
			p.lineItems = p.lineItems.filter((li) => li.totalPrice >= 0);
			return p;
		},
		expected: 'fail',
		expectMatch: /missing high-confidence/i,
	},

	// --- AGGREGATE FUDGING (#14–#15) ---
	// These scenarios prove the transcription oracle's distinct value: the
	// structural oracle would catch them too (the sidecar carries subtotal +
	// tax), but if a future scenario omitted them from the sidecar, the
	// transcription oracle's separate subtotal/tax assertions would still
	// trip. The regex matches the transcription oracle's diagnostic.
	{
		name: 'parser line-items correct but subtotal off by $0.50 — fails',
		mutator: (p) => {
			if (p.subtotal !== null) p.subtotal += 0.5;
			return p;
		},
		expected: 'fail',
		expectMatch: /subtotal/i,
	},
	{
		name: 'parser line-items correct but tax differs by $0.80 — fails',
		mutator: (p) => {
			if (p.tax !== null) p.tax += 0.8;
			return p;
		},
		expected: 'fail',
		expectMatch: /tax/i,
	},
];

describe.each(SCENARIOS)('transcription oracle integration — $name', (scenario) => {
	it(`case verdict is ${scenario.expected}`, async () => {
		// Clone the baseline before mutating so scenarios stay independent.
		const baseParsed = happyParsed();
		const stubParsed = scenario.mutator(
			JSON.parse(JSON.stringify(baseParsed)) as ParsedReceipt,
		);

		const { case_, deps } = buildCase({
			useRealFixture: 'costco-long',
			stubParsed,
			idSuffix: scenario.name.slice(0, 16).replace(/[^a-z0-9]/gi, '-'),
		});
		const result = await runReceiptCase(case_, deps);

		// Both oracles run (transcription is gated on
		// `!sidecar.expectRejection`; costco-long isn't a rejection case).
		const structuralEntry = findStructuralVerdict(result);
		const transcriptionEntry = findTranscriptionVerdict(result);
		expect(structuralEntry, 'structural verdict must be emitted').toBeDefined();
		expect(transcriptionEntry, 'transcription verdict must be emitted').toBeDefined();

		expect(
			result.verdict,
			`aggregate verdict mismatch — structural=${structuralEntry?.verdict} (${structuralEntry?.details ?? '—'}); transcription=${transcriptionEntry?.verdict} (${transcriptionEntry?.details ?? '—'})`,
		).toBe(scenario.expected);

		if (scenario.expectMatch) {
			expect(transcriptionEntry?.details ?? '').toMatch(scenario.expectMatch);
		}
	});
});
