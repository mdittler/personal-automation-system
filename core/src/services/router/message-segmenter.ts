/**
 * Message segmenter — splits a single inbound user message into independent
 * request segments so the router (Task 4.3) can dispatch each one.
 *
 * Two-stage pipeline (mirrors session-control-classifier):
 *  1. preFilterMultiIntent — synchronous, zero-cost heuristic gate.
 *  2. segmentMessage       — fast-tier LLM segmentation (only when the
 *                            prefilter passes; the caller is responsible
 *                            for the prefilter check).
 *
 * Untrusted-output contract: the LLM result is parsed defensively. On any
 * malformed / hallucinated output we degrade to the original single message
 * (`[text]`) so we never drop a request and never emit garbage downstream.
 *
 * Overflow contract: if the LLM returns MORE than MAX_SEGMENTS segments, the
 * trailing overflow is MERGED into the final returned segment so no question
 * is dropped. (Codex review explicitly flagged the previous "degrade on >3"
 * wording in the plan as contradictory; the correct behaviour is merge-overflow.)
 */

import type { LLMCompletionOptions } from '../../types/llm.js';
import { UNPARSEABLE_JSON, tryParseJsonStripFences } from '../../utils/json-strip-fences.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of segments returned to the caller. Overflow merges into the last. */
export const MAX_SEGMENTS = 3;

/**
 * Minimum length (chars) before the prefilter will consider a message as
 * potentially multi-intent. Avoids LLM-call thrash on very short messages
 * that happen to contain a continuation marker (e.g. "also hi").
 */
const MIN_MULTI_INTENT_LENGTH = 25;

/**
 * Anti-hallucination cap: if the reconstructed total length of returned
 * segments exceeds this ratio of the original message length, we treat the
 * LLM output as hallucinated and degrade to the single-message fallback.
 */
const MAX_RECONSTRUCT_RATIO = 1.5;

/**
 * Word-bounded continuation markers that strongly suggest multi-intent.
 *
 * Bare "and" is intentionally OMITTED — it appears in too many single-intent
 * messages ("milk and eggs", "the menu and the calendar") to be a useful
 * gate. The LLM stage handles those cases; the prefilter just decides
 * whether the LLM stage is worth the call.
 */
const CONTINUATION_MARKERS = [
	'also',
	'additionally',
	'as well',
	'one more thing',
	'plus',
	'then',
] as const;

const CONTINUATION_MARKER_RE = new RegExp(
	`\\b(?:${CONTINUATION_MARKERS.map((m) => m.replace(/\s+/g, '\\s+')).join('|')})\\b`,
	'i',
);

/** Sentence-final '?' followed by additional non-whitespace text. */
const SENTENCE_FINAL_QUESTION_RE = /\?\s+\S/;

// ─── Dependency interfaces ───────────────────────────────────────────────────

/**
 * LLM client surface required by `segmentMessage`. Matches the
 * `LLMService.complete` signature so a real service can be injected directly.
 */
export interface SegmenterLLM {
	complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;
}

export interface SegmenterDeps {
	llm: SegmenterLLM;
	/** Optional structured logger; only `warn` is used. */
	logger?: { warn(obj: unknown, msg?: string): void };
}

// ─── Synchronous prefilter ───────────────────────────────────────────────────

/**
 * Synchronous, zero-cost gate. Returns true iff the message MIGHT contain
 * multiple independent intents and is therefore worth a `segmentMessage`
 * LLM call.
 *
 * Returns false for any message below `MIN_MULTI_INTENT_LENGTH` chars,
 * regardless of marker presence.
 */
export function preFilterMultiIntent(text: string): boolean {
	if (text.length < MIN_MULTI_INTENT_LENGTH) return false;
	if (SENTENCE_FINAL_QUESTION_RE.test(text)) return true;
	if (CONTINUATION_MARKER_RE.test(text)) return true;
	return false;
}

// ─── Prompt fencing ──────────────────────────────────────────────────────────

