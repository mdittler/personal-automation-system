/**
 * Control tag processors for LLM response post-processing.
 *
 * <switch-model>: admin-only model switching (pre-existing).
 * <config-set>:   per-user config writes (Chunk C, registry-derived allowlist + intent-gated).
 */

import type { AppLogger } from '../../types/app-module.js';
import type { SystemInfoService } from '../../types/system-info.js';
import type { SettingsRegistry } from '../settings/settings-registry.js';
import type { SettingsWriter } from '../settings/settings-writer.js';
import { MODEL_SWITCH_INTENT_REGEX } from './pas-classifier.js';
export {
	MEMORY_KIND_INTENT_REGEX,
	MEMORY_KIND_SET_INSTRUCTION_BLOCK,
	processMemoryKindSetTags,
} from './control-tags/memory-kind-set.js';

export const normalizeResponse = (s: string): string => s.replace(/\n{3,}/g, '\n\n').trim();

/** Regex to match model switch tags in LLM responses. */
export const SWITCH_MODEL_TAG_REGEX =
	/<switch-model\s+tier="([^"]+)"\s+provider="([^"]+)"\s+model="([^"]+)"\s*\/>/g;

export interface ProcessModelSwitchTagsOptions {
	userId?: string;
	userMessage?: string;
	deps: {
		systemInfo?: SystemInfoService;
		logger?: AppLogger;
	};
}

export async function processModelSwitchTags(
	response: string,
	options: ProcessModelSwitchTagsOptions,
): Promise<{ cleanedResponse: string; confirmations: string[] }> {
	const confirmations: string[] = [];

	// Fast pre-check: only apply guards when switch-model tags are actually present
	const hasTags = response.includes('<switch-model');

	if (!hasTags) {
		return {
			cleanedResponse: normalizeResponse(response),
			confirmations,
		};
	}

	const { systemInfo } = options.deps;

	if (!systemInfo) {
		return {
			cleanedResponse: normalizeResponse(response.replace(SWITCH_MODEL_TAG_REGEX, '')),
			confirmations,
		};
	}

	// Guard: require admin (only when tags are present)
	if (!options.userId || !systemInfo.isUserAdmin(options.userId)) {
		return {
			cleanedResponse: normalizeResponse(response.replace(SWITCH_MODEL_TAG_REGEX, '')),
			confirmations,
		};
	}

	// Guard: require explicit model-switch intent in the user message (only when tags present)
	if (!options.userMessage || !MODEL_SWITCH_INTENT_REGEX.test(options.userMessage)) {
		return {
			cleanedResponse: normalizeResponse(response.replace(SWITCH_MODEL_TAG_REGEX, '')),
			confirmations,
		};
	}

	const actions: Array<{ tier: string; provider: string; model: string }> = [];
	const cleanedResponse = response.replace(
		SWITCH_MODEL_TAG_REGEX,
		(_match, tier: string, provider: string, model: string) => {
			actions.push({ tier, provider, model });
			return '';
		},
	);

	for (const action of actions) {
		const result = await systemInfo.setTierModel(action.tier, action.provider, action.model);
		if (result.success) {
			confirmations.push(`✅ Switched ${action.tier} tier to ${action.provider}/${action.model}`);
		} else {
			confirmations.push(`❌ Failed to switch ${action.tier} tier: ${result.error}`);
		}
	}

	return {
		cleanedResponse: normalizeResponse(cleanedResponse),
		confirmations,
	};
}

// ---------------------------------------------------------------------------
// <config-set> tag processor
// ---------------------------------------------------------------------------

