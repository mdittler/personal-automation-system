/**
 * Session-control classifier.
 *
 * Detects whether a free-text user message is requesting a new chat session
 * (i.e. the natural-language equivalent of /newchat).
 *
 * Two-stage pipeline:
 *  1. preFilterSessionControl — synchronous keyword gate (no LLM cost)
 *  2. classifySessionControl  — fast-tier LLM classifier
 *
 * Combined entry point: detectSessionControl
 *
 * LLM output is treated as untrusted and coerced to a safe default on any
 * parse failure.
 */

import type { LLMCompletionMeta, LLMCompletionOptions } from '../../types/llm.js';
import { classifyStructuredOutput, formatRawPreview } from '../../utils/json-strip-fences.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionControlResult {
	intent: 'new_session' | 'continue' | 'unclear';
	confidence: number; // 0.0–1.0
	reason: string;
	source: 'prefilter' | 'llm';
}

export interface SessionControlClassifierDeps {
	/**
	 * `completeWithMeta` is required alongside `complete` so the classifier can
	 * tell a reply cut off at SESSION_CONTROL_MAX_TOKENS from a genuinely
	 * malformed one.
	 */
	llm: {
		complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;
		completeWithMeta(prompt: string, options?: LLMCompletionOptions): Promise<LLMCompletionMeta>;
	};
	logger: { warn(obj: unknown, msg?: string): void };
}

/**
 * Output budget for the classifier call. The answer is one small JSON object
 * with a short free-text `reason`, so 80 is ample — but the `reason` field is
 * the part a verbose model overruns, and a cut reply used to come back as
 * `reason: 'parse error'`, which reads as "the model emitted garbage".
 */
const SESSION_CONTROL_MAX_TOKENS = 80;

// ─── Pre-filter ───────────────────────────────────────────────────────────────

/**
 * Exact command strings that are unambiguously a new-session request.
 * Matched with strict equality only (case-insensitive) — no substring matching.
 * Natural-language phrases are intentionally excluded from this list so that
 * negations ("don't start over") and meta-questions ("what does /new do?") are
 * NOT auto-dispatched; they fall through to the LLM classifier instead.
 */
const SESSION_CONTROL_COMMANDS: readonly string[] = ['/newchat', '/new', '/reset'];

/**
 * Natural-language examples of new-session intent.
 * These are NOT used for pre-filter matching — they exist for documentation
 * purposes and as context when crafting the LLM classifier system prompt.
 * The LLM handles all NL phrasing; the pre-filter handles explicit commands only.
 */
export const SESSION_CONTROL_NL_EXAMPLES: readonly string[] = [
	'new chat',
	'new conversation',
	'start fresh',
	'start over',
	'fresh start',
	'begin new',
	'clear chat',
	'clear history',
	'reset chat',
	'reset conversation',
	'forget everything',
	"let's start over",
	'lets start over',
	'start a new chat',
	'start a new conversation',
];

/**
 * Batch 3 — Meta-question deterministic short-circuit. Phrases like
 * "what does /newchat do?" / "what is /reset" are NOT new-session requests;
 * they're help-style questions about the commands. Without this gate, Gemma
 * 4 e4b classifies them as new_session (evidenced in Chunk C verification).
 *
 * Pattern: `what (does|is|do)` followed by a slash-word — narrow enough to
 * avoid false positives on natural prose.
 */
const META_QUESTION_RE = /\bwhat\s+(?:does|is|do)\s+\/\w+/i;

export function preFilterSessionControl(
	text: string,
):
	| { matched: true; confidence: 1.0; reason: string; intent?: 'new_session' | 'continue' }
	| { matched: false } {
	const lower = text.trim().toLowerCase();
	// Meta-question check FIRST — beats command-equality so "what does /newchat do?"
	// (which contains the literal "/newchat" substring) doesn't get treated as
	// a session-control command. The command loop below uses strict equality so
	// the regex match here is the only path that catches meta-questions.
	if (META_QUESTION_RE.test(lower)) {
		return {
			matched: true,
			confidence: 1.0,
			reason: 'meta-question about a command',
			intent: 'continue',
		};
	}
	for (const cmd of SESSION_CONTROL_COMMANDS) {
		if (lower === cmd) {
			return { matched: true, confidence: 1.0, reason: `command: ${cmd}` };
		}
	}
	return { matched: false };
}

// ─── LLM classifier ───────────────────────────────────────────────────────────

/**
 * Wrap untrusted user text so it cannot inject classifier instructions.
 * Sanitizes backtick fences (via sanitizeInput), strips angle brackets,
 * then wraps in <message> tags.
 */
function fenceUntrusted(text: string): string {
	const safe = sanitizeInput(text).replace(/[<>]/g, '');
	return `<message>\n${safe}\n</message>`;
}

