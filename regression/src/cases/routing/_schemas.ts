/**
 * Shared JSON schemas for routing-bucket case files.
 *
 * Each routing case asserts the production classifier's output shape via
 * the structural oracle. Hand-writing the same schema across N case files
 * invites drift; these constants are the single source of truth.
 */

export const SESSION_CONTROL_SCHEMA = {
	type: 'object',
	required: ['intent', 'confidence', 'source'],
	properties: {
		intent: { type: 'string' },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		source: { type: 'string' },
	},
} as const;

/**
 * `pasRelated` is always set by the classifier; `dataQueryCandidate` and
 * `settingsCandidate` are optional. Individual cases narrow `pasRelated`
 * via `properties.pasRelated.const`.
 */
export const PAS_BASE_SCHEMA = {
	type: 'object',
	required: ['pasRelated'],
	properties: {
		pasRelated: { type: 'boolean' },
		dataQueryCandidate: { type: 'boolean' },
		settingsCandidate: { type: 'boolean' },
	},
} as const;
