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
export async function classifyPASMessage(
	text: string,
	deps: { llm: LLMService; appMetadata?: AppMetadataService; logger?: AppLogger },
	recentContext?: string,
): Promise<PASClassification> {
	if (!text.trim()) return { pasRelated: false };

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
		` DATA QUERY: asking about stored data — prices, recipes, nutrition, grocery history, health logs, notes, meals, pantry, comparisons.${appHint}` +
		` Reply with exactly: YES_DATA (data query about stored information), YES (PAS-related but not a data query), or NO (unrelated).` +
		contextHint;

	try {
		const response = await deps.llm.complete(sanitizeInput(text), {
			tier: 'fast',
			systemPrompt,
			maxTokens: 10,
			temperature: 0,
		});

		// Extract first word — handles "YES_DATA - this is a data query", "YES.", "NO.", etc.
		const firstWord = (response.trim().split(/\s/)[0] ?? '').toLowerCase().replace(/[^a-z_]/g, '');
		const pasRelated = firstWord.startsWith('yes');
		const dataQueryCandidate = firstWord === 'yes_data';
		return { pasRelated, dataQueryCandidate };
	} catch (error) {
		deps.logger?.warn('PAS classification failed, defaulting to app-aware context: %s', error);
		// Fail-open for PAS detection, fail-safe for data queries
		return { pasRelated: true };
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
