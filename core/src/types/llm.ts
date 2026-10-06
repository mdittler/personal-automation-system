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

	/**
	 * Enable a thinking / reasoning phase on providers that support one.
	 *
	 * **Default OFF, and deliberately so.** PAS calls are single-shot with tight
	 * `maxTokens` budgets, and a thinking phase competes with the visible answer
	 * for that same budget. Thinking-capable Ollama models default to thinking ON
	 * and will happily spend the entire `num_predict` allowance inside the
	 * separate `thinking` field, returning an empty `response` — which is how
	 * every routing regression case once failed with "Unexpected end of JSON
	 * input". Sending `think: false` explicitly is what prevents that.
	 *
	 * A caller that genuinely wants a reasoning phase must set `thinking: true`
	 * **and** raise `maxTokens` to cover both the reasoning and the answer.
	 *
	 * Only Ollama honours this today; other providers ignore it. Non-thinking
	 * Ollama models accept and ignore the flag.
	 *
	 * Since Agent Runtime P1 this also accepts a `ThinkingLevel`
	 * (`'off' | 'low' | 'medium' | 'high'`). `false` and `'off'` are
	 * identical; `true` asks the provider for its default effort. Only Ollama
	 * honours any of these; other providers ignore the field.
	 */
	thinking?: boolean | ThinkingLevel;
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
	/** Chat with optional tools. Same retry, temperature self-heal, and cost recording as completeWithUsage. */
	chatWithUsage(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
	/**
	 * Whether `modelId` on this provider accepts native tool definitions.
	 * Rejects (does not return false) when the probe itself fails, so callers
	 * can tell "this model lacks tools" from "the provider is unreachable".
	 */
	supportsTools(modelId: string): Promise<boolean>;
	/** Whether `modelId` on this provider accepts image input. Same rejection rule as supportsTools. */
	supportsVisionModel(modelId: string): Promise<boolean>;
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

// ---------------------------------------------------------------------------
// Chat with tools (Agent Runtime P1 — design §5)
// ---------------------------------------------------------------------------

/** Reasoning effort for providers that expose one (Ollama `think`). */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool call the model asked for. `arguments` is whatever the provider returned (an object, or a raw string when it could not be parsed — P2 validates). */
export interface ToolCallRequest {
	id: string;
	name: string;
	arguments: unknown;
}

/** A tool offered to the model. `inputSchema` is JSON Schema (root type object). */
export interface ChatToolSpec {
	name: string;
	description: string;
	inputSchema: object;
}

export interface ChatMessage {
	role: ChatRole;
	content: string;
	/** User turns only (photos). */
	images?: LLMImage[];
	/** Assistant turns: the tool calls the model made. */
	toolCalls?: ToolCallRequest[];
	/** Tool turns: the id of the call this message answers. */
	toolCallId?: string;
	/** Tool turns: the tool's name (Ollama needs it; others ignore it). */
	toolName?: string;
	/** Tool turns: the result is an error message for the model, not data. */
	isError?: boolean;
	/** Assistant turns: provider thinking, passed back within a turn only (design §5.3). */
	thinking?: string;
}

export interface ChatOptions
	extends Pick<
		LLMCompletionOptions,
		'tier' | 'modelRef' | 'maxTokens' | 'temperature' | 'thinking'
	> {
	tools?: ChatToolSpec[];
	/** Allow the model to request several tool calls in one step. Default true. */
	parallelToolCalls?: boolean;
	/** Cancels the in-flight SDK request. Honoured by every provider on this path. */
	signal?: AbortSignal;
	/** Ollama `num_ctx`. Defaults to DEFAULT_CHAT_CONTEXT_WINDOW (32768). */
	contextWindow?: number;
	/** Ollama `keep_alive`. Defaults to DEFAULT_OLLAMA_KEEP_ALIVE ('30m'). */
	keepAlive?: string | number;
	/** App ID for cost attribution. Injected by the guards — callers must not set this. */
	_appId?: string;
}

/** `tool_calls` whenever the assistant message carries tool calls, regardless of the provider's own stop reason. */
export type ChatFinishReason = 'stop' | 'tool_calls' | 'length' | 'error' | 'other';

export interface ChatUsage {
	/** Uncached prompt tokens (Anthropic `input_tokens`; the whole prompt on other providers). Billed at the input rate. */
	inputTokens: number;
	outputTokens: number;
	/**
	 * Anthropic `cache_creation_input_tokens`, when reported. NOT included in
	 * `inputTokens` and NOT billed by `CostTracker` in P1 (which has one input
	 * rate; cache writes bill 1.25×, reads 0.1×). P1 sends no `cache_control`,
	 * so this is 0 or absent; P2 adds cache-aware pricing before enabling it.
	 */
	cacheCreationTokens?: number;
	/** Anthropic `cache_read_input_tokens`, same rules as `cacheCreationTokens`. */
	cacheReadTokens?: number;
}

export interface ChatResult {
	/** Always role 'assistant'. */
	message: ChatMessage;
	finishReason: ChatFinishReason;
	usage?: ChatUsage;
	/** Model id that served the request. */
	model: string;
	/** Provider key that served the request. */
	provider: string;
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
	 * Chat with tools. Model selection priority is the same as `complete()`
	 * minus the legacy options: `modelRef`, then `tier`, then the fast tier.
	 * Throws `LLMToolsUnsupportedError` before any inference call when `tools`
	 * are given and the resolved model cannot accept them (the capability
	 * probe itself — Ollama `/api/show` — may run first).
	 */
	chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;

	/** False when the provider is not registered; otherwise the provider's answer (which may reject). */
	supportsTools(ref: ModelRef): Promise<boolean>;

	/** False when the provider is not registered; otherwise the provider's answer (which may reject). */
	supportsVision(ref: ModelRef): Promise<boolean>;

	/**
	 * Get the current model assignment for a tier.
	 * Returns a human-readable string like "anthropic/claude-haiku-4-5-20251001".
	 */
	getModelForTier?(tier: ModelTier): string;
}
