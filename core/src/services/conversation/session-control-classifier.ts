/**
 * Session-control classifier for Hermes P7.
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

import type { LLMCompletionOptions } from '../../types/llm.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionControlResult {
	intent: 'new_session' | 'continue' | 'unclear';
	confidence: number; // 0.0–1.0
	reason: string;
	source: 'prefilter' | 'llm';
}

export interface SessionControlClassifierDeps {
	llm: { complete(prompt: string, options?: LLMCompletionOptions): Promise<string> };
	logger: { warn(obj: unknown, msg?: string): void };
}

// ─── Pre-filter ───────────────────────────────────────────────────────────────

/**
 * Keywords and phrases that strongly indicate a new-session request.
 * Checked via exact equality OR substring inclusion (case-insensitive).
 */
const SESSION_CONTROL_KEYWORDS: readonly string[] = [
	// Exact command matches
	'/newchat',
	'/new',
	'/reset',
	// Phrases
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

export function preFilterSessionControl(
	text: string,
): { matched: true; confidence: 1.0; reason: string } | { matched: false } {
	const lower = text.trim().toLowerCase();
	for (const keyword of SESSION_CONTROL_KEYWORDS) {
		if (lower === keyword || lower.includes(keyword)) {
			return { matched: true, confidence: 1.0, reason: `keyword match: ${keyword}` };
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
	`Respond ONLY with valid JSON, no markdown fences, no explanation:\n` +
	`{"intent":"new_session"|"continue"|"unclear","confidence":0.0-1.0,"reason":"brief reason"}\n\n` +
	`- "new_session": user wants to start fresh, reset, begin a new conversation\n` +
	`- "continue": user is continuing the current conversation (most messages)\n` +
	`- "unclear": could go either way`;

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

	let raw: string;
	try {
		raw = await deps.llm.complete(fenceUntrusted(text), {
			tier: 'fast',
			systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
			maxTokens: 80,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'session-control classifier LLM call failed');
		return SAFE_DEFAULT;
	}

	return parseSessionControlResult(raw, deps, SAFE_DEFAULT);
}

// ─── Output validation ────────────────────────────────────────────────────────

const VALID_INTENTS = new Set(['new_session', 'continue', 'unclear']);

function parseSessionControlResult(
	raw: string,
	deps: SessionControlClassifierDeps,
	safeDefault: SessionControlResult,
): SessionControlResult {
	try {
		// Strip markdown code fences if present
		const json = raw
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/\s*```\s*$/i, '')
			.trim();

		const parsed = JSON.parse(json) as unknown;
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
	} catch (err) {
		deps.logger.warn({ err }, 'session-control classifier: failed to parse LLM response');
		return safeDefault;
	}
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
			intent: 'new_session',
			confidence: 1.0,
			reason: preFilter.reason,
			source: 'prefilter',
		};
	}
	return classifySessionControl(text, deps);
}
