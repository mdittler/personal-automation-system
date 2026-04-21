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
	'reservation-exceeded':
		'The AI service is briefly at capacity. Please try again in a moment.',
	auth: 'AI service configuration error. Please contact your admin.',
	overloaded: 'AI service is temporarily overloaded. Please try again shortly.',
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
	unknown: true,
};

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

	// Provider HTTP errors (Anthropic SDK, OpenAI SDK, etc.)
	const status = typeof err.status === 'number' ? err.status : undefined;
	const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';

	if (status === 400 && (message.includes('credit') || message.includes('billing'))) {
		return makeInfo('billing');
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

function makeInfo(category: LLMErrorCategory): LLMErrorInfo {
	return {
		category,
		userMessage: USER_MESSAGES[category],
		isRetryable: RETRYABLE[category],
	};
}
