/**
 * Shared stop-word list for token-overlap matching across the food app.
 *
 * Used by `recipe-matcher` (recipe title fuzzy match) and `ad-hoc-history`
 * (similar-meal dedup). Keeping a single source means a stop-word added for
 * one matcher cannot accidentally drift out of sync with the other and cause
 * false-positive promotion prompts.
 */

export const STOP_WORDS: ReadonlySet<string> = new Set([
	// Articles & determiners
	'the', 'a', 'an', 'some', 'my', 'our', 'this', 'that', 'these', 'those',
	'any', 'all',
	// Meal nouns (carry no recipe-identity signal)
	'meal', 'dinner', 'lunch', 'breakfast', 'snack', 'brunch', 'supper',
	// Eat verbs (the user always says them)
	'ate', 'eat', 'eating', 'had', 'have', 'having', 'just', 'got',
	// Pronouns
	'i', 'me', 'we', 'us', 'you',
	// Generic glue
	'and', 'or', 'with', 'of', 'for', 'from', 'in', 'on', 'at', 'to',
]);
