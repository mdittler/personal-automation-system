/**
 * Base provider — abstract class for all LLM provider implementations.
 *
 * Handles retry logic, cost tracking, and the LLMClient contract.
 * Concrete providers only implement doComplete() and listModels().
 */

import type { Logger } from 'pino';
import {
	type LLMCompletionOptions,
	type LLMCompletionResult,
	type LLMProviderClient,
	type ProviderModel,
	type ProviderType,
	VALID_IMAGE_MIME_TYPES,
} from '../../../types/llm.js';
import { isEmptyOutputError, isParameterRejectionError } from '../../../utils/llm-errors.js';
import { getCurrentHouseholdId, getCurrentUserId } from '../../context/request-context.js';
import type { CostTracker } from '../cost-tracker.js';
import { withRetry } from '../retry.js';

export interface BaseProviderOptions {
	/** Unique provider key (e.g. 'anthropic', 'openai', 'groq'). */
	providerId: string;
	/** Provider backend type. */
	providerType: ProviderType;
	/** API key (empty string for providers that don't need one, e.g. Ollama). */
	apiKey: string;
	/** Default model ID for this provider. */
	defaultModel: string;
	/** Logger instance. */
	logger: Logger;
	/** Cost tracker for usage logging. */
	costTracker: CostTracker;
	/** API base URL (for OpenAI-compatible and Ollama). */
	baseUrl?: string;
}

export abstract class BaseProvider implements LLMProviderClient {
	readonly providerId: string;
	readonly providerType: ProviderType;
	readonly supportsVision: boolean = false;
	protected readonly apiKey: string;
	protected readonly defaultModel: string;
	protected readonly logger: Logger;
	protected readonly costTracker: CostTracker;
	protected readonly baseUrl?: string;

	constructor(options: BaseProviderOptions) {
		this.providerId = options.providerId;
		this.providerType = options.providerType;
		this.apiKey = options.apiKey;
		this.defaultModel = options.defaultModel;
		this.logger = options.logger;
		this.costTracker = options.costTracker;
		this.baseUrl = options.baseUrl;
	}

	/**
	 * Simple completion — returns just the text.
	 * Satisfies the LLMClient interface for backward compat.
	 */
	async complete(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		const result = await this.completeWithUsage(prompt, options);
		return result.text;
	}

	/**
	 * Full completion with usage data and cost tracking.
	 * Wraps doComplete() with retry logic and logs usage.
	 */
	async completeWithUsage(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		if (options?.images?.length && !this.supportsVision) {
			throw new Error(`Provider ${this.providerId} does not support vision (image input)`);
		}

		if (options?.images?.length) {
			for (const img of options.images) {
				if (!(VALID_IMAGE_MIME_TYPES as readonly string[]).includes(img.mimeType)) {
					throw new Error(
						`Unsupported image MIME type: ${img.mimeType}. Supported: ${VALID_IMAGE_MIME_TYPES.join(', ')}`,
					);
				}
			}
		}

		const result = await this.completeWithTemperatureFallback(prompt, options);

		// Record cost (async, don't block on it)
		if (result.usage) {
			this.costTracker
				.record({
					model: result.model,
					provider: result.provider,
					providerType: this.providerType,
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					appId: extractAppId(options),
					userId: getCurrentUserId(),
					householdId: getCurrentHouseholdId(),
				})
				.catch((err: unknown) => {
					this.logger.error(
						{ error: err instanceof Error ? err.message : String(err) },
						'Failed to record usage',
					);
				});
		}

		return result;
	}

	/**
	 * Run the completion, self-healing a `temperature` rejection.
	 *
	 * MODEL_CAPABILITIES is the first line of defence, but it can only cover
	 * models we have probed. When an unlisted model rejects `temperature` with a
	 * deterministic 400, strip the parameter and retry exactly once, and warn
	 * with the model id so a table entry can be added.
	 */
	private async completeWithTemperatureFallback(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		// A parameter-rejection 400 is deterministic: retrying the identical
		// request just burns the backoff schedule, so fail out of withRetry
		// immediately and let the strip-and-retry below do the useful work.
		// An empty-output failure is deterministic for the same reason — the
		// identical request exhausts the identical token budget every time.
		const retryOptions = {
			...this.getRetryOptions(),
			shouldRetry: (err: Error) => !isParameterRejectionError(err) && !isEmptyOutputError(err),
		};

		try {
			return await withRetry(() => this.doComplete(prompt, options), retryOptions);
		} catch (err) {
			if (options?.temperature === undefined || !isTemperatureRejection(err)) {
				throw err;
			}

			this.logger.warn(
				{
					provider: this.providerId,
					model: this.resolveModel(options),
					error: err instanceof Error ? err.message : String(err),
				},
				'Model rejected the temperature parameter — retrying without it. Add a MODEL_CAPABILITIES entry for this model.',
			);

			return withRetry(
				() => this.doComplete(prompt, { ...options, temperature: undefined }),
				retryOptions,
			);
		}
	}

	/** List models available from this provider. */
	abstract listModels(): Promise<ProviderModel[]>;

	/** Perform the actual completion call. Implemented by each provider. */
	protected abstract doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult>;

	/** Get retry options for this provider. Override in subclasses if needed. */
	protected getRetryOptions() {
		return {
			maxRetries: 2,
			initialDelayMs: 1000,
			logger: this.logger,
		};
	}

	/** Resolve the model ID from options or fall back to default. */
	protected resolveModel(options?: LLMCompletionOptions): string {
		return options?.modelRef?.model || options?.claudeModel || this.defaultModel;
	}
}

/**
 * True when the error is a parameter-rejection 400 that names `temperature`.
 * Narrower than `isParameterRejectionError` on purpose: stripping the
 * temperature only helps when the temperature is what the model objected to.
 */
function isTemperatureRejection(error: unknown): boolean {
	if (!isParameterRejectionError(error)) return false;
	const message =
		typeof (error as Record<string, unknown>)?.message === 'string'
			? ((error as Record<string, unknown>).message as string).toLowerCase()
			: '';
	return message.includes('temperature');
}

/** Extract _appId from options (injected by LLMGuard). */
function extractAppId(options?: LLMCompletionOptions): string | undefined {
	return options?._appId;
}
