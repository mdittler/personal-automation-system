/**
 * LLM error classification utility.
 *
 * Classifies LLM errors into user-friendly categories using duck-typing
 * on error properties (status, name, scope, message). Apps must not import
 * LLM SDK classes directly, so we detect error types by property inspection.
 */

export type LLMErrorCategory =
	| 'billing'
	| 'rate-limit'
	| 'household-rate-limit'
	| 'cost-cap'
	| 'household-cost-cap'
	| 'reservation-exceeded'
	| 'auth'
	| 'overloaded'
	| 'parameter-rejection'
	| 'empty-output'
	| 'unknown';

export interface LLMErrorInfo {
	category: LLMErrorCategory;
	userMessage: string;
	isRetryable: boolean;
}

const USER_MESSAGES: Record<LLMErrorCategory, string> = {
	billing: 'AI service unavailable \u2014 account credits are too low. Please contact your admin.',
	'rate-limit': 'Too many requests. Please wait a moment and try again.',
	'household-rate-limit':
		'Your household has reached its AI request limit for this period. Please try again later or ask your admin to raise the limit.',
	'cost-cap': 'Monthly AI usage limit reached. Service will resume next month.',
	'household-cost-cap':
		'Your household has reached its monthly AI budget. Service will resume next month or when your admin raises the limit.',
	'reservation-exceeded': 'The AI service is briefly at capacity. Please try again in a moment.',
	auth: 'AI service configuration error. Please contact your admin.',
	overloaded: 'AI service is temporarily overloaded. Please try again shortly.',
	'parameter-rejection':
		'The selected AI model rejected one of the request settings. Retrying will not help — please contact your admin to adjust the model configuration.',
	'empty-output':
		'The selected AI model ran out of room before it produced an answer. Retrying will not help — please contact your admin to raise the response length limit for this model.',
	unknown: 'Could not process your request right now. Please try again later.',
};

const RETRYABLE: Record<LLMErrorCategory, boolean> = {
	billing: false,
	'rate-limit': true,
	'household-rate-limit': true,
	'cost-cap': false,
	'household-cost-cap': false,
	'reservation-exceeded': true,
	auth: false,
	overloaded: true,
	'parameter-rejection': false,
	'empty-output': false,
	unknown: true,
};

/**
 * Message shapes providers use when a request parameter is unsupported,
 * deprecated, or unrecognised for the target model. These are deterministic
 * failures — the same request will fail identically every time — so they must
 * classify as non-retryable rather than falling through to 'unknown'.
 *
 * Observed examples:
 *   Anthropic: "`temperature` is deprecated for this model."
 *   OpenAI:    "Unsupported parameter: 'temperature' is not supported with this model."
 *   OpenAI:    "Unrecognized request argument supplied: temperature"
 *   Google:    "Invalid JSON payload received. Unknown name \"temperature\""
 */
/**
 * `Error.name` of `LLMEmptyOutputError` (core/src/services/llm/errors.ts).
 * Matched by name rather than by `instanceof` so this module stays free of
 * imports, exactly as the LLMRateLimitError / LLMCostCapError checks do.
 */
const EMPTY_OUTPUT_ERROR_NAME = 'LLMEmptyOutputError';

const PARAMETER_REJECTION_PATTERNS: readonly RegExp[] = [
	/is deprecated for this model/,
	/\b(?:unsupported|unknown|unrecognized|unrecognised|invalid)\s+(?:request\s+)?(?:parameter|argument|name|field|property)\b/,
	/\bparameter\b[^.]*\bis not supported\b/,
	/\bis not supported with this model\b/,
	/\bextra inputs are not permitted\b/,
];

/** True when a provider 400 message names an unsupported/deprecated request parameter. */
function isParameterRejectionMessage(message: string): boolean {
	return PARAMETER_REJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Classify an LLM error into a user-friendly category.
 *
 * Detects PAS guard errors (LLMRateLimitError, LLMCostCapError) by name + scope,
 * and provider errors (Anthropic, OpenAI, Google) by HTTP status code.
 */
export function classifyLLMError(error: unknown): LLMErrorInfo {
	if (error == null || typeof error !== 'object') {
		return makeInfo('unknown');
	}

	const err = error as Record<string, unknown>;
	const scope = typeof err.scope === 'string' ? err.scope : undefined;

	// PAS guard errors (checked by name + scope to avoid importing guard classes)
	if (err.name === 'LLMRateLimitError') {
		if (scope === 'household') return makeInfo('household-rate-limit');
		if (scope === 'reservation-exceeded') return makeInfo('reservation-exceeded');
		return makeInfo('rate-limit');
	}
	if (err.name === 'LLMCostCapError') {
		if (scope === 'household') return makeInfo('household-cost-cap');
		if (scope === 'reservation-exceeded') return makeInfo('reservation-exceeded');
		return makeInfo('cost-cap');
	}

	// Provider produced nothing and reported the token budget as the reason.
	// Deterministic — the same request exhausts the same budget every time.
	if (err.name === EMPTY_OUTPUT_ERROR_NAME) {
		return makeInfo('empty-output');
	}

	// Provider HTTP errors (Anthropic SDK, OpenAI SDK, etc.)
	const status = typeof err.status === 'number' ? err.status : undefined;
	const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';

	if (status === 400 && (message.includes('credit') || message.includes('billing'))) {
		return makeInfo('billing');
	}
	if (status === 400 && isParameterRejectionMessage(message)) {
		return makeInfo('parameter-rejection');
	}
	if (status === 401) {
		return makeInfo('auth');
	}
	if (status === 429) {
		return makeInfo('rate-limit');
	}
	if (status === 529 || (status !== undefined && status >= 500)) {
		return makeInfo('overloaded');
	}

	return makeInfo('unknown');
}

/**
 * True when the error is a provider 400 rejecting an unsupported/deprecated
 * request parameter. Used by BaseProvider to decide whether stripping the
 * parameter and retrying once is worth attempting.
 */
export function isParameterRejectionError(error: unknown): boolean {
	return classifyLLMError(error).category === 'parameter-rejection';
}

/**
 * True when the error is an `LLMEmptyOutputError` — the provider returned no
 * text and reported that the token budget ran out. Used by BaseProvider to skip
 * the retry schedule: re-issuing the identical request exhausts the identical
 * budget, exactly like a rejected parameter.
 */
export function isEmptyOutputError(error: unknown): boolean {
	return classifyLLMError(error).category === 'empty-output';
}

function makeInfo(category: LLMErrorCategory): LLMErrorInfo {
	return {
		category,
		userMessage: USER_MESSAGES[category],
		isRetryable: RETRYABLE[category],
	};
}
