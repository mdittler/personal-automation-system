/**
 * LLM service types.
 *
 * Defines the unified LLM interface that abstracts over multiple providers.
 * Apps never call LLM backends directly — they use the LLMService facade
 * and request models by tier (fast/standard/reasoning) or explicit ModelRef.
 */

// ---------------------------------------------------------------------------
// Provider and tier types
// ---------------------------------------------------------------------------

/** Supported provider backend types. */
export type ProviderType = 'anthropic' | 'google' | 'openai-compatible' | 'ollama' | 'llama-cpp';

/** Semantic model tiers — apps request a tier, infrastructure picks the model. */
export type ModelTier = 'fast' | 'standard' | 'reasoning';

/** A fully-qualified model reference: provider key + model ID. */
export interface ModelRef {
	/** Provider key from config (e.g. 'anthropic', 'openai', 'groq'). */
	provider: string;
	/** Model ID (e.g. 'claude-sonnet-4-20250514', 'gpt-4o'). */
	model: string;
}

// ---------------------------------------------------------------------------
// Legacy types (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Which LLM backend to use.
 * @deprecated Use `ModelTier` or `ModelRef` instead. Kept for backward compat.
 */
export type LLMProvider = 'local' | 'claude';

// ---------------------------------------------------------------------------
// Vision (multimodal image input)
// ---------------------------------------------------------------------------

/** Allowed image MIME types for vision requests. */
export const VALID_IMAGE_MIME_TYPES = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
] as const;

/** An image to include in a multimodal completion request. */
export interface LLMImage {
	/** Raw image data. */
	data: Buffer;
	/** MIME type (e.g. 'image/jpeg', 'image/png'). */
	mimeType: string;
}

// ---------------------------------------------------------------------------
// Completion options
// ---------------------------------------------------------------------------

/** Options for the complete() method. */
export interface LLMCompletionOptions {
	/**
	 * Backend to use. Defaults to 'local'.
	 * @deprecated Use `tier` or `modelRef` instead. Kept for backward compat.
	 * 'local' maps to tier 'fast', 'claude' maps to tier 'standard'.
	 */
	model?: LLMProvider;
	/**
	 * Specific Claude model to use (e.g. 'claude-opus-4-6').
	 * @deprecated Use `modelRef` instead. Kept for backward compat.
	 */
	claudeModel?: string;

	/** Semantic tier: let the infrastructure pick the best model. */
	tier?: ModelTier;
	/** Explicit provider + model. Overrides tier and legacy options. */
	modelRef?: ModelRef;

	/** Sampling temperature. Higher = more creative. */
	temperature?: number;
	/** Maximum tokens to generate. */
	maxTokens?: number;

	/** System prompt / instructions (supported by providers that accept it). */
	systemPrompt?: string;

	/** Images to include in the completion request (multimodal vision). */
	images?: LLMImage[];

	/** App ID for cost attribution. Injected by LLMGuard — apps should not set this. */
	_appId?: string;

	/**
	 * Provider-specific JSON-mode hint. When set to `'json'`:
	 *   - Ollama: passes `format: 'json'` to the generate call.
	 *   - Google Gemini: sets `responseMimeType: 'application/json'`.
	 *   - OpenAI-compatible: sets `response_format: { type: 'json_object' }`.
	 *   - Anthropic: no-op (Claude reliably emits JSON when the prompt asks).
	 *
	 * Use for classifier prompts that must return parseable JSON. Helps Gemma
	 * and other local models avoid empty-string responses for ambiguous prompts.
	 */
	responseFormat?: 'json';
}

// ---------------------------------------------------------------------------
// Completion result (enriched with usage data)
// ---------------------------------------------------------------------------

/**
 * Unified finish reason across all providers.
 *
 * Mappings (per provider):
 * - Anthropic `stop_reason`: 'end_turn'|'stop_sequence' → 'stop'; 'max_tokens' → 'length'; 'tool_use' → 'other'.
 * - OpenAI-compat `choices[0].finish_reason`: 'stop' → 'stop'; 'length' → 'length';
 *   'content_filter' → 'error'; 'tool_calls'|'function_call' → 'other'.
 * - Google `candidates[0].finishReason`: 'STOP' → 'stop'; 'MAX_TOKENS' → 'length';
 *   'SAFETY'|'RECITATION' → 'error'; everything else → 'other'.
 * - Ollama `done_reason` (newer SDKs): 'stop' → 'stop'; 'length' → 'length'; 'load' → 'other'.
 *   Older SDKs lacking `done_reason` fall back to `eval_count >= options.maxTokens ? 'length' : 'stop'`.
 *
 * Unknown / missing source values map to `'other'` so callers can detect the
 * "I don't know" case explicitly rather than silently assuming a clean stop.
 */
