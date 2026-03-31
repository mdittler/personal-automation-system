/**
 * Model ID slugification utility.
 *
 * Converts model identifiers into filesystem-safe path segments.
 * Used by both infrastructure (model-journal service) and apps (chatbot).
 */

/**
 * Slugify a model identifier for use as a filesystem-safe path segment.
 * E.g., "anthropic/claude-sonnet-4-20250514" → "anthropic-claude-sonnet-4-20250514"
 */
export function slugifyModelId(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-|-$/g, '');
}
