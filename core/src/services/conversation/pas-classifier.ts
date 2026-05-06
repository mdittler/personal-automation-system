/**
 * PAS-relevance classification (LLM + keyword heuristic).
 *
 * - `classifyPASMessage` is the LLM-based classifier (fast tier). Returns
 *   `{ pasRelated, dataQueryCandidate }` so the chatbot can choose between
 *   app-aware and basic prompts and decide whether to call DataQueryService.
 *   Fail-open: returns `pasRelated: true` on any LLM error so users with
 *   auto_detect_pas on still get useful responses.
 * - `isPasRelevant` is the legacy keyword heuristic. Kept for backward
 *   compatibility (and exported by the chatbot shim) but classifyPASMessage
 *   should be preferred.
 *
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

/** Static keywords that suggest a PAS-related question. */
export const PAS_KEYWORDS = [
	'pas',
	'app',
	'apps',
	'command',
	'commands',
	'schedule',
	'scheduling',
	'automation',
	'install',
	'how do i',
	'how does',
	'what can',
	'what apps',
	'help me with',
	'what is',
	'context store',
	'data store',
	'daily notes',
	'daily diff',
	'telegram',
	'routing',
	'model',
	'models',
	'provider',
	'providers',
	'cost',
	'costs',
	'spending',
	'usage',
	'tokens',
	'pricing',
	'price',
	'rate limit',
	'tier',
	'tiers',
	'uptime',
	'status',
	'cron',
	'jobs',
	'cost cap',
	'switch',
	'change model',
	'budget',
	'my data',
	'my notes',
	'my files',
	'what did i',
	'what have i',
	'recent activity',
	'recent changes',
];

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
	// Legacy bare YES implies pasRelated; YES_DATA also implies pasRelated.
	const pasRelated =
		(tokens.has('YES_PAS') || tokens.has('YES') || dataQueryCandidate) &&
		!tokens.has('NO_PAS');
	// settingsCandidate is only meaningful when the message is PAS-related.
	const settingsCandidate = pasRelated && tokens.has('YES_SETTINGS') && !tokens.has('NO_SETTINGS');

	return { pasRelated, dataQueryCandidate, settingsCandidate };
}

/**
 * Classify a message as PAS-related using a fast-tier LLM call.
 *
 * Replaces the static PAS_KEYWORDS heuristic. Returns fail-open
 * (pasRelated: true) on LLM error so users with auto_detect_pas on still get
 * helpful responses.
 *
 * Only call when auto_detect_pas is enabled — /ask is always app-aware.
 *
 * @param text           The user's message text.
 * @param deps           Required LLM service plus optional appMetadata/logger.
 * @param recentContext  Optional summary of recent user interactions.
 */
/**
 * Deterministic pre-filter that flags price/receipt/trip queries as data-query
 * candidates before the LLM call. Covers patterns the LLM classifier may miss
 * (e.g., it might respond "YES" instead of "YES_DATA"). RC7.
 */
const DATA_QUERY_PREFILTER =
	/\b(cheapest|cheaper|lowest price|last trip|last visit|last shop|previous receipt|spent at)\b|how much.{0,50}\bat\b|\bprice.{0,30}(changed|change|difference|increased|decreased)\b/i;

export async function classifyPASMessage(
	text: string,
	deps: { llm: LLMService; appMetadata?: AppMetadataService; logger?: AppLogger },
	recentContext?: string,
): Promise<PASClassification> {
	if (!text.trim()) return { pasRelated: false };

	// Deterministic short-circuit for price/receipt/trip queries — no LLM call needed.
	if (DATA_QUERY_PREFILTER.test(text)) {
		return { pasRelated: true, dataQueryCandidate: true };
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
	const contextHint =
		recentContext && recentContext.trim() ? ` Recent user actions: ${recentContext}.` : '';

	const systemPrompt =
		`You are a classifier. Determine if a message is related to a personal automation system (PAS).` +
		` PAS topics include: home automation, installed apps, scheduling, data queries about food/grocery/health/notes, system status, model/cost info.` +
		` DATA QUERY: asking about stored data — prices, recipes, nutrition, grocery history, health logs, notes, meals, pantry, comparisons.` +
		` SETTINGS: asking about or requesting a change to a PAS configuration setting (e.g. "turn on X", "how do I configure Y", "what settings are available").${appHint}` +
		` Reply with space-separated tokens (any order). Examples:\n` +
		`  YES_PAS YES_SETTINGS NO_DATA  — PAS question about a setting\n` +
		`  YES_PAS NO_SETTINGS YES_DATA  — PAS question about stored data\n` +
		`  YES_PAS NO_SETTINGS NO_DATA   — PAS question (general)\n` +
		`  NO_PAS                        — not PAS-related\n` +
		`Backward-compat: bare YES/NO/YES_DATA tokens are also accepted.` +
		contextHint;

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

/**
 * Check if a message text is likely PAS-related using keyword heuristics.
 * No LLM cost. Prefer `classifyPASMessage` for LLM-based classification.
 *
 * @deprecated Use classifyPASMessage() for LLM-based classification.
 */
export function isPasRelevant(
	text: string,
	deps: { appMetadata?: AppMetadataService } = {},
): boolean {
	if (!text.trim()) return false;
	const lower = text.toLowerCase();

	// Check static keywords
	for (const keyword of PAS_KEYWORDS) {
		if (lower.includes(keyword)) return true;
	}

	// Check dynamic: installed app names and command names
	if (deps.appMetadata) {
		const apps = deps.appMetadata.getInstalledApps();
		for (const app of apps) {
			if (lower.includes(app.name.toLowerCase())) return true;
			if (lower.includes(app.id)) return true;
			for (const cmd of app.commands) {
				if (lower.includes(cmd.name.replace('/', ''))) return true;
			}
		}
	}

	return false;
}