/**
 * Wrap untrusted user text so it cannot inject segmentation instructions.
 * Sanitises backtick fences (via sanitizeInput), strips angle brackets, then
 * wraps in <message> tags — same shape as session-control-classifier's
 * fenceUntrusted.
 */
function fenceUntrusted(text: string): string {
	const safe = sanitizeInput(text).replace(/[<>]/g, '');
	return `<message>\n${safe}\n</message>`;
}

const SEGMENTER_SYSTEM_PROMPT = `You are segmenting a single user message into up to ${MAX_SEGMENTS} independent request segments.

Rules:
- Drop greeting fragments ("Good morning!", "hi", "thanks") — they are not requests.
- If the message contains only ONE request, return {"segments":["the original message unchanged"]}.
- A dependent clause ("...and do that for tomorrow too") MUST stay attached to its parent — do not split it.
- Return at most ${MAX_SEGMENTS} segments. If there are more, you decide how to group; the consumer will merge overflow into the last segment.
- Respond ONLY with valid JSON, no markdown fences, no explanation:
{"segments": ["...", "..."]}`;

// ─── segmentMessage ──────────────────────────────────────────────────────────

/**
 * Split a message into up to `MAX_SEGMENTS` independent request segments.
 *
 * Returns `[text]` (the original message, unchanged) when:
 *   - the LLM call throws,
 *   - the LLM returns 0 usable segments,
 *   - the parsed payload is the wrong shape (not `{segments: string[]}`),
 *   - any returned element is not a non-empty trimmed string,
 *   - the reconstructed total length of returned segments exceeds
 *     `MAX_RECONSTRUCT_RATIO * text.length` (hallucination guard).
 *
 * If the LLM returns more than `MAX_SEGMENTS` valid segments, the trailing
 * overflow is JOINED with a single space into the final returned segment so
 * no request is dropped.
 */
export async function segmentMessage(text: string, deps: SegmenterDeps): Promise<string[]> {
	const fallback: string[] = [text];

	let raw: string;
	try {
		raw = await deps.llm.complete(fenceUntrusted(text), {
			tier: 'fast',
			systemPrompt: SEGMENTER_SYSTEM_PROMPT,
			maxTokens: 400,
			temperature: 0,
			responseFormat: 'json',
		});
	} catch (err) {
		deps.logger?.warn({ err }, 'segmentMessage: LLM call failed; degrading to single segment');
		return fallback;
	}

	const parsed = tryParseJsonStripFences(raw);
	if (parsed === UNPARSEABLE_JSON) {
		deps.logger?.warn({ raw }, 'segmentMessage: LLM returned unparseable JSON');
		return fallback;
	}

	// Must be {segments: unknown[]} shape; reject null, arrays, primitives.
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return fallback;
	}
	const rawSegments = (parsed as Record<string, unknown>).segments;
	if (!Array.isArray(rawSegments)) return fallback;

	// Validate every element is a string; trim; drop empties.
	const cleaned: string[] = [];
	for (const s of rawSegments) {
		if (typeof s !== 'string') return fallback;
		const trimmed = s.trim();
		if (trimmed.length === 0) continue;
		cleaned.push(trimmed);
	}
	if (cleaned.length === 0) return fallback;

	// Anti-hallucination: reconstructed total length must not blow past the original.
	const reconstructedLength = cleaned.reduce((acc, s) => acc + s.length, 0);
	if (reconstructedLength > text.length * MAX_RECONSTRUCT_RATIO) {
		deps.logger?.warn(
			{ originalLength: text.length, reconstructedLength },
			'segmentMessage: reconstructed length exceeds 1.5x cap; degrading to single segment',
		);
		return fallback;
	}

	// Cap at MAX_SEGMENTS by MERGING overflow into the last segment (Codex contract).
	if (cleaned.length <= MAX_SEGMENTS) return cleaned;
	const head = cleaned.slice(0, MAX_SEGMENTS - 1);
	const tail = cleaned.slice(MAX_SEGMENTS - 1).join(' ');
	return [...head, tail];
}
