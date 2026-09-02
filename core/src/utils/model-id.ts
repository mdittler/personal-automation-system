/**
 * Model-identifier validation — the single source of truth.
 *
 * Operator-supplied model ids arrive from three places, and before this module
 * existed they were validated by two different patterns that disagreed about
 * `/`:
 *
 *   - `gui/routes/llm-usage.ts`  (`POST /gui/llm/tiers`, `POST /gui/llm/models`)
 *   - `services/system-info/index.ts` (`setTierModel`, the chatbot
 *     `<switch-model>` control tag)
 *   - `services/regression/model-spec.ts` (`--model-matrix` / `--judge-model`)
 *
 * The regression parser deliberately allowed `/` so HuggingFace- and
 * Together-style namespaced ids work (`meta-llama/Llama-3.3-70B-Instruct-Turbo`,
 * `hf.co/bartowski/Foo-GGUF:Q4_K_M`); the other two rejected it. The result was
 * a model you could regression-test but could not assign to a tier. All three
 * now share the permissive form below.
 *
 * Security notes (this is an input validator on an untrusted-ish string —
 * operator-supplied via the GUI, LLM-supplied via `<switch-model>`):
 *
 *   - The pattern stays fully anchored (`^`…`$`) and length-bounded.
 *   - The first character must be alphanumeric, so no leading `-`, `.`, `/`
 *     or `:` — this is a *tightening* relative to the old GUI pattern.
 *   - `/` is only meaningful as a namespace separator, so the traversal and
 *     empty-segment shapes it enables (`..`, `//`, trailing `/`) are rejected
 *     separately. No downstream consumer treats a model id as a path anyway:
 *     the only filesystem use is the model journal, which runs ids through
 *     `slugifyModelId()` and then re-validates against `MODEL_SLUG_PATTERN`;
 *     `ModelSelector.save()` writes the id as a YAML *value*; the GUI renders
 *     it through `escapeHtml()`; the regression CLI is spawned with an argv
 *     array and no shell.
 */

/**
 * Allowed model-id shape: alphanumeric first character, then alphanumerics plus
 * `. _ : / -`, up to 192 characters total.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;

/** Maximum accepted model-id length, in characters. */
export const MAX_MODEL_ID_CHARS = 192;

/**
 * True when `model` is a well-formed model identifier.
 *
 * Namespaced ids are accepted; traversal sequences, empty path segments and
 * trailing separators are not.
 */
export function isValidModelId(model: unknown): model is string {
	if (typeof model !== 'string') return false;
	if (!MODEL_ID_PATTERN.test(model)) return false;
	// MODEL_ID_PATTERN permits `.` and `/`, so guard the shapes that pairing
	// makes possible.
	if (model.includes('..')) return false;
	if (model.includes('//')) return false;
	if (model.endsWith('/')) return false;
	return true;
}
