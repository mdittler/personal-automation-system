/**
 * LLM error classification utility.
 *
 * Classifies LLM errors into user-friendly categories using duck-typing
 * on error properties (status, name, message). Apps must not import LLM
 * SDK classes directly, so we detect error types by property inspection.
 */

export type LLMErrorCategory =
	| 'billing'
	| 'rate-limit'
	| 'cost-cap'
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
	'cost-cap': 'Monthly AI usage limit reached. Service will resume next month.',
	auth: 'AI service configuration error. Please contact your admin.',
	overloaded: 'AI service is temporarily overloaded. Please try again shortly.',
	unknown: 'Could not process your request right now. Please try again later.',
};

const RETRYABLE: Record<LLMErrorCategory, boolean> = {
	billing: false,
	'rate-limit': true,
	'cost-cap': false,
	auth: false,
	overloaded: true,
	unknown: true,
};

/**
 * Classify an LLM error into a user-friendly category.
 *
 * Detects PAS guard errors (LLMRateLimitError, LLMCostCapError) by name,
 * and provider errors (Anthropic, OpenAI, Google) by HTTP status code.
 */
export function classifyLLMError(error: unknown): LLMErrorInfo {
	if (error == null || typeof error !== 'object') {
		return makeInfo('unknown');
	}

	const err = error as Record<string, unknown>;

	// PAS guard errors (checked by name to avoid importing guard classes)
	if (err.name === 'LLMRateLimitError') {
		return makeInfo('rate-limit');
	}
	if (err.name === 'LLMCostCapError') {
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
