/**
 * Generated receipt regression cases.
 *
 * Each entry below produces one `PersonaCase` for the `receipt` bucket. The
 * shared coverage list (`apps/food/src/services/receipt-parser.ts` and the
 * three helpers it calls) plus the per-fixture photo + sidecar paths drive
 * cache invalidation per REQ-REG-002 / REQ-REG-010.
 *
 * Sidecars for the four real-photo fixtures encode hand-verified ground
 * truth; the synthetic `expired-90d` sidecar uses `expectRejection: true` to
 * exercise the parser's `isValidReceiptDate` rejection branch. See
 * `regression/fixtures/receipts/*.true.md` for human-readable transcriptions.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedCase, PersonaCase } from '@core/types/regression.js';

const HERE = fileURLToPath(import.meta.url);
const FIXTURES_DIR = resolve(dirname(HERE), '../../../fixtures/receipts');

const SHARED_COVERAGE: readonly string[] = [
	'apps/food/src/services/receipt-parser.ts',
	'apps/food/src/utils/photo-validators.ts',
	'apps/food/src/utils/sanitize.ts',
	'apps/food/src/utils/date.ts',
];

interface ReceiptFixture {
	slug: string;
	description: string;
}

const FIXTURES: readonly ReceiptFixture[] = [
	{
		slug: 'costco-long',
		description:
			'Costco receipt with 23 line items, two negative-priced discount lines, and dual tax rates (7.5% A / 2.0% E)',
	},
	{
		slug: 'trader-joes-correction',
		description:
			"Trader Joe's receipt with handwritten price-correction annotation overlay; tests OCR robustness against ink-on-thermal",
	},
	{
		slug: 'trader-joes-long',
		description:
			"Trader Joe's 26-line receipt with quantity-multiplier line items and duplicate BROCCOLI CROWNS entries",
	},
	{
		slug: 'trader-joes-short',
		description:
			"Trader Joe's 10-line receipt with mixed tax classes (T-flag) and quantity multipliers on 3 lines",
	},
	{
		slug: 'expired-90d',
		description:
			'Synthetic receipt dated >90 days ago; exercises isValidReceiptDate rejection branch + rawExtractedDate preservation',
	},
];

export function buildCases(): LoadedCase[] {
	return FIXTURES.map((fx) => {
		const photoFixture = join(FIXTURES_DIR, `${fx.slug}.jpg`);
		const sidecarFixture = join(FIXTURES_DIR, `${fx.slug}.expected.json`);
		const c: PersonaCase = {
			id: `receipt-${fx.slug}`,
			description: fx.description,
			bucket: 'receipt',
			coverage: [
				...SHARED_COVERAGE,
				`regression/fixtures/receipts/${fx.slug}.jpg`,
				`regression/fixtures/receipts/${fx.slug}.expected.json`,
			],
			inputs: [
				{
					payload: { photoFixture, sidecarFixture },
					expected: { kind: 'sidecar' },
				},
			],
			oracle: 'structural',
			budgetUsd: 0.05,
		};
		return { case: c, filePath: HERE };
	});
}
