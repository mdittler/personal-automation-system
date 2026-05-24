/**
 * PAS-relevance classification (LLM + keyword heuristic).
 *
 * - `classifyPASMessage` is the LLM-based classifier (fast tier). Returns
 *   `{ pasRelated, dataQueryCandidate }` so the chatbot can choose between
 *   app-aware and basic prompts and decide whether to call DataQueryService.
 *   Fail-open: returns `pasRelated: true` on any LLM error so users with
 *   auto_detect_pas on still get useful responses.
 * All exports are pure functions taking explicit dependencies — no module-level
 * services closure.
 */

import type { AppMetadataService } from '../../types/app-metadata.js';
import type { AppLogger } from '../../types/app-module.js';
import type { LLMService } from '../../types/llm.js';
import { sanitizeInput } from '../prompt-assembly/index.js';

/** Regex to detect model-switch intent in the user's message. */
export const MODEL_SWITCH_INTENT_REGEX =
	/\b(switch|change|set|use|update)\b.*\b(model|tier|fast|standard|reasoning)\b/i;

/** Classification result from LLM-based PAS relevance check. */
export interface PASClassification {
	/** Whether the message is PAS-related (home automation, apps, data). */
	pasRelated: boolean;
	/**
	 * Whether the message is a natural-language data query (YES_DATA from
	 * classifier). When true, DataQueryService is called.
	 */
	dataQueryCandidate?: boolean;
	/**
	 * Whether the message is asking about or requesting a change to a PAS
	 * setting (YES_SETTINGS from classifier). When true, SettingsReader is
	 * called to inject the relevant settings catalog into the prompt.
	 */
	settingsCandidate?: boolean;
}

/**
 * Parse the raw string output from the PAS classifier LLM into a
 * `PASClassification` object.
 *
 * Token protocol (space-separated, any order):
 *   YES_PAS / NO_PAS     — PAS relevance (new form)
 *   YES_DATA / NO_DATA   — data-query signal
 *   YES_SETTINGS / NO_SETTINGS — settings-query signal
 *   YES / NO             — legacy bare tokens (backward-compat: YES → pasRelated)
 *
 * Algorithm:
 *   1. Scan lines top-to-bottom. For each non-empty line, extract all uppercase
 *      token sequences (/[A-Z_]+/g) and check them against KNOWN_TOKENS.
 *      - "Pure token line": ALL extracted tokens are known → use all tokens.
 *      - "Token-first line": the FIRST token is known (model answer at start,
 *        explanation after) → use only the leading run of known tokens before
 *        the first unknown token.
 *      - Lines whose first token is unknown (prose containing token names) are
 *        skipped entirely.
 *   2. Decisions are parsed from the first qualifying line only. Tokens in
 *      subsequent prose or explanatory text are ignored, preventing false
 *      positives from quoted tokens or model reasoning.
 *   3. NO_* tokens dominate YES_* tokens when both appear.
 *   4. settingsCandidate is only set to true when pasRelated is also true.
 *   5. Fail-open: if no qualifying line is found but the input has content,
 *      return pasRelated=true so users still get a useful response.
 *   6. Empty input returns all-false.
 *
 * Input is uppercased before matching so lowercase LLM output is tolerated.
 */
