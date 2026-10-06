/**
 * Provider-call tracking for the per-trial worker (REQ-REG-AGENT-002).
 *
 * Wraps every provider's `completeWithUsage` and `chatWithUsage` so that (a) provider-level
 * failures — which the app layer swallows into polite replies — are recorded
 * and force the trial to `error` instead of a cached `fail` (review C12), and
 * (b) calls the app started but did not await (Food's shadow classifier and
 * its repair call) can be drained before grading and before the worker exits,
 * so their spend and errors are measured (review C19). Both
 * `completeWithUsage` and `chatWithUsage` are wrapped (P1), so the agent loop's
 * provider errors force `error` and are never graded.
 */
import type { LLMProviderClient } from '@core/types/llm.js';

/** Provider calls must be quiet for this long before a drain is considered complete. */
export const DEFAULT_SETTLE_MS = 250;
/** A drain that cannot settle within this window records an infrastructure error. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;

export interface ProviderCallTracker {
	/** Recorded `${label}: ${message}` entries, in order. */
	readonly errors: readonly string[];
	inFlight(): number;
	track<T>(label: string, call: () => Promise<T>): Promise<T>;
	wrap(
		provider: Pick<LLMProviderClient, 'providerId' | 'completeWithUsage'> &
			Partial<Pick<LLMProviderClient, 'chatWithUsage'>>,
	): void;
	drain(): Promise<void>;
}

export function createProviderCallTracker(
	opts: { settleMs?: number; drainTimeoutMs?: number } = {},
): ProviderCallTracker {
	const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
	const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
	const errors: string[] = [];
	let inFlight = 0;
	const idleWaiters: Array<() => void> = [];

	const track = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
		inFlight++;
		try {
			return await call();
		} catch (err) {
			errors.push(`${label}: ${(err as Error).message}`);
			throw err;
		} finally {
			inFlight--;
			if (inFlight === 0) for (const wake of idleWaiters.splice(0)) wake();
		}
	};

	return {
		errors,
		inFlight: () => inFlight,
		track,
		wrap(provider) {
			const originalComplete = provider.completeWithUsage.bind(provider);
			provider.completeWithUsage = (prompt, options) =>
				track(provider.providerId, () => originalComplete(prompt, options));
			if (typeof provider.chatWithUsage === 'function') {
				const originalChat = provider.chatWithUsage.bind(provider);
				provider.chatWithUsage = (messages, options) =>
					track(provider.providerId, () => originalChat(messages, options));
			}
		},
		/**
		 * Resolve once provider calls have been quiet for a full settle window
		 * (a follow-up call scheduled after the first completes is also awaited).
		 * Past the timeout, record an infrastructure error and return.
		 */
		async drain() {
			const deadline = Date.now() + drainTimeoutMs;
			for (;;) {
				await new Promise((r) => setTimeout(r, settleMs));
				if (inFlight === 0) return;
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					errors.push(
						`drain: ${inFlight} provider call(s) still in flight after ${drainTimeoutMs} ms`,
					);
					return;
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, remaining);
					idleWaiters.push(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
		},
	};
}
