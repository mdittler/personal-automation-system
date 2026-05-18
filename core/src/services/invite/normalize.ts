/**
 * Display-name normalization for uniqueness comparisons.
 *
 * Trims surrounding whitespace and uses the locale-independent `toLowerCase`
 * so identity matching produces the same key regardless of the host's locale.
 * The original-case input is what gets persisted; only the comparison key
 * flows through this function.
 */
export function normalizeDisplayName(raw: string): string {
	return raw.trim().toLowerCase();
}
