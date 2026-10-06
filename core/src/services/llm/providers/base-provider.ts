/**
 * Base provider — abstract class for all LLM provider implementations.
 *
 * Handles retry logic, cost tracking, and the LLMClient contract.
 * Concrete providers only implement doComplete() and listModels().
 */

import type { Logger } from 'pino';
import {
	type ChatMessage,
	type ChatOptions,
	type ChatResult,
	type LLMCompletionOptions,
	type LLMCompletionResult,
	type LLMImage,
	type LLMProviderClient,
	type ModelRef,
	type ProviderModel,
	type ProviderType,
	VALID_IMAGE_MIME_TYPES,
} from '../../../types/llm.js';
import {
	isAbortError,
	isEmptyOutputError,
	isParameterRejectionError,
} from '../../../utils/llm-errors.js';
import { getCurrentHouseholdId, getCurrentUserId } from '../../context/request-context.js';
import { abortReason, abortable, toAbortError, validateChatMessages } from '../chat-messages.js';
import type { CostTracker } from '../cost-tracker.js';
import { LLMEmptyOutputError, LLMToolsUnsupportedError } from '../errors.js';
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
		if (options?.images?.length) {
			this.assertVisionProvider();
			assertImageMimeTypes(options.images);
		}

		try {
			const result = await this.runWithTemperatureFallback(options, (opts) =>
				this.doComplete(prompt, opts),
			);
			this.recordUsage(result.model, result.usage, options?._appId);
			return result;
		} catch (err) {
			this.recordUsageFromError(err, options?._appId);
			throw err;
		}
	}

	/**
	 * Chat with optional tools. Same envelope as completeWithUsage — retry,
	 * temperature self-heal, cost recording — plus: the history is validated
	 * first, a pre-aborted signal fails before any work, tools are refused
	 * before any inference call when the model lacks them, and images are
	 * gated **per model** (`supportsVisionModel`), whose base default is the
	 * provider-wide flag. The provider-wide `supportsVision` is not consulted
	 * here, so Ollama can accept photos on chat (per-model probe) while
	 * `complete()` — whose `generate` request sends no images — keeps
	 * rejecting them (R1-2). Both capability waits are abortable: the probe
	 * keeps running and fills its cache, but this caller returns on abort.
	 */
	async chatWithUsage(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
		throwIfAborted(options.signal);
		validateChatMessages(messages);
		const model = this.resolveModel(options);

		const images = messages.flatMap((m) => m.images ?? []);
		if (images.length > 0) {
			assertImageMimeTypes(images);
			if (!(await abortable(this.supportsVisionModel(model), options.signal))) {
				throw new Error(
					`Model '${model}' on provider ${this.providerId} does not support vision (image input)`,
				);
			}
		}

		if (options.tools?.length && !(await abortable(this.supportsTools(model), options.signal))) {
			throw new LLMToolsUnsupportedError({ provider: this.providerId, model });
		}

		try {
			const result = await this.runWithTemperatureFallback(options, (opts) =>
				this.doChat(messages, opts),
			);
			this.recordUsage(result.model, result.usage, options._appId);
			return result;
		} catch (err) {
			this.recordUsageFromError(err, options._appId);
			// P2-4: once our signal has fired, whatever the SDK threw (the openai /
			// anthropic APIUserAbortError is named 'Error'; a native fetch throws the
			// custom reason) is our cancellation — surface it as such.
			if (options.signal?.aborted && !isAbortError(err)) {
				throw toAbortError(options.signal, err);
			}
			throw err;
		}
	}

	/**
	 * Whether `modelId` accepts native tool definitions. Default: no. Each
	 * provider that implements doChat overrides this.
	 */
	async supportsTools(_modelId: string): Promise<boolean> {
		return false;
	}

	/** Whether `modelId` accepts images. Default: the provider-wide flag. Ollama overrides per model. */
	async supportsVisionModel(_modelId: string): Promise<boolean> {
		return this.supportsVision;
	}

	/** Perform the chat call. Providers without chat keep this default. */
	protected async doChat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResult> {
		throw new Error(
			`Provider '${this.providerId}' (${this.providerType}) does not implement chat()`,
		);
	}

	/**
	 * Run a provider call, self-healing a `temperature` rejection.
	 *
	 * MODEL_CAPABILITIES is the first line of defence, but it can only cover
	 * models we have probed. When an unlisted model rejects `temperature` with a
	 * deterministic 400, strip the parameter and retry exactly once, and warn
	 * with the model id so a table entry can be added.
	 */
	private async runWithTemperatureFallback<
		O extends { temperature?: number; modelRef?: { model: string }; signal?: AbortSignal },
		R,
	>(options: O | undefined, run: (opts: O | undefined) => Promise<R>): Promise<R> {
		// Deterministic failures never retry: a parameter-rejection 400, an
		// empty-output failure (the identical budget is exhausted identically),
		// and a cancellation (the caller gave up). The cancellation check reads
		// `signal.aborted` as well as the error name (P2-4): the SDK abort
		// classes are named 'Error', so the name alone would retry a cancelled
		// request through the whole backoff schedule.
		const retryOptions = {
			...this.getRetryOptions(),
			shouldRetry: (err: Error) =>
				!isParameterRejectionError(err) &&
				!isEmptyOutputError(err) &&
				!isAbortError(err, options?.signal),
		};

		try {
			return await withRetry(() => run(options), retryOptions);
		} catch (err) {
			if (options?.temperature === undefined || !isTemperatureRejection(err)) {
				throw err;
			}

			this.logger.warn(
				{
					provider: this.providerId,
					model: this.resolveModel(options as LLMCompletionOptions),
					error: err instanceof Error ? err.message : String(err),
				},
				'Model rejected the temperature parameter — retrying without it. Add a MODEL_CAPABILITIES entry for this model.',
			);

			return withRetry(() => run({ ...options, temperature: undefined }), retryOptions);
		}
	}

	/** Record usage (async, never blocks the caller). No-op when the provider reported none. */
	private recordUsage(
		model: string,
		usage: { inputTokens: number; outputTokens: number } | undefined,
		appId: string | undefined,
	): void {
		if (!usage) return;
		this.costTracker
			.record({
				model,
				provider: this.providerId,
				providerType: this.providerType,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				appId,
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

	/**
	 * A call that failed after the provider billed it must still be charged
	 * (open-items "Failed paid calls can drop their usage"). Today the only
	 * error that carries usage is LLMEmptyOutputError.
	 */
	private recordUsageFromError(err: unknown, appId: string | undefined): void {
		if (err instanceof LLMEmptyOutputError && err.usage) {
			this.recordUsage(err.model, err.usage, appId);
		}
	}

	private assertVisionProvider(): void {
		if (!this.supportsVision) {
			throw new Error(`Provider ${this.providerId} does not support vision (image input)`);
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
	protected resolveModel(options?: { modelRef?: ModelRef; claudeModel?: string }): string {
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

function assertImageMimeTypes(images: readonly LLMImage[]): void {
	for (const img of images) {
		if (!(VALID_IMAGE_MIME_TYPES as readonly string[]).includes(img.mimeType)) {
			throw new Error(
				`Unsupported image MIME type: ${img.mimeType}. Supported: ${VALID_IMAGE_MIME_TYPES.join(', ')}`,
			);
		}
	}
}

/** Fail fast with the signal's own reason (an AbortError unless the caller supplied one). */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw abortReason(signal);
}
