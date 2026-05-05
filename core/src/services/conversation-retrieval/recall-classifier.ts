/**
 * Recall intent classifier for Hermes P5/P6.
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
import { isCalendarStrict } from '../../utils/temporal.js';
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
	const lower = trimmed
		.toLowerCase()
		.replace(/[^a-z\s]/g, '')
		.trim();
	if (GREETINGS.has(lower)) {
		return { skip: true, reason: 'greeting' };
	}
	// Emoji/sticker only (no ASCII letters)
	if (!/[a-zA-Z]/.test(trimmed)) {
		return { skip: true, reason: 'no-text' };
	}
	return { skip: false, reason: 'proceed' };
}

// ─── TimeAnchor type ──────────────────────────────────────────────────────────

export type TimeAnchor =
	| { type: 'absolute'; on: string } // 'YYYY-MM-DD' local
	| { type: 'window'; before?: string; after?: string } // YYYY-MM-DD local; both optional
	| null;

// ─── RecallVerdict ────────────────────────────────────────────────────────────

export interface RecallVerdict {
	shouldRecall: boolean;
	query: string | null;
	timeAnchor: TimeAnchor;
	reason: string;
}

export const RECALL_SAFE_DEFAULT: RecallVerdict = {
	shouldRecall: false,
	query: null,
	timeAnchor: null,
	reason: 'parse-failed',
};

// ─── LLM classifier interface ─────────────────────────────────────────────────

export interface RecallClassifierLLM {
	complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;
}

// ─── Prompt template ─────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT_BASE =
	'Today: <today>\n' +
	'You are a recall intent classifier. Determine if the user message is asking about past conversations or trying to recall something discussed previously.\n' +
	'Respond with ONLY valid JSON (no markdown, no explanation):\n' +
	'{"shouldRecall": boolean, "query": string or null, "timeAnchor": TimeAnchor, "reason": string}\n' +
	'\n' +
	'Where TimeAnchor is one of:\n' +
	'  null — no time reference\n' +
	'  {"type":"absolute","on":"YYYY-MM-DD"} — a specific past date\n' +
	'  {"type":"window","after":"YYYY-MM-DD","before":"YYYY-MM-DD"} — a date range (after and/or before, both optional)\n' +
	'\n' +
	'Rules:\n' +
	'  shouldRecall=true ONLY if the user explicitly asks about past conversations, prior discussions, or things discussed before.\n' +
	'  query = key topic/phrase to search for (1-5 words), null if shouldRecall=false.\n' +
	'  timeAnchor = use absolute for specific days, window for ranges, null if not time-specified.\n' +
	'  All dates must be YYYY-MM-DD format, in the past, and not more than 365 days before today.\n' +
	'  reason = brief explanation (under 20 words).';

/** Subtract N calendar days from a YYYY-MM-DD string (UTC noon arithmetic). */
function subtractDays(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Build dynamic date examples relative to today so the prompt never goes stale. */
function buildExamples(today: string): string {
	const d = new Date(`${today}T12:00:00Z`);
	const dow = d.getUTCDay(); // 0=Sun … 6=Sat
	const dayName = DOW_NAMES[dow] ?? 'Day';

	const yesterday = subtractDays(today, 1);

	// Last Tuesday: if today is Tue (2), go back 7; otherwise find most-recent prior Tuesday.
	const daysToLastTue = dow === 2 ? 7 : ((dow + 7 - 2) % 7 || 7);
	const lastTuesday = subtractDays(today, daysToLastTue);

	// "Two weeks ago" window: centred ~17 days back, ±3-day spread (11–23 days ago)
	const twoWeeksStart = subtractDays(today, 19);
	const twoWeeksEnd = subtractDays(today, 11);

	return (
		`\nExamples (today = ${today}, ${dayName}):\n` +
		`- "what did we say last Tuesday about the recipe"\n` +
		`  → {"shouldRecall":true,"query":"recipe","timeAnchor":{"type":"absolute","on":"${lastTuesday}"},"reason":"specific past Tuesday"}\n` +
		`- "remind me yesterday's plan"\n` +
		`  → {"shouldRecall":true,"query":"plan","timeAnchor":{"type":"absolute","on":"${yesterday}"},"reason":"yesterday"}\n` +
		`- "two weeks ago we talked about the trip"\n` +
		`  → {"shouldRecall":true,"query":"trip","timeAnchor":{"type":"window","after":"${twoWeeksStart}","before":"${twoWeeksEnd}"},"reason":"~14 days ago, ±3-day spread"}\n` +
		`- "what's the weather"\n` +
		`  → {"shouldRecall":false,"query":null,"timeAnchor":null,"reason":"no recall intent"}`
	);
}

/** Build the classifier system prompt with today's date and dynamic date examples. */
export function buildClassifierPrompt(today: string): string {
	return CLASSIFIER_SYSTEM_PROMPT_BASE.replace('<today>', today) + buildExamples(today);
}

// ─── Output validation ────────────────────────────────────────────────────────

/** Parse and validate LLM output. Today is used for temporal boundary checks. */
export function parseRecallVerdict(
	raw: unknown,
	opts: { today: string; maxWindowDays?: number },
): RecallVerdict {
	const { today, maxWindowDays = 365 } = opts;

	// Rule 1: must be a plain object
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return RECALL_SAFE_DEFAULT;
	}
	const obj = raw as Record<string, unknown>;

	// Rule 2: shouldRecall must be literal boolean
	if (typeof obj.shouldRecall !== 'boolean') return RECALL_SAFE_DEFAULT;

	// Rule 3: query validation
	let query: string | null = null;
	if (obj.query !== null && obj.query !== undefined) {
		if (typeof obj.query !== 'string') return RECALL_SAFE_DEFAULT;
		const q = obj.query.trim();
		if (q.length === 0 || q.length > 200) return RECALL_SAFE_DEFAULT;
		query = q;
	}
	if (obj.shouldRecall === true && query === null) return RECALL_SAFE_DEFAULT;

	// Rule 4: reason must be non-empty string
	if (typeof obj.reason !== 'string' || obj.reason.length === 0) return RECALL_SAFE_DEFAULT;
	const reason = obj.reason.slice(0, 100);

	// Rule 5: timeAnchor validation
	const timeAnchor = validateTimeAnchor(obj.timeAnchor, today, maxWindowDays);
	if (timeAnchor === INVALID_ANCHOR) return RECALL_SAFE_DEFAULT;

	return { shouldRecall: obj.shouldRecall, query, timeAnchor, reason };
}

