/**
 * Model capability lookup table.
 *
 * Shared source of truth for per-model request-parameter support.
 * Used by the provider clients to decide which optional sampling
 * parameters may be sent on a completion request.
 *
 * Newer Anthropic models reject `temperature` outright with
 * `400 invalid_request_error: \`temperature\` is deprecated for this model.`
 * rather than ignoring it, so sending it unconditionally fails the whole call.
 */

export interface ModelCapabilities {
	/**
	 * Whether the model accepts a `temperature` sampling parameter.
	 * `false` means the provider request must omit the field entirely.
	 */
	supportsTemperature: boolean;
}

/**
 * Per-model capability flags (probed against the live provider APIs 2026-09-01).
 *
 * Only models with an observed result are listed. Anything absent is treated as
 * fully capable — see `supportsTemperature()`.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
	// Anthropic — reject `temperature` (probed: 400 "`temperature` is deprecated for this model.")
	'claude-fable-5-1': { supportsTemperature: false },
	'claude-fable-5': { supportsTemperature: false },
	'claude-opus-5': { supportsTemperature: false },
	'claude-sonnet-5': { supportsTemperature: false },
	'claude-opus-4-8': { supportsTemperature: false },
	'claude-opus-4-7': { supportsTemperature: false },

	// Anthropic — accept `temperature` (probed OK)
	'claude-opus-4-6': { supportsTemperature: true },
	'claude-sonnet-4-6': { supportsTemperature: true },
	'claude-sonnet-4-5': { supportsTemperature: true },
	'claude-sonnet-4-5-20250929': { supportsTemperature: true },
	'claude-opus-4-5-20251101': { supportsTemperature: true },
	'claude-haiku-4-5': { supportsTemperature: true },
	'claude-haiku-4-5-20251001': { supportsTemperature: true },
};

/**
 * Get the capability record for a model. Returns null for unknown models.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities | null {
	// hasOwn guard: a model id like "constructor" must not resolve through
	// Object.prototype and hand back a non-ModelCapabilities value.
	return Object.hasOwn(MODEL_CAPABILITIES, modelId) ? (MODEL_CAPABILITIES[modelId] ?? null) : null;
}

/**
 * Returns true when the model accepts a `temperature` parameter.
 *
 * Unknown models default to `true` so behaviour is unchanged for anything not
 * yet probed; the self-healing retry in BaseProvider covers the case where an
 * unlisted model turns out to reject the parameter.
 */
export function supportsTemperature(modelId: string): boolean {
	return getModelCapabilities(modelId)?.supportsTemperature ?? true;
}

/**
 * Which output-limit field an OpenAI-compatible chat request must carry.
 * `max_tokens` is deprecated by OpenAI and rejected by o-series reasoning
 * models (openai 6.27 `completions.d.ts`: "not compatible with o-series
 * models"); `max_completion_tokens` is unknown to many OpenAI-compatible
 * servers (Groq, vLLM, llama-server, Ollama /v1). So: reasoning-model ids
 * (`o1`, `o3`, `o4-mini`, …, `gpt-5*`) get the new field; everything else keeps
 * `max_tokens`. Namespaced ids (`openai/o3-mini`) are served by routers and
 * keep `max_tokens`.
 */
export function openAIOutputLimitField(modelId: string): 'max_tokens' | 'max_completion_tokens' {
	return /^(o[1-9](-|$)|gpt-5(-|$|\.))/.test(modelId) ? 'max_completion_tokens' : 'max_tokens';
}
