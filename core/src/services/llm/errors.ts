/**
 * Custom error types for LLM safeguards.
 *
 * Thrown by LLMGuard when per-app rate limits or cost caps are exceeded.
 */

/** Thrown when an app exceeds its LLM request rate limit. */
export class LLMRateLimitError extends Error {
	readonly appId: string;
	readonly maxRequests: number;
	readonly windowSeconds: number;

	constructor(appId: string, maxRequests: number, windowSeconds: number) {
		super(`App '${appId}' exceeded LLM rate limit (${maxRequests} requests per ${windowSeconds}s)`);
		this.name = 'LLMRateLimitError';
		this.appId = appId;
		this.maxRequests = maxRequests;
		this.windowSeconds = windowSeconds;
	}
}

/** Thrown when an app or the system exceeds the monthly LLM cost cap. */
export class LLMCostCapError extends Error {
	readonly scope: 'app' | 'global';
	readonly currentCost: number;
	readonly cap: number;
	readonly appId?: string;

	constructor(scope: 'app' | 'global', currentCost: number, cap: number, appId?: string) {
		const scopeMsg = scope === 'app' ? `App '${appId}'` : 'Global';
		super(
			`${scopeMsg} monthly LLM cost cap exceeded ($${currentCost.toFixed(2)} / $${cap.toFixed(2)})`,
		);
		this.name = 'LLMCostCapError';
		this.scope = scope;
		this.currentCost = currentCost;
		this.cap = cap;
		this.appId = appId;
	}
}
