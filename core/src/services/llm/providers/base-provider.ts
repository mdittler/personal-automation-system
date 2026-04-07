/**
 * Base provider — abstract class for all LLM provider implementations.
 *
 * Handles retry logic, cost tracking, and the LLMClient contract.
 * Concrete providers only implement doComplete() and listModels().
 */

import type { Logger } from 'pino';
import {
	VALID_IMAGE_MIME_TYPES,
	type LLMCompletionOptions,
	type LLMCompletionResult,
	type LLMProviderClient,
	type ProviderModel,
	type ProviderType,
} from '../../../types/llm.js';
import type { CostTracker } from '../cost-tracker.js';
import { getCurrentUserId } from '../llm-context.js';
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
			throw new Error(
				`Provider ${this.providerId} does not support vision (image input)`,
			);
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

		const result = await withRetry(() => this.doComplete(prompt, options), this.getRetryOptions());

		// Record cost (async, don't block on it)
		if (result.usage) {
			this.costTracker
				.record({
					model: result.model,
					provider: result.provider,
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					appId: extractAppId(options),
					userId: getCurrentUserId(),
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

/** Extract _appId from options (injected by LLMGuard). */
function extractAppId(options?: LLMCompletionOptions): string | undefined {
	return options?._appId;
}