export function parsePASClassifierOutput(raw: string): PASClassification {
	const KNOWN_TOKENS = new Set([
		'YES',
		'NO',
		'YES_PAS',
		'NO_PAS',
		'YES_DATA',
		'NO_DATA',
		'YES_SETTINGS',
		'NO_SETTINGS',
	]);

	const lines = raw.split('\n');
	let resolvedTokens: Set<string> | undefined;

	for (const line of lines) {
		const trimmed = line.trim().toUpperCase();
		if (!trimmed) continue;

		const parts = trimmed.match(/[A-Z_]+/g) ?? [];
		if (parts.length === 0) continue;

		if (parts.every((p) => KNOWN_TOKENS.has(p))) {
			// Pure token line: all extracted tokens are known → use all of them.
			resolvedTokens = new Set(parts);
			break;
		}

		if (parts[0] !== undefined && KNOWN_TOKENS.has(parts[0])) {
			// Token-first line: model put its answer at the start, then prose.
			// Collect the leading run of known tokens before the first unknown one.
			const leading: string[] = [];
			for (const p of parts) {
				if (!KNOWN_TOKENS.has(p)) break;
				leading.push(p);
			}
			resolvedTokens = new Set(leading);
			break;
		}

		// First token is unknown (prose containing quoted token names) → skip line.
	}

	if (resolvedTokens === undefined) {
		// Fail-open when there is content but no qualifying line found.
		// Empty / whitespace-only input returns all-false.
		const hasContent = lines.some((l) => l.trim().length > 0);
		return hasContent
			? { pasRelated: true, dataQueryCandidate: false, settingsCandidate: false }
			: { pasRelated: false, dataQueryCandidate: false, settingsCandidate: false };
	}

	const tokens = resolvedTokens;

	// NO_* tokens dominate YES_* tokens when both appear.
	const dataQueryCandidate = tokens.has('YES_DATA') && !tokens.has('NO_DATA');
	// Bare YES implies pasRelated (backward-compat); YES_DATA also implies pasRelated.
	const pasRelated =
		(tokens.has('YES_PAS') || tokens.has('YES') || dataQueryCandidate) && !tokens.has('NO_PAS');
	// settingsCandidate is only meaningful when the message is PAS-related.
	const settingsCandidate = pasRelated && tokens.has('YES_SETTINGS') && !tokens.has('NO_SETTINGS');

	return { pasRelated, dataQueryCandidate, settingsCandidate };
}

/**
 * Deterministic pre-filter that flags price/receipt/trip queries as data-query
 * candidates before the LLM call. Covers patterns the LLM classifier may miss
 * (e.g., it might respond "YES" instead of "YES_DATA"). RC7.
 */
