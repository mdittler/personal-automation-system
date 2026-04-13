/**
 * Parses a string as an integer only if the entire trimmed string consists of digits.
 * Returns null for strings with trailing non-digit characters (e.g. "40g", "2000cal", "1e3").
 */
export function parseStrictInt(raw: string): number | null {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return parseInt(trimmed, 10);
}
