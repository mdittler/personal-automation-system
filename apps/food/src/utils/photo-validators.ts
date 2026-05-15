/**
 * Runtime type guards for photo parser LLM outputs.
 *
 * LLM output must be treated as untrusted data. These guards filter malformed
 * items from photo parsers before they are persisted to data stores.
 */

/** Guard for pantry photo items. Rejects missing/non-string names. */
export function isValidPantryPhotoItem(
	item: unknown,
): item is { name: string; quantity: string; category: string } {
	if (!item || typeof item !== 'object') return false;
	const record = item as Record<string, unknown>;
	return typeof record.name === 'string' && record.name.trim() !== '';
}

/**
 * Guard for grocery photo items. Rejects missing/non-string names.
 * Quantity is coerced to null if absent or non-number (nullable field).
 * If quantity is present and not a finite number, the item is rejected.
 */
export function isValidGroceryPhotoItem(
	item: unknown,
): item is { name: string; quantity: number | null; unit: string | null } {
	if (!item || typeof item !== 'object') return false;
	const record = item as Record<string, unknown>;
	if (typeof record.name !== 'string' || record.name.trim() === '') return false;
	// Quantity must be absent, null, or a finite number
	const q = record.quantity;
	if (q !== undefined && q !== null && (typeof q !== 'number' || !Number.isFinite(q))) {
		return false;
	}
	// Unit must be absent, null, or a string
	const u = record.unit;
	if (u !== undefined && u !== null && typeof u !== 'string') return false;
	return true;
}

/**
 * Guard for receipt line items. Rejects missing/non-string names and invalid totalPrice.
 *
 * Negative `totalPrice` is ALLOWED — real receipts include discounts, coupons,
 * returns, and bottle deposits, which print as negative line items (the printed
 * total still ties out because subtotal is the signed sum). The aggregate
 * `subtotal`/`tax`/`total` fields are validated separately by
 * `isValidReceiptAmount` and remain non-negative.
 *
 * `packageSize` is optional: handled by `normalizeReceiptLineItem`.
 */
export function isValidReceiptLineItem(item: unknown): item is {
	name: string;
	quantity?: number | null;
	unitPrice?: number | null;
	totalPrice: number;
	packageSize?: string | null;
} {
	if (!item || typeof item !== 'object') return false;
	const record = item as Record<string, unknown>;
	if (typeof record.name !== 'string' || record.name.trim() === '') return false;
	const price = record.totalPrice;
	if (typeof price !== 'number' || !Number.isFinite(price)) return false;
	return true;
}

/**
 * Normalise a receipt line item that has already passed `isValidReceiptLineItem`.
 *
 * - `quantity`: non-finite or missing → 1 (single-unit line). Valid finite values preserved.
 * - `unitPrice`: non-finite or missing → null. Valid finite values (including 0 and
 *   negatives for discount lines) preserved.
 * - `packageSize`: non-empty trimmed string preserved; anything else → null.
 *
 * Returns a new object; does not mutate the input.
 */
export function normalizeReceiptLineItem<
	T extends {
		quantity?: unknown;
		unitPrice?: unknown;
		packageSize?: string | null | undefined;
	},
>(item: T): T & { quantity: number; unitPrice: number | null; packageSize: string | null } {
	const rawQuantity = item.quantity;
	const quantity =
		typeof rawQuantity === 'number' && Number.isFinite(rawQuantity) ? rawQuantity : 1;

	const rawUnitPrice = item.unitPrice;
	const unitPrice =
		typeof rawUnitPrice === 'number' && Number.isFinite(rawUnitPrice) ? rawUnitPrice : null;

	const ps = item.packageSize;
	const packageSize = typeof ps === 'string' && ps.trim() !== '' ? ps.trim() : null;

	return { ...item, quantity, unitPrice, packageSize };
}

/** Guard for receipt top-level numeric totals (total, subtotal, tax). */
export function isValidReceiptAmount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// ─── Receipt integrity check (Batch 3) ──────────────────────────────────────

import type { LLMFinishReason } from '@pas/core/types';
import type { ReceiptLineItem, ReceiptVerificationWarning } from '../types.js';

/** Strict threshold: $1 absolute AND 1% relative to the reference. */
const SUM_ABS_TOLERANCE_USD = 1.0;
/** Strict relative tolerance when comparing against subtotal or total-tax (1%). */
const SUM_REL_TOLERANCE = 0.01;
/** Loose relative tolerance when only `total` is available (2%). */
const SUM_REL_TOLERANCE_LOOSE = 0.02;
/** Per-line `|quantity * unitPrice - totalPrice|` allowance for rounding. */
const LINE_ARITHMETIC_TOLERANCE_USD = 0.5;

/**
 * Post-parse integrity check for a receipt.
 *
 * Surfaces deterministic, low-cost warnings the parser can detect without
 * external ground truth:
 *   - `output_truncated`: the LLM call ran out of output tokens.
 *   - `sum_mismatch`: line items don't tie to subtotal (or fallback reference).
 *   - `line_arithmetic_mismatch`: a single line's q·u doesn't match its total.
 *
 * **Documented limitation**: a model that fudges `unitPrice` AND `totalPrice`
 * AND `subtotal` consistently (e.g. drops one item and inflates another so
 * the printed total still ties) will pass every check here. The user
 * observed exactly this in production. The regression suite's
 * transcription-based multiset oracle is the primary defense; see
 * `regression/src/oracles/structural.ts` and the corresponding URS rows.
 *
 * Reference chain for sum check (in priority order):
 *   1. `subtotal` if present (strict tolerance)
 *   2. `total - tax` if both present (strict tolerance)
 *   3. `total` alone (loose 2% tolerance — receipts with no subtotal/tax
 *      usually print a single combined total whose precision is lower)
 */
export function validateReceiptIntegrity(
	parsed: {
		lineItems: ReceiptLineItem[];
		subtotal: number | null;
		tax: number | null;
		total: number;
	},
	finishReason: LLMFinishReason,
): ReceiptVerificationWarning[] {
	const warnings: ReceiptVerificationWarning[] = [];

	if (finishReason === 'length') {
		warnings.push('output_truncated');
	}

	if (parsed.lineItems.length > 0) {
		const sum = parsed.lineItems.reduce((acc, li) => acc + li.totalPrice, 0);

		let reference: number | null = null;
		let relTolerance = SUM_REL_TOLERANCE;
		if (parsed.subtotal != null) {
			reference = parsed.subtotal;
		} else if (parsed.tax != null && Number.isFinite(parsed.total)) {
			reference = parsed.total - parsed.tax;
		} else if (Number.isFinite(parsed.total)) {
			reference = parsed.total;
			relTolerance = SUM_REL_TOLERANCE_LOOSE;
		}

		if (reference != null) {
			const delta = Math.abs(sum - reference);
			const absReference = Math.max(Math.abs(reference), 1);
			if (delta > SUM_ABS_TOLERANCE_USD && delta / absReference > relTolerance) {
				warnings.push('sum_mismatch');
			}
		}
	}

	for (const li of parsed.lineItems) {
		if (
			typeof li.quantity === 'number' &&
			typeof li.unitPrice === 'number' &&
			Number.isFinite(li.quantity) &&
			Number.isFinite(li.unitPrice)
		) {
			const expected = li.quantity * li.unitPrice;
			if (Math.abs(expected - li.totalPrice) > LINE_ARITHMETIC_TOLERANCE_USD) {
				warnings.push('line_arithmetic_mismatch');
				break; // one example is enough
			}
		}
	}

	return warnings;
}
