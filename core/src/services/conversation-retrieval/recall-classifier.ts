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
 * LLM interface matches the LLMService `complete` / `completeWithMeta` pair;
 * the classifier calls `completeWithMeta` so it can tell a reply truncated at
 * its token cap from a genuinely malformed one.
 */

import type { LLMCompletionMeta, LLMCompletionOptions } from '../../types/llm.js';
import { classifyStructuredOutput, formatRawPreview } from '../../utils/json-strip-fences.js';
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

/**
 * LLM surface the recall classifier needs. `completeWithMeta` is required (not
 * just `complete`) because the classifier must see `finishReason` to tell a
 * reply cut off at RECALL_MAX_TOKENS apart from a genuinely malformed one —
 * the same widening `RubricJudgeLLM` and `FoodShadowClassifierLLM` did.
 */
export interface RecallClassifierLLM {
	complete(prompt: string, options?: LLMCompletionOptions): Promise<string>;
	completeWithMeta(prompt: string, options?: LLMCompletionOptions): Promise<LLMCompletionMeta>;
}

/**
 * Output budget for the classifier call. The expected reply is one small JSON
 * object; 150 is generous for it. A model that overruns it is misbehaving, and
 * the truncation branch in `classifyRecallIntent` now says so instead of
 * reporting "failed to parse".
 */
const RECALL_MAX_TOKENS = 150;

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
	'  timeAnchor = use absolute for specific days, window for ranges, null if the user did not name a date, weekday, month, holiday, or count of days/weeks/months ago.\n' +
	'  Vague recall words ("earlier", "before", "previously", "last time", "a while back", "recently", "the other day") are NOT time references — return null.\n' +
	'  All dates must be YYYY-MM-DD format, in the past, and not more than 365 days before today.\n' +
	'  reason = brief explanation (under 20 words).';