const CLASSIFIER_SYSTEM_PROMPT =
	`You are a classifier. Determine if the user's message is requesting to start a new chat session, clear their conversation history, or begin fresh.\n\n` +
	'Respond ONLY with valid JSON, no markdown fences, no explanation:\n' +
	`{"intent":"new_session"|"continue"|"unclear","confidence":0.0-1.0,"reason":"brief reason"}\n\n` +
	`- "new_session": user wants to start fresh, reset, begin a new conversation\n` +
	`- "continue": user is continuing the current conversation (most messages)\n` +
	`- "unclear": could go either way\n\n` +
	'Examples:\n' +
	`- "start fresh" → {"intent":"new_session","confidence":0.95,"reason":"explicit start-over phrasing"}\n` +
	`- "what does /newchat do?" → {"intent":"continue","confidence":0.95,"reason":"meta-question about a command, not a session-reset request"}\n` +
	`- "don't start over" → {"intent":"continue","confidence":0.9,"reason":"negation of reset"}`;

export async function classifySessionControl(
	text: string,
	deps: SessionControlClassifierDeps,
): Promise<SessionControlResult> {
	const SAFE_DEFAULT: SessionControlResult = {
		intent: 'unclear',
		confidence: 0,
		reason: 'parse error',
		source: 'llm',
	};

	let meta: LLMCompletionMeta;
	try {
		// completeWithMeta (not complete) so `finishReason` is visible: a reply cut
		// off at SESSION_CONTROL_MAX_TOKENS must be reported as truncation, not as
		// a parse error.
		meta = await deps.llm.completeWithMeta(fenceUntrusted(text), {
			tier: 'fast',
			systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
			maxTokens: SESSION_CONTROL_MAX_TOKENS,
			temperature: 0,
			responseFormat: 'json',
		});
	} catch (err) {
		deps.logger.warn({ err }, 'session-control classifier LLM call failed');
		return SAFE_DEFAULT;
	}

	// 'parse-first': the result is a closed object fully validated below, so a
	// reply that parses is complete by construction and the finish reason only
	// decides WHICH failure to report. There is no retry on this path and none is
	// added — every failure still yields the safe default, which is 'unclear' and
	// therefore a no-op for the caller.
	const outcome = classifyStructuredOutput(meta, {
		order: 'parse-first',
		maxTokens: SESSION_CONTROL_MAX_TOKENS,
	});
	if (outcome.kind === 'truncated') {
		deps.logger.warn(
			{ raw: formatRawPreview(outcome.raw) },
			`session-control classifier: LLM response truncated at the ${SESSION_CONTROL_MAX_TOKENS}-token cap (finishReason='length') — the model did not finish its JSON object; the budget ran out`,
		);
		return { ...SAFE_DEFAULT, reason: 'truncated' };
	}
	if (outcome.kind !== 'ok') {
		deps.logger.warn(
			{ raw: outcome.raw },
			'session-control classifier: failed to parse LLM response',
		);
		return SAFE_DEFAULT;
	}
	return validateSessionControlResult(outcome.value, SAFE_DEFAULT);
}

// ─── Output validation ────────────────────────────────────────────────────────

const VALID_INTENTS = new Set(['new_session', 'continue', 'unclear']);

/**
 * Validate an already-parsed classifier payload. The JSON parse (and the
 * truncated / empty / unparseable split) happens in `classifySessionControl`
 * via `classifyStructuredOutput`; this function only judges the shape.
 */
function validateSessionControlResult(
	parsed: unknown,
	safeDefault: SessionControlResult,
): SessionControlResult {
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return safeDefault;
	}
	const obj = parsed as Record<string, unknown>;

	// Validate intent
	if (typeof obj.intent !== 'string' || !VALID_INTENTS.has(obj.intent)) {
		return safeDefault;
	}
	const intent = obj.intent as 'new_session' | 'continue' | 'unclear';

	// Validate confidence
	if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
		return safeDefault;
	}
	const confidence = obj.confidence;

	// reason: string, truncate to 100 chars
	let reason = 'classified';
	if (typeof obj.reason === 'string') reason = obj.reason.slice(0, 100);

	return { intent, confidence, reason, source: 'llm' };
}

// ─── Combined entry point ─────────────────────────────────────────────────────

/**
 * Detect whether the user's message is a session-reset request.
 *
 * Runs preFilterSessionControl first (no LLM cost). If matched, returns
 * immediately with source:'prefilter'. Otherwise calls classifySessionControl
 * (fast-tier LLM).
 */
export async function detectSessionControl(
	text: string,
	deps: SessionControlClassifierDeps,
): Promise<SessionControlResult> {
	const preFilter = preFilterSessionControl(text);
	if (preFilter.matched) {
		return {
			intent: preFilter.intent ?? 'new_session',
			confidence: 1.0,
			reason: preFilter.reason,
			source: 'prefilter',
		};
	}
	return classifySessionControl(text, deps);
}
