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
	return typeof record['name'] === 'string' && record['name'].trim() !== '';
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
	if (typeof record['name'] !== 'string' || record['name'].trim() === '') return false;
	// Quantity must be absent, null, or a finite number
	const q = record['quantity'];
	if (q !== undefined && q !== null && (typeof q !== 'number' || !Number.isFinite(q))) {
		return false;
	}
	// Unit must be absent, null, or a string
	const u = record['unit'];
	if (u !== undefined && u !== null && typeof u !== 'string') return false;
	return true;
}

/**
 * Guard for receipt line items. Rejects missing/non-string names and invalid totalPrice.
 * `packageSize` is optional: a non-empty string is preserved; anything else (number,
 * boolean, missing, empty) is coerced to null at the call site by checking the field
 * explicitly. The guard itself does not reject items lacking packageSize.
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
	if (typeof record['name'] !== 'string' || record['name'].trim() === '') return false;
	const price = record['totalPrice'];
	if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return false;
	// Coerce packageSize: non-empty string passes through; anything else becomes null.
	const ps = record['packageSize'];
	if (typeof ps === 'string' && ps.trim() !== '') {
		record['packageSize'] = ps.trim();
	} else {
		record['packageSize'] = null;
	}
	return true;
}

/** Guard for receipt top-level numeric totals (total, subtotal, tax). */
export function isValidReceiptAmount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
