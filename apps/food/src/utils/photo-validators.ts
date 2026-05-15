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
