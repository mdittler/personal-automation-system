export const MAX_FIELD_LEN = 500;

/**
 * Used on every app-message-bridge body (and on photo-summary fields via
 * re-export from `apps/food/src/handlers/photo-summary.ts`). Truncation
 * appends a single ellipsis character — output is `maxLen + 1` chars when
 * truncation fires. Both bridges share this contract so their bodies look
 * identical to the chatbot.
 */
export function sanitizeAppMessageField(
	input: string | undefined | null,
	maxLen = MAX_FIELD_LEN,
): string {
	if (!input) return '';
	let s = String(input);
	// Strip ASCII control chars (0x00–0x1f, 0x7f)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char sanitization
	s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
	// Strip Unicode zero-width / bidi / BOM chars.
	// U+200B–U+200F: zero-width space through RLM
	// U+202A–U+202E: LRE through RLO
	// U+2060–U+2069: word-joiner through bidi isolate controls (LRI/RLI/FSI/PDI)
	// U+FEFF: BOM / ZWNBSP
	s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '');
	// Neutralize prompt-fence-like XML tags (including close tags)
	s = s.replace(/<\/?(system|assistant|user|content|memory-context|memory-snapshot)[^>]*>/gi, '');
	// Collapse whitespace
	s = s.replace(/\s+/g, ' ').trim();
	if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
	return s;
}