// Sentinel for invalid anchor (distinct from null which means "no anchor")
const INVALID_ANCHOR = Symbol('invalid-anchor');

/** Returns TimeAnchor | null, or INVALID_ANCHOR sentinel if validation fails. */
function validateTimeAnchor(
	raw: unknown,
	today: string,
	maxWindowDays: number,
): TimeAnchor | typeof INVALID_ANCHOR {
	if (raw === null || raw === undefined) return null;

	// Legacy timeWindow strings (P5) or any non-object — clean break
	if (typeof raw !== 'object' || Array.isArray(raw)) return INVALID_ANCHOR;

	const anchor = raw as Record<string, unknown>;

	if (anchor.type === 'absolute') {
		// No extra fields allowed (only 'type' and 'on')
		const keys = Object.keys(anchor);
		if (keys.length !== 2 || !keys.includes('on')) return INVALID_ANCHOR;

		const on = anchor.on;
		if (typeof on !== 'string') return INVALID_ANCHOR;
		if (!isCalendarStrict(on)) return INVALID_ANCHOR;

		// Must not be in the future relative to today
		if (on > today) return INVALID_ANCHOR;

		// Must not be older than maxWindowDays
		const todayMs = Date.parse(today);
		const onMs = Date.parse(on);
		const diffDays = (todayMs - onMs) / (24 * 60 * 60 * 1000);
		if (diffDays > maxWindowDays) return INVALID_ANCHOR;

		return { type: 'absolute', on };
	}

	if (anchor.type === 'window') {
		// No extra fields allowed (only 'type', 'after', 'before' — after/before are optional)
		const allowedKeys = new Set(['type', 'after', 'before']);
		for (const k of Object.keys(anchor)) {
			if (!allowedKeys.has(k)) return INVALID_ANCHOR;
		}

		const after = anchor.after;
		const before = anchor.before;

		const todayMs = Date.parse(today);

		// Validate after when present
		if (after !== undefined) {
			if (typeof after !== 'string') return INVALID_ANCHOR;
			if (!isCalendarStrict(after)) return INVALID_ANCHOR;
			if (after > today) return INVALID_ANCHOR;
			// Individual age check: must be within maxWindowDays of today
			if ((todayMs - Date.parse(after)) / (24 * 60 * 60 * 1000) > maxWindowDays) {
				return INVALID_ANCHOR;
			}
		}

		// Validate before when present
		if (before !== undefined) {
			if (typeof before !== 'string') return INVALID_ANCHOR;
			if (!isCalendarStrict(before)) return INVALID_ANCHOR;
			if (before > today) return INVALID_ANCHOR;
			// Individual age check: must be within maxWindowDays of today
			if ((todayMs - Date.parse(before)) / (24 * 60 * 60 * 1000) > maxWindowDays) {
				return INVALID_ANCHOR;
			}
		}

		// When both present: after <= before and span <= maxWindowDays
		if (after !== undefined && before !== undefined) {
			if (typeof after === 'string' && typeof before === 'string') {
				if (after > before) return INVALID_ANCHOR;
				const afterMs = Date.parse(after);
				const beforeMs = Date.parse(before);
				const spanDays = (beforeMs - afterMs) / (24 * 60 * 60 * 1000);
				if (spanDays > maxWindowDays) return INVALID_ANCHOR;
			}
		}

		const result: TimeAnchor = { type: 'window' };
		if (typeof after === 'string') result.after = after;
		if (typeof before === 'string') result.before = before;
		return result;
	}

	// Any other type value
	return INVALID_ANCHOR;
}

// ─── LLM classifier ───────────────────────────────────────────────────────────

export async function classifyRecallIntent(
	message: string,
	deps: {
		llm: RecallClassifierLLM;
		logger: { warn(...args: unknown[]): void };
		today: string; // 'YYYY-MM-DD' local date
		timezone?: string; // IANA TZ; default = system
	},
): Promise<RecallVerdict> {
	if (!deps.today) {
		throw new Error('classifyRecallIntent: deps.today is required');
	}

	const systemPrompt = buildClassifierPrompt(deps.today);

	let raw: string;
	try {
		raw = await deps.llm.complete(sanitizeInput(message), {
			tier: 'fast',
			systemPrompt,
			maxTokens: 150,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'recall classifier LLM call failed');
		return { shouldRecall: false, query: null, timeAnchor: null, reason: 'llm-error' };
	}

	// Strip markdown code fences if present
	const json = raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		deps.logger.warn('recall classifier: failed to parse LLM response');
		return RECALL_SAFE_DEFAULT;
	}

	return parseRecallVerdict(parsed, { today: deps.today });
}