const CONFIG_SET_TAG_REGEX = /<config-set\s+key="([^"]+)"\s+value="([^"]+)"\s*\/>/g;

/**
 * Strip all well-formed <config-set .../> tags from a response string without
 * processing them. Also sweeps for malformed/reordered/extra-attr remnants.
 *
 * Use this when the writer is absent — prevents model-emitted tags leaking to the user.
 */
export function stripConfigSetTags(response: string): string {
	if (!response.includes('<config-set')) return response;
	return normalizeResponse(
		response
			.replace(CONFIG_SET_TAG_REGEX, '')
			.replace(/<config-set\b[^>]*\/?>/g, ''),
	);
}

/**
 * Bidirectional detector for user intent to toggle daily-notes logging.
 *
 * First alt:  action verb → notes concept (normal order).
 * Second alt: specific notes concept → action verb (reverse order).
 * Requires specific notes terminology to avoid false-firing on "notes" the noun.
 * "please" is intentionally absent from the action-verb group: it would match
 * read-only requests like "please show me my daily notes".
 */
export const NOTES_INTENT_REGEX =
	/(?:\b(?:on|off|enable|disable|stop|start|turn|don'?t|do\s+not)\b[^.?!]{0,50}\b(?:daily[-\s]?notes?|note[-\s]?log(?:ging)?|log(?:ging)?\s+(?:my\s+)?(?:notes?|messages?)|saving\s+(?:my|all|everything))\b)|(?:\b(?:daily[-\s]?notes?|note[-\s]?log(?:ging)?|saving\s+everything)\b[^.?!]{0,50}\b(?:on|off|enable|disable|stop|start|turn)\b)/i;

/**
 * Bidirectional detector for user intent to toggle memory-flush on idle reset.
 * Requires explicit "session memory", "session summary/summaries",
 * "automatic idle summaries", or "idle summary/summaries" phrasing.
 * Avoids false-firing on "remember this" / "memory usage" / "save X" /
 * "save my conversation".
 */
export const MEMORY_FLUSH_INTENT_REGEX =
	/\b(?:on|off|enable|disable|stop|start|turn|don'?t|do\s+not)\b[^.?!]{0,40}\b(?:session\s+memory|session\s+summar(?:y|ies)|automatic\s+idle\s+summar(?:y|ies)|idle\s+summar(?:y|ies))\b|\b(?:session\s+memory|session\s+summar(?:y|ies)|automatic\s+idle\s+summar(?:y|ies)|idle\s+summar(?:y|ies))\b[^.?!]{0,40}\b(?:on|off|enable|disable|stop|start|turn)\b/i;

/**
 * Instruction appended to the system prompt when the user message matches
 * NOTES_INTENT_REGEX. Tells the LLM how to request a config change.
 */
export const CONFIG_SET_INSTRUCTION_BLOCK = `
When the user wants to enable or disable daily notes logging, include exactly one of these tags in your response (it will be removed from your visible reply after processing):
  To enable:  <config-set key="log_to_notes" value="true"/>
  To disable: <config-set key="log_to_notes" value="false"/>
Only emit this tag when the user explicitly requests a change. Do not emit it to report the current state.`.trim();

/**
 * Instruction appended to the system prompt when the user message matches
 * MEMORY_FLUSH_INTENT_REGEX. Tells the LLM how to toggle session memory.
 */
export const FLUSH_MEMORY_INSTRUCTION_BLOCK = `
When the user wants to enable or disable session memory (saving a summary of the chat when an idle session auto-resets), include exactly one of these tags in your response (it will be removed from your visible reply after processing):
  To enable:  <config-set key="flush_memory_on_idle_reset" value="true"/>
  To disable: <config-set key="flush_memory_on_idle_reset" value="false"/>
Only emit this tag when the user explicitly requests a change. Do not emit it to report the current state.`.trim();

/**
 * Parse a raw config-set key into (appId, key).
 *
 * Qualified form: "food.seasonal_nudges" → { appId: 'food', key: 'seasonal_nudges' }
 * Bare form:      "log_to_notes"         → { appId: 'chatbot', key: 'log_to_notes' }
 *
 * The first dot is the delimiter; dots within the key portion are preserved.
 */
function parseConfigSetKey(raw: string): { appId: string; key: string } {
	const dot = raw.indexOf('.');
	if (dot < 0) return { appId: 'chatbot', key: raw };
	return { appId: raw.slice(0, dot), key: raw.slice(dot + 1) };
}

/**
 * Return a human-readable confirmation string for a successful config write.
 *
 * Chatbot keys use specific phrasing that matches existing UX copy.
 * All other keys fall back to the registry label.
 */
function confirmationFor(
	appId: string,
	key: string,
	coerced: unknown,
	registry: SettingsRegistry,
): string | null {
	if (appId === 'chatbot') {
		if (key === 'log_to_notes') {
			return coerced ? 'Daily notes logging turned ON.' : 'Daily notes logging turned OFF.';
		}
		if (key === 'flush_memory_on_idle_reset') {
			return coerced
				? "Session memory turned ON — I'll save a short summary when our chats time out."
				: 'Session memory turned OFF. The most recent saved summary has been deleted.';
		}
		if (key === 'session_search_tool_enabled') {
			return coerced ? 'Session-search tool turned ON.' : 'Session-search tool turned OFF.';
		}
	}
	// Generic fallback: use registry label
	const def = registry.getByAppKey(appId, key);
	if (!def) return null;
	return `Setting "${def.label}" updated.`;
}

export interface ProcessConfigSetTagsOptions {
	userId: string;
	userMessage: string;
	logger: AppLogger;
	settingsRegistry: SettingsRegistry;
	settingsWriter: SettingsWriter;
	/** Called when chatbot.flush_memory_on_idle_reset is turned OFF, to delete the prior summary. */
	disableFlushAndCleanup?: (userId: string) => Promise<void>;
}

/**
 * Process <config-set> tags emitted by the LLM.
 *
 * Security guards (in order — registry-derived, replacing hardcoded ALLOWED_CONFIG_KEYS):
 * 1. Key not in registry → strip and warn.
 * 2. def.nlSafe === false OR def.adminOnly OR def.dangerous OR def.hidden → strip and warn.
 * 3. Per-key: user message lacks def.nlIntentRegex → skip that tag.
 * 4. Route through SettingsWriter (coercion + persistence).
 * 5. On chatbot.flush_memory_on_idle_reset=false → call disableFlushAndCleanup.
 */
export async function processConfigSetTags(
	response: string,
	options: ProcessConfigSetTagsOptions,
): Promise<{ cleanedResponse: string; confirmations: string[] }> {
	const confirmations: string[] = [];

	if (!response.includes('<config-set')) {
		return { cleanedResponse: response, confirmations };
	}

	// Collect all well-formed tags
	const parsedTags: Array<{ appId: string; key: string; value: string }> = [];
	for (const match of response.matchAll(CONFIG_SET_TAG_REGEX)) {
		const rawKey = match[1] ?? '';
		const value = match[2] ?? '';
		const { appId, key } = parseConfigSetKey(rawKey);
		parsedTags.push({ appId, key, value });
	}

	// Strip all well-formed tags; sweep for malformed/reordered/extra-attr remnants
	const stripped = response
		.replace(CONFIG_SET_TAG_REGEX, '')
		.replace(/<config-set\b[^>]*\/?>/g, '');

	// Enforce at-most-one policy: count the tags that would pass Guards 1+2, warn
	// if more than one, then keep only the first. The limit applies after security
	// filtering so that a blocked tag does not "count" against the limit.
	const passesPolicy = (tag: { appId: string; key: string }): boolean => {
		const d = options.settingsRegistry.getByAppKey(tag.appId, tag.key);
		return !!d && d.nlSafe && !d.adminOnly && !d.dangerous && !d.hidden;
	};
	const eligible = parsedTags.filter(passesPolicy);
	if (eligible.length > 1) {
		options.logger.warn(
			'processConfigSetTags: %d config-set tags found in response, processing only the first (userId=%s)',
			eligible.length,
			options.userId,
		);
		eligible.splice(1);
	}
	// Reconstruct the iteration list: rejected tags (for warn logging) + the
	// single eligible survivor. Rejected tags will be warned and skipped in-loop.
	const toProcess = [
		...parsedTags.filter((t) => !passesPolicy(t)),
		...eligible,
	];

	// Process surviving tags
	for (const { appId, key, value } of toProcess) {
		// Guard 1+2: registry lookup + NL safety policy
		const def = options.settingsRegistry.getByAppKey(appId, key);
		if (!def) {
			options.logger.warn(
				'<config-set> rejected key not in registry: %s.%s (userId=%s)',
				appId,
				key,
				options.userId,
			);
			continue;
		}
		if (!def.nlSafe || def.adminOnly || def.dangerous || def.hidden) {
			options.logger.warn(
				'<config-set> rejected non-NL-safe key: %s.%s (userId=%s)',
				appId,
				key,
				options.userId,
			);
			continue;
		}

		// Guard 3: per-key intent gate
		if (!def.nlIntentRegex || !def.nlIntentRegex.test(options.userMessage)) {
			continue;
		}

		// Guard 4: route through SettingsWriter (coercion + persistence)
		const result = await options.settingsWriter.write({
			userId: options.userId,
			appId,
			key,
			rawValue: value,
			source: 'nl',
		});

		if (!result.ok) {
			options.logger.warn('<config-set> write failed for %s.%s: %s', appId, key, result.reason);
			continue;
		}

		const confirmation = confirmationFor(appId, key, result.coerced, options.settingsRegistry);
		if (confirmation) confirmations.push(confirmation);

		// Guard 5: on disable, delete prior summary so toggle semantics match the name
		if (appId === 'chatbot' && key === 'flush_memory_on_idle_reset' && result.coerced === false) {
			await options.disableFlushAndCleanup?.(options.userId);
		}
	}

	return { cleanedResponse: normalizeResponse(stripped), confirmations };
}
