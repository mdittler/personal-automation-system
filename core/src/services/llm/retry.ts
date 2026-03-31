/**
 * Configurable retry with exponential backoff.
 *
 * Used by LLM clients to handle transient failures.
 * Ollama failure does NOT silently fall back to Claude (URS-LLM-004).
 */

import type { Logger } from 'pino';

export interface RetryOptions {
	/** Maximum number of retry attempts. Default: 3. */
	maxRetries?: number;
	/** Initial delay in ms before first retry. Default: 1000. */
	initialDelayMs?: number;
	/** Multiplier for each subsequent delay. Default: 2. */
	backoffMultiplier?: number;
	/** Logger for retry warnings. */
	logger?: Logger;
}

/**
 * Execute an async function with retry and exponential backoff.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const maxRetries = Math.max(0, options.maxRetries ?? 3);
	const initialDelayMs = Math.max(0, options.initialDelayMs ?? 1000);
	const backoffMultiplier = Math.max(1, options.backoffMultiplier ?? 2);

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));

			if (attempt < maxRetries) {
				const delay = initialDelayMs * backoffMultiplier ** attempt;
				options.logger?.warn(
					{ attempt: attempt + 1, maxRetries, delayMs: delay, error: lastError.message },
					'Retrying after failure',
				);
				await sleep(delay);
			}
		}
	}

	throw lastError;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
