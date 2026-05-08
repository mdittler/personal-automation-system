/**
 * Unit normalization for price comparisons.
 *
 * REQ-FOOD-PRICE-003.x: parses package-size strings (e.g. "12 oz", "1 gal", "60ct")
 * into a canonical base unit (g, ml, or ct) so that per-unit prices can be
 * compared across different package sizes.
 */

export type SizeBase = 'g' | 'ml' | 'ct';

export interface ParsedSize {
	value: number;
	base: SizeBase;
}

// Strict numeric regex: accepts "12", "1.5", "750". Rejects ".5" (no leading digit), "-5", "NaN", "1e3".
const NUMERIC_RE = /^(\d+(?:\.\d+)?)/;

// Order matters: longer/multi-word matches must come before single-word ones
// so that "fl oz" is matched before "oz".
const UNIT_DEFS: Array<{ base: SizeBase; factor: number; pattern: RegExp }> = [
	// Volume — multi-word fl oz first
	{ base: 'ml', factor: 29.5735, pattern: /^fl\.?\s*oz\.?$/i },
	// Mass
	{ base: 'g', factor: 1000, pattern: /^kg$/i },
	{ base: 'g', factor: 453.592, pattern: /^lb$/i },
	{ base: 'g', factor: 28.3495, pattern: /^oz$/i },
	{ base: 'g', factor: 1, pattern: /^g$/i },
	// Volume
	{ base: 'ml', factor: 3785.41, pattern: /^gal$/i },
	{ base: 'ml', factor: 1000, pattern: /^l$/i },
	{ base: 'ml', factor: 1, pattern: /^ml$/i },
	// Count
	{ base: 'ct', factor: 12, pattern: /^dozen$/i },
	{ base: 'ct', factor: 1, pattern: /^ct$/i },
	{ base: 'ct', factor: 1, pattern: /^count$/i },
	{ base: 'ct', factor: 1, pattern: /^pack$/i },
	{ base: 'ct', factor: 1, pattern: /^pk$/i },
];

const MAX_MASS_G = 50_000;
const MAX_VOLUME_ML = 50_000;
const MAX_COUNT = 10_000;

/**
 * Parse a size string into a canonical { value, base } pair.
 *
 * Recognized units:
 * - mass: g, kg, oz, lb
 * - volume: ml, l, fl oz, gal
 * - count: ct, count, pack, pk, dozen
 *
 * Returns null for: empty/whitespace, no numeric part, no unit part,
 * partial parses (extra text after the unit), NaN/Infinity/negative/zero,
 * scientific notation, or values exceeding the per-base max bounds.
 */
export function parseSizeString(input: string): ParsedSize | null {
	if (typeof input !== 'string') return null;
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;

	// Extract the leading numeric token using a strict regex.
	const numericMatch = trimmed.match(NUMERIC_RE);
	if (!numericMatch) return null;
	const numericText = numericMatch[1];
	if (!numericText) return null;

	const value = Number.parseFloat(numericText);
	if (!Number.isFinite(value)) return null;
	if (value <= 0) return null;

	// Strip the numeric part and any whitespace between number and unit.
	const remainder = trimmed.slice(numericMatch[0].length).trim();
	if (remainder.length === 0) return null;

	// Match the entire remainder against a known unit pattern (no trailing text).
	for (const def of UNIT_DEFS) {
		if (def.pattern.test(remainder)) {
			const converted = value * def.factor;
			if (!Number.isFinite(converted) || converted <= 0) return null;
			if (def.base === 'g' && converted > MAX_MASS_G) return null;
			if (def.base === 'ml' && converted > MAX_VOLUME_ML) return null;
			if (def.base === 'ct' && converted > MAX_COUNT) return null;
			return { value: converted, base: def.base };
		}
	}

	return null;
}

/**
 * Compute the price per single base unit (per gram, per ml, or per count).
 * Returns Infinity when the size is degenerate (zero or non-finite).
 */
export function calculateUnitPrice(price: number, parsed: ParsedSize): number {
	if (!Number.isFinite(parsed.value) || parsed.value <= 0) return Number.POSITIVE_INFINITY;
	return price / parsed.value;
}

/**
 * Format a unit price as a human-readable token.
 *
 * - mass: scaled ×100, e.g. "$0.22/100g"
 * - volume: scaled ×100, e.g. "$2.00/100ml"
 * - count: per-item, e.g. "$1.50/ct"
 */
export function formatUnitPriceToken(unitPrice: number, base: SizeBase): string {
	if (base === 'ct') {
		return `$${unitPrice.toFixed(2)}/ct`;
	}
	const scaled = unitPrice * 100;
	const suffix = base === 'g' ? '/100g' : '/100ml';
	return `$${scaled.toFixed(2)}${suffix}`;
}
