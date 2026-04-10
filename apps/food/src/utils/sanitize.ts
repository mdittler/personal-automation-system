/**
 * Sanitize user input for LLM prompts.
 *
 * `sanitizeInput` is the baseline: truncate + neutralize triple-backticks. Use
 * it for contexts where the user's text is rendered back to themselves (e.g.
 * chatbot history) and newlines carry meaning.
 *
 * `sanitizeForPrompt` is the hardened variant for user text that gets
 * interpolated into a structured LLM prompt with its own fence sentinels. It
 * strips newlines (so the user cannot forge a fence boundary), scrubs
 * role-override line prefixes at start-of-line, and also neutralizes any
 * literal occurrence of the caller-supplied fence string. Callers that
 * delimit untrusted sections with a sentinel MUST use this variant and pass
 * the fence string, or the user can break out of the section.
 *
 * Local copy — apps must not import core internals.
 */

const MAX_INPUT_LENGTH = 10000;

/** Baseline sanitizer: length cap + triple-backtick neutralization. Keeps newlines. */
export function sanitizeInput(text: string, maxLength = MAX_INPUT_LENGTH): string {
	const truncated = text.length > maxLength ? text.slice(0, maxLength) : text;
	// Replace sequences of 3+ backticks (including unicode fullwidth grave accent U+FF40)
	// to prevent delimiter escape in LLM prompts
	return truncated.replace(/[\u0060\uFF40]{3,}/g, '`');
}

/**
 * Hardened sanitizer for structured LLM prompts.
 *
 * Applies `sanitizeInput` then:
 *  - replaces every `\r` or `\n` with a single space (prevents fence-forge)
 *  - scrubs each supplied `fenceSentinels` substring (case-insensitive)
 *  - strips leading role-override markers like `assistant:`, `system:`,
 *    `human:`, `user:` that appear as the first non-whitespace token
 *  - collapses runs of whitespace
 *
 * Pass the exact fence strings your prompt uses (e.g. the literal
 * `--- END User-provided meal description ---`). If the user's text
 * happens to contain that string, it is neutralized into a harmless form.
 */
export function sanitizeForPrompt(
	text: string,
	fenceSentinels: string[] = [],
	maxLength = MAX_INPUT_LENGTH,
): string {
	let out = sanitizeInput(text, maxLength);
	// Strip all newlines and carriage returns.
	out = out.replace(/[\r\n]+/g, ' ');
	// Scrub each fence sentinel (case-insensitive) by inserting a zero-width-safe
	// disruptor; we use `[redacted-fence]`.
	for (const sentinel of fenceSentinels) {
		if (!sentinel) continue;
		const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out.replace(new RegExp(escaped, 'gi'), '[redacted-fence]');
	}
	// Strip leading role-override markers.
	out = out.replace(/^\s*(?:system|assistant|human|user)\s*:\s*/i, '');
	// Collapse whitespace runs.
	out = out.replace(/\s+/g, ' ').trim();
	return out;
}