/** Subtract N calendar days from a YYYY-MM-DD string (UTC noon arithmetic). */
function subtractDays(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

/** Add N calendar days to a YYYY-MM-DD string (UTC noon arithmetic). */
function addDays(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Return the most-recent past occurrence of targetDow (0=Sun…6=Sat) before today.
 * If today IS that weekday, go back 7 days (REQ-CONV-TEMPORAL-011).
 */
function findLastWeekday(today: string, targetDow: number): string {
	const d = new Date(`${today}T12:00:00Z`);
	const todayDow = d.getUTCDay();
	const diff = todayDow > targetDow ? todayDow - targetDow : 7 - (targetDow - todayDow);
	return subtractDays(today, diff || 7);
}

/** Return 'YYYY-MM-01' for the first day of today's month. */
function firstOfMonth(today: string): string {
	return `${today.slice(0, 7)}-01`;
}

/** Return 'YYYY-MM-01' for the first day of the prior calendar month. */
function firstOfPriorMonth(today: string): string {
	const d = new Date(`${today}T12:00:00Z`);
	const year = d.getUTCFullYear();
	const month = d.getUTCMonth(); // 0-indexed
	const priorMonth = month === 0 ? 11 : month - 1;
	const priorYear = month === 0 ? year - 1 : year;
	return `${String(priorYear).padStart(4, '0')}-${String(priorMonth + 1).padStart(2, '0')}-01`;
}

/** Return the last calendar day of the given 1-indexed month as a YYYY-MM-DD string. */
function lastDayOfMonth(year: number, month: number): string {
	// day 0 of month+1 = last day of month
	return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Return {start, end} for "in [Month]" / "during [Month]" phrases.
 * - current month → from 1st to today (REQ-CONV-TEMPORAL-012)
 * - prior month in current year → full month
 * - future month if same year → wrap to prior year (REQ-CONV-TEMPORAL-012)
 */
function monthWindow(today: string, targetMonth: number): { start: string; end: string } {
	const todayYear = Number(today.slice(0, 4));
	const todayMonth = Number(today.slice(5, 7));
	const mm = String(targetMonth).padStart(2, '0');
	if (targetMonth === todayMonth) {
		return { start: `${todayYear}-${mm}-01`, end: today };
	}
	if (targetMonth < todayMonth) {
		return {
			start: `${todayYear}-${mm}-01`,
			end: lastDayOfMonth(todayYear, targetMonth),
		};
	}
	// targetMonth > todayMonth → future in current year → prior year
	const priorYear = todayYear - 1;
	return {
		start: `${priorYear}-${mm}-01`,
		end: lastDayOfMonth(priorYear, targetMonth),
	};
}

/** Return the ±2-day window around the most recent past Christmas (Dec 25). */
function christmasWindow(today: string): { start: string; end: string } {
	const year = Number(today.slice(0, 4));
	const targetYear = `${year}-12-25` > today ? year - 1 : year;
	const rawEnd = `${targetYear}-12-27`;
	return {
		start: `${targetYear}-12-23`,
		end: rawEnd > today ? today : rawEnd,
	};
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

/** Build dynamic date examples relative to today so the prompt never goes stale. */
function buildExamples(today: string): string {
	const d = new Date(`${today}T12:00:00Z`);
	const dow = d.getUTCDay(); // 0=Sun … 6=Sat
	const dayName = DOW_NAMES[dow] ?? 'Day';
	const todayMonth = d.getUTCMonth(); // 0-indexed

	const yesterday = subtractDays(today, 1);

	// Last Tuesday: if today is Tue (2), go back 7; otherwise find most-recent prior Tuesday.
	const daysToLastTue = dow === 2 ? 7 : (dow + 7 - 2) % 7 || 7;
	const lastTuesday = subtractDays(today, daysToLastTue);

	// "Two weeks ago" window: centred ~17 days back, ±3-day spread (11–23 days ago)
	const twoWeeksStart = subtractDays(today, 19);
	const twoWeeksEnd = subtractDays(today, 11);

	// ── Phrasing reference helpers ───────────────────────────────────────────
	const lastFriday = findLastWeekday(today, 5);
	const dayBeforeYesterday = subtractDays(today, 2);
	const thisMonthStart = firstOfMonth(today);
	const lastMonthStart = firstOfPriorMonth(today);
	const lastMonthMid = addDays(lastMonthStart, 14);
	const currentMonthName = MONTH_NAMES[todayMonth] ?? 'this month';
	const currentMonth = monthWindow(today, todayMonth + 1); // 1-indexed
	// "during [prior month]" — two months before current to avoid overlapping with "earlier last month"
	const priorMonthIndex = todayMonth === 0 ? 11 : todayMonth === 1 ? 0 : todayMonth - 2;
	const priorMonthName = MONTH_NAMES[priorMonthIndex] ?? 'earlier';
	const priorMonth = monthWindow(today, priorMonthIndex + 1); // 1-indexed
	const coupleWeeksAfter = subtractDays(today, 21);
	const coupleWeeksBefore = subtractDays(today, 7);
	const threeWeeksAfter = subtractDays(today, 23);
	const threeWeeksBefore = subtractDays(today, 16);
	const xmas = christmasWindow(today);
	// "in November" — pick a month clearly in the past (10 months before current, wrapping)
	const novIdx = 10; // November = index 10 (0-based)
	const novName = MONTH_NAMES[novIdx] ?? 'November';
	const nov = monthWindow(today, novIdx + 1); // 1-indexed = 11
	const lastSundayOfWeekend = findLastWeekday(today, 0);
	const lastSaturdayOfWeekend = subtractDays(lastSundayOfWeekend, 1);

	return `\nExamples (today = ${today}, ${dayName}):\n- "what did we say last Tuesday about the recipe"\n  → {"shouldRecall":true,"query":"recipe","timeAnchor":{"type":"absolute","on":"${lastTuesday}"},"reason":"specific past Tuesday"}\n- "remind me yesterday's plan"\n  → {"shouldRecall":true,"query":"plan","timeAnchor":{"type":"absolute","on":"${yesterday}"},"reason":"yesterday"}\n- "two weeks ago we talked about the trip"\n  → {"shouldRecall":true,"query":"trip","timeAnchor":{"type":"window","after":"${twoWeeksStart}","before":"${twoWeeksEnd}"},"reason":"~14 days ago, ±3-day spread"}\n- "what's the weather"\n  → {"shouldRecall":false,"query":null,"timeAnchor":null,"reason":"no recall intent"}\n- "what did we say about the leak earlier?"\n  → {"shouldRecall":true,"query":"leak","timeAnchor":null,"reason":"\\"earlier\\" alone is vague, not a date"}\n- "what did we decide last time"\n  → {"shouldRecall":true,"query":"decision","timeAnchor":null,"reason":"\\"last time\\" is vague, not a date"}\n\n<phrasing reference> (today = ${today}, ${dayName})\n- "last Friday" → ${lastFriday} (absolute)\n- "the day before yesterday" → ${dayBeforeYesterday} (absolute)\n- "earlier this month" → window ${thisMonthStart} to ${today}\n- "earlier last month" → window ${lastMonthStart} to ${lastMonthMid}\n- "in ${currentMonthName}" → window ${currentMonth.start} to ${currentMonth.end}\n- "during ${priorMonthName}" → window ${priorMonth.start} to ${priorMonth.end}\n- "a couple weeks ago" → window ${coupleWeeksAfter} to ${coupleWeeksBefore}\n- "around Christmas" → window ${xmas.start} to ${xmas.end}\n- "last weekend" → window ${lastSaturdayOfWeekend} to ${lastSundayOfWeekend}\n- "three weeks ago" → window ${threeWeeksAfter} to ${threeWeeksBefore}\n- "in ${novName}" → window ${nov.start} to ${nov.end}\n</phrasing reference>`;
}

/** Build the classifier system prompt with today's date and dynamic date examples. */
export function buildClassifierPrompt(today: string, maxWindowDays = 365): string {
	const base = CLASSIFIER_SYSTEM_PROMPT_BASE.replace('<today>', today).replace(
		'365 days before today',
		`${maxWindowDays} days before today`,
	);
	return base + buildExamples(today);
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
		/** Maximum allowed temporal-window age/span in days. Default 365. REQ-CONV-TEMPORAL-013. */
		maxWindowDays?: number;
	},
): Promise<RecallVerdict> {
	if (!deps.today) {
		throw new Error('classifyRecallIntent: deps.today is required');
	}

	const maxWindowDays = deps.maxWindowDays ?? 365;
	const systemPrompt = buildClassifierPrompt(deps.today, maxWindowDays);
	const sanitized = sanitizeInput(message);

	const callOptions: LLMCompletionOptions = {
		tier: 'fast',
		systemPrompt,
		maxTokens: RECALL_MAX_TOKENS,
		temperature: 0,
		responseFormat: 'json',
	};

	// 'parse-first': the recall verdict is a small closed object that
	// `parseRecallVerdict` fully validates field by field, so a reply that parses
	// is complete by construction and `finishReason` only decides WHICH failure
	// to report. (The rubric judge uses 'check-length-first' for the opposite
	// reason — see classifyStructuredOutput's docs.)
	const order = 'parse-first' as const;

	// First call.
	let meta: LLMCompletionMeta;
	try {
		// completeWithMeta (not complete) so `finishReason` is visible: a reply cut
		// off at RECALL_MAX_TOKENS must be reported as truncation, not as a
		// malformed classifier response.
		meta = await deps.llm.completeWithMeta(sanitized, callOptions);
	} catch (err) {
		deps.logger.warn({ err }, 'recall classifier LLM call failed');
		return { shouldRecall: false, query: null, timeAnchor: null, reason: 'llm-error' };
	}

	const first = classifyStructuredOutput(meta, { order, maxTokens: RECALL_MAX_TOKENS });
	if (first.kind === 'ok') {
		return parseRecallVerdict(first.value, { today: deps.today, maxWindowDays });
	}
	// Truncation is checked above the non-empty/retry branch below and is
	// terminal: the same prompt against the same cap cuts the same way, so a
	// retry would only burn a second call.
	if (first.kind === 'truncated') return truncatedVerdict(first, deps.logger);
	if (first.kind === 'unparseable') {
		// Retry ONLY on empty output — the specific failure mode Codex's Chunk C
		// verification surfaced (Gemma returns "" for ambiguous prompts even with
		// JSON mode). Non-empty-but-unparseable output is rarer and the safe-default
		// path is sufficient; retrying it adds load + LLM calls without changing
		// the verdict for stub/mock scenarios. Hard cap at 2 LLM calls.
		deps.logger.warn('recall classifier: failed to parse LLM response (non-empty, no retry)');
		return RECALL_SAFE_DEFAULT;
	}

	let meta2: LLMCompletionMeta;
	try {
		meta2 = await deps.llm.completeWithMeta(`${sanitized}${RECALL_REPAIR_SUFFIX}`, callOptions);
	} catch (err) {
		deps.logger.warn({ err }, 'recall classifier LLM retry failed');
		return { shouldRecall: false, query: null, timeAnchor: null, reason: 'llm-error' };
	}

	const second = classifyStructuredOutput(meta2, { order, maxTokens: RECALL_MAX_TOKENS });
	if (second.kind === 'truncated') return truncatedVerdict(second, deps.logger);
	if (second.kind !== 'ok') {
		deps.logger.warn('recall classifier: failed to parse LLM response (after retry)');
		return RECALL_SAFE_DEFAULT;
	}
	return parseRecallVerdict(second.value, { today: deps.today, maxWindowDays });
}

/**
 * Safe verdict for a reply the provider cut at the output cap.
 *
 * Built as a fresh object rather than by spreading RECALL_SAFE_DEFAULT: that
 * module-level constant is returned by identity from a dozen sites and is not
 * frozen, so mutating a spread of it is a foot-gun. The distinct
 * `reason: 'truncated'` is what stops the next reader from blaming the model
 * for malformed output; the regression recall fixtures type `reason` as a plain
 * string with no enum, so a new value is safe there.
 */
function truncatedVerdict(
	outcome: { raw: string; maxTokens?: number },
	logger: { warn(...args: unknown[]): void },
): RecallVerdict {
	const cap =
		outcome.maxTokens === undefined
			? 'the output cap'
			: `the ${outcome.maxTokens}-token output cap`;
	logger.warn(
		{ raw: formatRawPreview(outcome.raw) },
		`recall classifier: LLM response truncated at ${cap} (finishReason='length') — not a malformed response`,
	);
	return { shouldRecall: false, query: null, timeAnchor: null, reason: 'truncated' };
}

const RECALL_REPAIR_SUFFIX =
	'\n\nYour previous response was empty or invalid. Reply with ONLY the JSON object specified in the system instructions above.';