export type LLMFinishReason = 'stop' | 'length' | 'error' | 'other';

/** Result from a provider completion, enriched with usage data. */
export interface LLMCompletionResult {
	/** Generated text. */
	text: string;
	/** Token usage (when reported by the provider). */
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
	/** Model ID that served this request. */
	model: string;
	/** Provider key that served this request. */
	provider: string;
	/** Why the model stopped generating. Required across all providers. */
	finishReason: LLMFinishReason;
}

// ---------------------------------------------------------------------------
// Provider client interface
// ---------------------------------------------------------------------------

/**
 * Generic LLM client interface.
 *
 * All provider clients satisfy this contract,
 * allowing classify/extract to work with any backend.
 */
export interface LLMClient {
	complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;
}

/** A model available from a provider. */
export interface ProviderModel {
	/** Model ID (e.g. 'claude-sonnet-4-20250514'). */
	id: string;
	/** Human-readable display name. */
	displayName: string;
	/** Provider key (e.g. 'anthropic', 'openai'). */
	provider: string;
	/** Provider type. */
	providerType: ProviderType;
	/** Pricing per million tokens (null if unknown). */
	pricing: { input: number; output: number } | null;
}

/**
 * Extended client interface for provider implementations.
 *
 * Providers implement this to support usage tracking and model listing.
 * The base `LLMClient` interface is preserved for backward compat.
 */
export interface LLMProviderClient extends LLMClient {
	/** Unique provider key (e.g. 'anthropic', 'openai', 'groq'). */
	readonly providerId: string;
	/** Provider backend type. */
	readonly providerType: ProviderType;
	/** Whether this provider supports vision (image input). */
	readonly supportsVision: boolean;
	/** Complete with full result including usage data. */
	completeWithUsage(prompt: string, options?: LLMCompletionOptions): Promise<LLMCompletionResult>;
	/** List models available from this provider. */
	listModels(): Promise<ProviderModel[]>;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Result of a classify() call. */
export interface ClassifyResult {
	/** The matched category. */
	category: string;
	/** Confidence score between 0 and 1. */
	confidence: number;
}

// ---------------------------------------------------------------------------
// LLM service (public API for apps)
// ---------------------------------------------------------------------------

/** Full completion result returned by `LLMService.completeWithMeta`. */
export interface LLMCompletionMeta {
	/** Generated text. */
	text: string;
	/** Why the model stopped generating. */
	finishReason: LLMFinishReason;
	/** Token usage (when reported by the provider). */
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

/** LLM interface provided to apps via CoreServices. */
export interface LLMService {
	/**
	 * Generate a text completion.
	 *
	 * Model selection priority:
	 * 1. options.modelRef — explicit provider + model
	 * 2. options.tier — semantic tier (fast/standard/reasoning)
	 * 3. options.model === 'claude' — maps to 'standard' tier (backward compat)
	 * 4. options.model === 'local' — maps to 'fast' tier (backward compat)
	 * 5. Default — 'fast' tier
	 */
	complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;

	/**
	 * Like `complete()` but returns the text alongside the model's finish reason
	 * (and usage when reported). Use this when the caller needs to know whether
	 * the output was cut off by `max_tokens` (`finishReason === 'length'`) so it
	 * can re-prompt for continuation. Same model-selection priority as `complete()`.
	 */
	completeWithMeta(prompt: string, options?: LLMCompletionOptions): Promise<LLMCompletionMeta>;

	/**
	 * Classify text into one of the given categories.
	 * Uses the fast tier model.
	 */
	classify(text: string, categories: string[]): Promise<ClassifyResult>;

	/**
	 * Extract structured data from text according to a JSON schema.
	 * Uses the fast tier model.
	 */
	extractStructured<T>(text: string, schema: object): Promise<T>;

	/**
	 * Get the current model assignment for a tier.
	 * Returns a human-readable string like "anthropic/claude-haiku-4-5-20251001".
	 */
	getModelForTier?(tier: ModelTier): string;
}
