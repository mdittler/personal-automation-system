/**
 * Tolerant JSON parsing for LLM responses.
 *
 * LLMs occasionally wrap JSON output in markdown code fences (```json ... ```)
 * even when instructed otherwise. These helpers strip the fences and attempt
 * to parse, returning a sentinel for empty/invalid output rather than throwing.
 *
 * Centralized here so future local-model quirks (different fence flavors,
 * leading whitespace patterns) get one canonical home. `classifyStructuredOutput`
 * below extends that home to the recurring "budget ran out" quirk: a reply cut
 * off at `maxTokens` must be reported as truncation, never as malformed output.
 */

import type { LLMCompletionMeta } from '../types/llm.js';

const FENCE_OPEN_RE = /^```(?:json)?\s*/i;
const FENCE_CLOSE_RE = /\s*```\s*$/i;

/** Strip leading/trailing markdown code fences and trim whitespace. */
export function stripJsonFences(raw: string): string {
	return raw.replace(FENCE_OPEN_RE, '').replace(FENCE_CLOSE_RE, '').trim();
}

/** Sentinel returned by `tryParseJsonStripFences` for empty/unparseable input. */
export const UNPARSEABLE_JSON = Symbol('unparseable-json');

/** Strip fences and JSON.parse. Returns `UNPARSEABLE_JSON` on empty or invalid input. */
export function tryParseJsonStripFences(raw: string): unknown | typeof UNPARSEABLE_JSON {
	const stripped = stripJsonFences(raw);
	if (stripped.length === 0) return UNPARSEABLE_JSON;
	try {
		return JSON.parse(stripped);
	} catch {
		return UNPARSEABLE_JSON;
	}
}

// ---------------------------------------------------------------------------
// Structured-output classification (truncation vs. malformed output)
// ---------------------------------------------------------------------------

/**
 * Default number of characters of a raw reply echoed into a diagnostic.
 * Enough to see where the model stopped, short enough for a log line.
 */
export const RAW_PREVIEW_MAX_CHARS = 200;

/**
 * Render a slice of an LLM reply for a diagnostic message.
 *
 * `JSON.stringify` (not a bare slice) on purpose: these previews land in log
 * lines, in `MeteredError` messages and in regression-report verdict details,
 * so a multi-line or control-character-bearing reply must stay on one line and
 * arrive escaped. The returned string includes its own surrounding quotes.
 */
export function formatRawPreview(raw: string, maxChars: number = RAW_PREVIEW_MAX_CHARS): string {
	return JSON.stringify(raw.slice(0, maxChars));
}

/**
 * Outcome of interpreting one LLM completion that was supposed to be JSON.
 *
 * `truncated` exists so a reply the provider cut at the caller's `maxTokens`
 * budget is never reported as *malformed output*: the model did not misbehave,
 * the budget ran out. `empty` stays separate from both because several callers
 * retry exactly once on empty output (some local models return `''` for
 * ambiguous prompts) and must not retry the other two.
 */
export type StructuredOutputResult =
	/** Parsed successfully. `value` is the raw `JSON.parse` result — still untrusted, still needs schema validation. */
	| { kind: 'ok'; value: unknown }
	/** Provider reported `finishReason === 'length'`. `maxTokens` is the budget the caller passed, when it passed one. */
	| { kind: 'truncated'; raw: string; maxTokens?: number }
	/** Reply was empty or whitespace-only. */
	| { kind: 'empty'; raw: string }
	/** Non-empty, complete, and not valid JSON — the model genuinely malformed its output. */
	| { kind: 'unparseable'; raw: string };

/**
 * Whether `finishReason === 'length'` is consulted before or after parsing.
 *
 * **This is deliberately a caller choice, not a fixed rule.** The two orderings
 * disagree on exactly one input: a reply that was cut at the cap but whose
 * prefix happens to be valid JSON.
 *
 * - `'check-length-first'` — a cap-truncated reply is untrusted even when its
 *   prefix parses. Correct where a shorter-but-valid parse is still *wrong*:
 *   a judge whose `explanation` was cut off (`regression/src/oracles/rubric.ts`),
 *   or an array reply where losing trailing elements silently drops user
 *   content (`core/src/services/router/message-segmenter.ts`).
 * - `'parse-first'` — a reply that satisfies the schema is complete by
 *   construction, so the finish reason is moot on the good path and only
 *   decides *which* failure to report. Correct for small closed objects that
 *   are fully validated after parsing
 *   (`apps/food/src/routing/shadow-classifier.ts`).
 *
 * Picking one silently in this helper would regress whichever site disagrees,
 * so there is no default.
 */
export type StructuredOutputOrder = 'check-length-first' | 'parse-first';

export interface ClassifyStructuredOutputOptions {
	/** See `StructuredOutputOrder`. Required — there is no safe default. */
	order: StructuredOutputOrder;
	/**
	 * The `maxTokens` budget the completion was requested with, carried through
	 * onto a `truncated` result so the caller's diagnostic can name the cap.
	 * Omit when the call inherits the provider default.
	 */
	maxTokens?: number;
}

/**
 * Classify one LLM completion that was supposed to be JSON.
 *
 * Classification only — no logging, no retry, no fallback. Every call site
 * keeps its own policy (their result types all differ), so each switches on
 * the returned `kind`.
 *
 * Empty output is decided BEFORE the ordering choice under both orderings: an
 * empty reply carries no prefix to trust or distrust, and the callers that
 * retry on empty must keep doing so even when the provider also reports
 * `'length'` (a provider that burns its whole budget producing nothing already
 * raises `LLMEmptyOutputError` one layer down).
 */
export function classifyStructuredOutput(
	meta: Pick<LLMCompletionMeta, 'text' | 'finishReason'>,
	options: ClassifyStructuredOutputOptions,
): StructuredOutputResult {
	const raw = meta.text ?? '';
	if (raw.trim().length === 0) return { kind: 'empty', raw };

	const truncated = (): StructuredOutputResult =>
		options.maxTokens === undefined
			? { kind: 'truncated', raw }
			: { kind: 'truncated', raw, maxTokens: options.maxTokens };

	if (options.order === 'check-length-first' && meta.finishReason === 'length') {
		return truncated();
	}

	const parsed = tryParseJsonStripFences(raw);
	if (parsed !== UNPARSEABLE_JSON) return { kind: 'ok', value: parsed };

	// Reached under 'parse-first' with a failed parse, and under
	// 'check-length-first' only when the reply was NOT cut at the cap.
	if (meta.finishReason === 'length') return truncated();
	return { kind: 'unparseable', raw };
}
