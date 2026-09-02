/**
 * Custom error types for LLM safeguards.
 *
 * Thrown by LLMGuard when per-app rate limits or cost caps are exceeded.
 */

export type LLMRateLimitScope = 'app' | 'household';
export type LLMCostCapScope = 'app' | 'global' | 'household' | 'reservation-exceeded';

export interface LLMRateLimitErrorOptions {
	scope?: LLMRateLimitScope;
	appId?: string;
	householdId?: string;
	maxRequests: number;
	windowSeconds: number;
}

/** Thrown when an app or household exceeds its LLM request rate limit. */
export class LLMRateLimitError extends Error {
	readonly scope: LLMRateLimitScope;
	readonly appId?: string;
	readonly householdId?: string;
	readonly maxRequests: number;
	readonly windowSeconds: number;

	constructor(opts: LLMRateLimitErrorOptions) {
		const scope = opts.scope ?? 'app';
		let msg: string;
		if (scope === 'household') {
			msg = `Household '${opts.householdId}' exceeded LLM rate limit (${opts.maxRequests} requests per ${opts.windowSeconds}s)`;
		} else {
			msg = `App '${opts.appId}' exceeded LLM rate limit (${opts.maxRequests} requests per ${opts.windowSeconds}s)`;
		}
		super(msg);
		this.name = 'LLMRateLimitError';
		this.scope = scope;
		this.appId = opts.appId;
		this.householdId = opts.householdId;
		this.maxRequests = opts.maxRequests;
		this.windowSeconds = opts.windowSeconds;
	}
}

export interface LLMCostCapErrorOptions {
	scope: LLMCostCapScope;
	appId?: string;
	householdId?: string;
	reservationId?: string;
	currentCost: number;
	cap: number;
	cause?: unknown;
}

/** Thrown when an app, household, or the system exceeds the monthly LLM cost cap. */
export class LLMCostCapError extends Error {
	readonly scope: LLMCostCapScope;
	readonly currentCost: number;
	readonly cap: number;
	readonly appId?: string;
	readonly householdId?: string;
	readonly reservationId?: string;

	constructor(opts: LLMCostCapErrorOptions) {
		let scopeMsg: string;
		if (opts.scope === 'app') {
			scopeMsg = `App '${opts.appId}'`;
		} else if (opts.scope === 'global') {
			scopeMsg = 'Global';
		} else if (opts.scope === 'household') {
			scopeMsg = `Household '${opts.householdId}'`;
		} else {
			scopeMsg = 'Reservation';
		}
		super(
			`${scopeMsg} monthly LLM cost cap exceeded ($${opts.currentCost.toFixed(2)} / $${opts.cap.toFixed(2)})`,
			opts.cause !== undefined ? { cause: opts.cause } : undefined,
		);
		this.name = 'LLMCostCapError';
		this.scope = opts.scope;
		this.currentCost = opts.currentCost;
		this.cap = opts.cap;
		this.appId = opts.appId;
		this.householdId = opts.householdId;
		this.reservationId = opts.reservationId;
	}
}

export interface LLMEmptyOutputErrorOptions {
	/** Provider key that produced the empty completion. */
	provider: string;
	/** Model id that produced the empty completion. */
	model: string;
	/** The `maxTokens` / `num_predict` budget the request was given, if any. */
	maxTokens?: number;
	/** Length in characters of the model's thinking block, when it reported one. */
	thinkingChars?: number;
}

/**
 * Thrown when a provider returns an empty completion **and** reports that
 * generation stopped because the token budget ran out.
 *
 * Empty-plus-truncated is unambiguously a failure: the model produced nothing
 * the caller can use and there is no more budget to produce it with. The usual
 * cause is a thinking-capable model spending the whole `num_predict` allowance
 * inside its reasoning phase (see `LLMCompletionOptions.thinking`).
 *
 * Empty-plus-`stop` is NOT this error — some local models (Gemma) legitimately
 * return `''` on ambiguous prompts, and callers retry that themselves.
 *
 * Deterministic: the identical request exhausts the identical budget every
 * time, so this classifies as non-retryable.
 */
export class LLMEmptyOutputError extends Error {
	readonly provider: string;
	readonly model: string;
	readonly maxTokens?: number;
	readonly thinkingChars?: number;

	constructor(opts: LLMEmptyOutputErrorOptions) {
		const budget =
			typeof opts.maxTokens === 'number'
				? `num_predict budget of ${opts.maxTokens} token(s)`
				: 'num_predict budget';
		const thinking =
			typeof opts.thinkingChars === 'number' && opts.thinkingChars > 0
				? ` The model emitted a ${opts.thinkingChars}-character thinking block instead of an answer.`
				: '';
		super(
			`Model '${opts.model}' (provider '${opts.provider}') returned empty output after exhausting its ${budget}.${thinking} Raise maxTokens, or keep thinking disabled (thinking: false is the default).`,
		);
		this.name = 'LLMEmptyOutputError';
		this.provider = opts.provider;
		this.model = opts.model;
		this.maxTokens = opts.maxTokens;
		this.thinkingChars = opts.thinkingChars;
	}
}
