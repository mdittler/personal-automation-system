/**
 * Sanitize user input for LLM prompts.
 * Truncates to maxLength and neutralizes triple backtick sequences.
 * Local copy — apps must not import core internals.
 */

const MAX_INPUT_LENGTH = 10000;

export function sanitizeInput(text: string, maxLength = MAX_INPUT_LENGTH): string {
	const truncated = text.length > maxLength ? text.slice(0, maxLength) : text;
	// Replace sequences of 3+ backticks (including unicode fullwidth grave accent U+FF40)
	// to prevent delimiter escape in LLM prompts
	return truncated.replace(/[\u0060\uFF40]{3,}/g, '`');
}