const DATA_QUERY_PREFILTER =
	/\b(cheapest|cheaper|lowest price|last trip|last visit|last shop|previous receipt|spent at)\b|how much.{0,50}\bat\b|\bprice.{0,30}(changed|change|difference|increased|decreased)\b|\b(?:what(?:'s|\s+is)\s+(?:in\s+)?my\s+pantry|my\s+pantry\s+right\s+now)\b|\bwhat\s+did\s+i\s+(?:eat|have)\b|\bhow\s+many\s+(?:recipes?|meals?|notes?|alerts?|reports?)\s+(?:do\s+i\s+have|have\s+i)\s+(?:saved|stored|created)\b/i;

/**
 * Batch 3 — Deterministic SETTINGS prefilter. Codex correction #6: evidenced
 * Chunk C failures showed Gemma 4 e4b incorrectly classifying these phrases as
 * NO_PAS.
 *
 * Narrow on purpose: requires a possessive ("my") to indicate the user is
 * referring to THEIR PAS configuration (not asking generically about AI). This
 * keeps generic AI prose like "switch to a smarter model" from short-circuiting
 * the LLM path. The evidenced phrasings ALL use "my":
 *   - "change my fast model"
 *   - "set my timezone to UTC"
 *   - "what is my current standard model"
 */
const SETTINGS_KEYWORDS_RE =
	/\b(?:switch|change|set|use|update|configure)\s+(?:the\s+|my\s+)\s*(?:fast|standard|reasoning|model|tier|timezone)\b|\b(?:switch|change|set|update)\s+my\s+\w+\s+(?:model|tier|timezone)\b|\bwhat\s+(?:is|are)\s+my\s+current\s+(?:fast|standard|reasoning|model|tier|timezone|setting)\b|\b(?:toggle|enable|disable|configure)\s+auto[-\s]?detect(?:\s+pas)?\b|\bhow\s+(?:do\s+i|to)\s+configure\s+auto[-\s]?detect/i;

/**
 * Batch 3 — Deterministic SYSTEM-DATA prefilter. Narrow: only fires on
 * phrases that explicitly name PAS-internal data that the DataQueryService
 * can return. Pure data-lookup queries belong here; PAS meta-questions
 * (e.g. "what apps are installed") belong in PAS_META_RE instead.
 */
const SYSTEM_DATA_KEYWORDS_RE = /\b(?:system\s+logs?|scheduled\s+alerts?|model\s+journal)\b/i;

/**
 * PAS meta-questions — these are PAS-related but NOT data queries (DataQueryService
 * has no useful response for "what apps are installed" — that's a question about
 * the PAS installation itself, not stored data). Returning just `{pasRelated:true}`
 * lets the chatbot route to general PAS knowledge instead of triggering a
 * cross-app data search that would yield nothing.
 */
const PAS_META_RE =
	/\b(?:installed\s+apps?|apps?\s+(?:do\s+)?i\s+have\s+installed|apps?\s+(?:are\s+)?installed)\b|\bhow\s+(?:do\s+i|to)\s+(?:install|uninstall|add|remove)\s+(?:(?:a|an|the)\s+)?(?:new\s+|another\s+)?apps?\b/i;

/**
 * Platform-invite questions — adding users to PAS, invite codes, granting
 * platform access to household members. Closes the 2026-05-24 Accepted
 * Risk: Gemma 4 31B (and Haiku 4.5) mis-classified all 7 regression-case
 * phrasings as NO_PAS, so the chatbot never engaged its PAS-aware prompt
 * to help with invite-code questions.
 *
 * Each branch REQUIRES an explicit PAS / platform / access / user-management
 * anchor. "Inviting people to dinner / a concert / a birthday party" does
 * NOT match — those are out-of-scope generic invite phrasings.
 */
const PLATFORM_INVITE_PATTERNS = [
	// Branch 1: "invite (someone|people|users|members) to (PAS|the platform|this|the system)"
	String.raw`\binvit(?:e|ing)\s+(?:someone|somebody|people|users?|members?)\s+(?:to|on(?:to)?|into)\s+(?:pas|the\s+platform|this(?:\s+(?:platform|system|app))?|the\s+system)\b`,
	// Branch 2: "invite (my wife/husband/partner/spouse/kids/children/family/household)" — explicit relationship-to-PAS-user signal
	String.raw`\binvit(?:e|ing)\s+my\s+(?:wife|husband|partner|spouse|kids?|children|family|household)\b`,
	// Branch 3: invite codes — PAS-specific concept
	String.raw`\binvite\s+codes?\b`,
	// Branch 4a: "add (a new |another )(user|account|member) to (the platform|PAS|this|the system)" — REQUIRES explicit platform target (Codex #6 hardening — no optional anchor)
	String.raw`\b(?:add(?:ing)?|register(?:ing)?)\s+(?:a\s+|another\s+)?(?:new\s+)?(?:user|users|account|accounts|member|members)\s+to\s+(?:pas|the\s+platform|this(?:\s+(?:platform|system|app))?|the\s+system)\b`,
	// Branch 4b: relationship form — "add my wife/husband/…" — relationship token alone is the anchor
	String.raw`\b(?:add(?:ing)?|register(?:ing)?)\s+my\s+(?:wife|husband|partner|spouse|kids?|children|family|household)\b`,
	// Branch 5: "give (my X|X) (PAS )?access" — access verb with possessive subject
	String.raw`\bgive\s+(?:my\s+(?:wife|husband|partner|spouse|kids?|children|family|household)|(?:\w+))\s+(?:pas\s+)?access\b`,
	// Branch 6: "let my (wife|partner|kids|…) (sign in|use this|use PAS|join)" — covers the LLM few-shot territory deterministically when phrased with the household relationship
	String.raw`\blet\s+my\s+(?:wife|husband|partner|spouse|kids?|children|family|household)\s+(?:sign\s+in|log\s+in|use\s+(?:this|pas|the\s+platform)|join)\b`,
	// Branch 7: "how do invite codes work" / "tell me about inviting people (to PAS|to the platform)?"
	// The "to PAS/platform/this" anchor is optional — "tell me about inviting people" alone is
	// PAS-disambiguated by the "tell me about" prefix (no realistic non-PAS use of that phrasing).
	// Whitespace lives inside the optional group so a bare "...inviting people\b" matches
	// without requiring a trailing space.
	String.raw`\b(?:how\s+do\s+invite\s+codes\s+work)\b`,
	String.raw`\btell\s+me\s+about\s+invit(?:e|ing)\s+(?:people|users?|members?)(?:\s+to\s+(?:pas|the\s+platform|this))?\b`,
	// Branch 8: "(can I |how do I )give my (kids|family|…) access" — common phrasing with possessive object
	String.raw`\b(?:can\s+i|how\s+(?:do\s+i|to))\s+give\s+my\s+(?:wife|husband|partner|spouse|kids?|children|family|household)\s+access\b`,
];

const PLATFORM_INVITE_RE = new RegExp(PLATFORM_INVITE_PATTERNS.join('|'), 'i');

/** Pre-filter table consulted in order — first matching pattern wins. */
const PREFILTERS: ReadonlyArray<readonly [RegExp, PASClassification]> = [
	[DATA_QUERY_PREFILTER, { pasRelated: true, dataQueryCandidate: true }],
	[SETTINGS_KEYWORDS_RE, { pasRelated: true, settingsCandidate: true }],
	[SYSTEM_DATA_KEYWORDS_RE, { pasRelated: true, dataQueryCandidate: true }],
	[PAS_META_RE, { pasRelated: true }],
	[PLATFORM_INVITE_RE, { pasRelated: true }],
];

/**
 * Classify a message as PAS-related using a fast-tier LLM call.
 *
 * Returns fail-open
 * (pasRelated: true) on LLM error so users with auto_detect_pas on still get
 * helpful responses.
 *
 * Only call when auto_detect_pas is enabled — /ask is always app-aware.
 *
 * @param text           The user's message text.
 * @param deps           Required LLM service plus optional appMetadata/logger.
 * @param recentContext  Optional summary of recent user interactions.
 */
export async function classifyPASMessage(
	text: string,
	deps: { llm: LLMService; appMetadata?: AppMetadataService; logger?: AppLogger },
	recentContext?: string,
): Promise<PASClassification> {
	if (!text.trim()) return { pasRelated: false };

	// Deterministic prefilters — order matters: DATA_QUERY runs first because
	// its keywords overlap with SYSTEM_DATA (e.g., "cheapest" is data-query;
	// "system logs" is system-data). SETTINGS sits between because its verbs
	// (change/set/etc.) overlap with neither.
	for (const [pattern, verdict] of PREFILTERS) {
		if (pattern.test(text)) return verdict;
	}

	// Build compact classifier prompt — no large app metadata.
	// Use installed (not just enabled) apps for classification — user may ask
	// about disabled apps too. App names are sanitized to prevent injection.
	const appNames = deps.appMetadata
		? deps.appMetadata
				.getInstalledApps()
				.map((a) => sanitizeInput(a.name, 100))
				.join(', ')
		: '';
	const appHint = appNames ? ` Installed apps: ${appNames}.` : '';

	// Append recent context when available — helps resolve follow-up queries
	const contextHint = recentContext?.trim() ? ` Recent user actions: ${recentContext}.` : '';

	const systemPrompt = `You are a classifier. Determine if a message is related to a personal automation system (PAS). PAS topics include: home automation, installed apps, scheduling, data queries about food/grocery/health/notes, system status, model/cost info. DATA QUERY: asking about stored data — prices, recipes, nutrition, grocery history, health logs, notes, meals, pantry, comparisons. SETTINGS: asking about or requesting a change to a PAS configuration setting (e.g. "turn on X", "how do I configure Y", "what settings are available").${appHint} Reply with space-separated tokens (any order). Token format:\n  YES_PAS YES_SETTINGS NO_DATA  — PAS question about a setting\n  YES_PAS NO_SETTINGS YES_DATA  — PAS question about stored data\n  YES_PAS NO_SETTINGS NO_DATA   — PAS question (general)\n  NO_PAS                        — not PAS-related\nExamples mapping input → tokens (Batch 3 — Gemma-friendly):\n  "change my fast model"             → YES_PAS YES_SETTINGS NO_DATA\n  "set my timezone to UTC"           → YES_PAS YES_SETTINGS NO_DATA\n  "what is my current standard model"→ YES_PAS YES_SETTINGS NO_DATA\n  "show me my system logs"           → YES_PAS NO_SETTINGS YES_DATA\n  "list my scheduled alerts"         → YES_PAS NO_SETTINGS YES_DATA\n  "what apps do I have installed"    → YES_PAS NO_SETTINGS NO_DATA\n  "what's in my pantry right now"    → YES_PAS NO_SETTINGS YES_DATA\n  "what's the weather"               → NO_PAS\nBackward-compat: bare YES/NO/YES_DATA tokens are also accepted.${contextHint}`;

	try {
		const response = await deps.llm.complete(sanitizeInput(text), {
			tier: 'fast',
			systemPrompt,
			maxTokens: 10,
			temperature: 0,
		});

		return parsePASClassifierOutput(response);
	} catch (error) {
		deps.logger?.warn('PAS classification failed, defaulting to app-aware context: %s', error);
		// Fail-open for PAS detection; fail-safe (false) for data/settings queries
		return { pasRelated: true, dataQueryCandidate: false, settingsCandidate: false };
	}
}
