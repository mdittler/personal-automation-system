/**
 * Recall intent classifier for Hermes P5.
 *
 * Two-stage pipeline:
 *  1. recallPreFilter — synchronous heuristic gate (no LLM cost)
 *  2. classifyRecallIntent — LLM fast-tier classifier (only reached when pre-filter passes)
 *
 * The LLM output is treated as untrusted and coerced to a safe default on any
 * parse failure. shouldRecall=true with no valid query string is rejected.
 *
 * LLM interface matches LLMService.complete signature (prompt: string, options?) => Promise<string>.
 */

import type { LLMCompletionOptions } from '../../types/llm.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

// ─── Pre-filter ───────────────────────────────────────────────────────────────

export interface PreFilterResult {
	skip: boolean;
	reason: string;
}

const GREETINGS = new Set(['hi', 'hello', 'thanks', 'thank you', 'ok', 'okay', 'yes', 'no', 'bye']);

export function recallPreFilter(message: string): PreFilterResult {
	const trimmed = message.trim();
	// Slash commands skip recall — /ask strips its own prefix before calling this function
	if (trimmed.startsWith('/')) {
		return { skip: true, reason: 'slash-command' };
	}
	// Too short
	if (trimmed.length < 10) {
		return { skip: true, reason: 'too-short' };
	}
	// Pure greeting (strip punctuation before checking)
	const lower = trimmed.toLowerCase().replace(/[^a-z\s]/g, '').trim();
	if (GREETINGS.has(lower)) {
		return { skip: true, reason: 'greeting' };
	}
	// Emoji/sticker only (no ASCII letters)
	if (!/[a-zA-Z]/.test(trimmed)) {
		return { skip: true, reason: 'no-text' };
	}
	return { skip: false, reason: 'proceed' };
}

// ─── LLM classifier ───────────────────────────────────────────────────────────

export interface RecallVerdict {
	shouldRecall: boolean;
	query: string | null;
	timeWindow: 'recent' | 'older' | null;
	reason: string;
}

export interface RecallClassifierLLM {
	complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;
}

export interface RecallClassifierDeps {
	llm: RecallClassifierLLM;
	logger: { warn(obj: unknown, msg?: string): void };
}

const CLASSIFIER_SYSTEM_PROMPT =
	`You are a recall intent classifier. Determine if the user message is asking about past conversations or trying to recall something discussed previously.` +
	` Respond with ONLY valid JSON (no markdown, no explanation):` +
	` {"shouldRecall": boolean, "query": string or null, "timeWindow": "recent" | "older" | null, "reason": string}` +
	` Rules: shouldRecall=true ONLY if the user explicitly asks about past conversations, prior discussions, or things discussed before.` +
	` query = key topic/phrase to search for (1-5 words), null if shouldRecall=false.` +
	` timeWindow="recent" if time reference implies <2 weeks, "older" if earlier, null if not time-specified.` +
	` reason = brief explanation (under 20 words).`;

export async function classifyRecallIntent(
	message: string,
	deps: RecallClassifierDeps,
): Promise<RecallVerdict> {
	let raw: string;
	try {
		raw = await deps.llm.complete(sanitizeInput(message), {
			tier: 'fast',
			systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
			maxTokens: 150,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'recall classifier LLM call failed');
		return { shouldRecall: false, query: null, timeWindow: null, reason: 'llm-error' };
	}
	return parseRecallVerdict(raw, deps);
}

// ─── Output validation ────────────────────────────────────────────────────────

function parseRecallVerdict(raw: string, deps: RecallClassifierDeps): RecallVerdict {
	const SAFE_DEFAULT: RecallVerdict = {
		shouldRecall: false,
		query: null,
		timeWindow: null,
		reason: 'parse-failed',
	};
	try {
		// Strip markdown code fences if present
		const json = raw
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/\s*```\s*$/i, '')
			.trim();
		const parsed = JSON.parse(json) as unknown;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return SAFE_DEFAULT;
		const obj = parsed as Record<string, unknown>;

		// shouldRecall: must be literal boolean true/false (string 'true' → rejected)
		if (typeof obj.shouldRecall !== 'boolean') return SAFE_DEFAULT;

		// query: string or null; if shouldRecall=true and query is missing/empty → reject
		let query: string | null = null;
		if (obj.query !== null && obj.query !== undefined) {
			if (typeof obj.query !== 'string') return SAFE_DEFAULT;
			const q = obj.query.trim();
			if (q.length === 0 || q.length > 200) return SAFE_DEFAULT;
			query = q;
		}
		if (obj.shouldRecall === true && query === null) return SAFE_DEFAULT;

		// timeWindow: 'recent' | 'older' | null
		let timeWindow: 'recent' | 'older' | null = null;
		if (obj.timeWindow === 'recent') timeWindow = 'recent';
		else if (obj.timeWindow === 'older') timeWindow = 'older';
		else if (obj.timeWindow !== null && obj.timeWindow !== undefined) timeWindow = null; // coerce invalid to null

		// reason: string, truncate to 100 chars
		let reason = 'classified';
		if (typeof obj.reason === 'string') reason = obj.reason.slice(0, 100);

		return { shouldRecall: obj.shouldRecall, query, timeWindow, reason };
	} catch (err) {
		deps.logger.warn({ err }, 'recall classifier: failed to parse LLM response');
		return SAFE_DEFAULT;
	}
}
