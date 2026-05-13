/**
 * Tolerant JSON parsing for LLM responses.
 *
 * LLMs occasionally wrap JSON output in markdown code fences (```json ... ```)
 * even when instructed otherwise. These helpers strip the fences and attempt
 * to parse, returning a sentinel for empty/invalid output rather than throwing.
 *
 * Centralized here so future local-model quirks (different fence flavors,
 * leading whitespace patterns) get one canonical home.
 */

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
