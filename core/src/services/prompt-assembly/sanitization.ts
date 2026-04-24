/**
 * Sanitize user input for inclusion in LLM prompts.
 * Truncates to maxLength and neutralizes triple-backtick sequences that
 * could break out of a delimited input section.
 *
 * Peer of core/src/services/llm/prompt-templates.ts's sanitizeInput (whose
 * regex also matches U+FF40 fullwidth grave). P0 preserves exact chatbot
 * behavior; unification is deferred.
 */
export const MAX_INPUT_LENGTH = 4000;

export function sanitizeInput(text: string, maxLength = MAX_INPUT_LENGTH): string {
	const truncated = text.length > maxLength ? text.slice(0, maxLength) : text;
	return truncated.replace(/`{3,}/g, '`');
}
