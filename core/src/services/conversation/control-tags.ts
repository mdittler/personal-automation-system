/**
 * Control tag processors for LLM response post-processing.
 *
 * <switch-model>: admin-only model switching (pre-existing).
 * <config-set>:   per-user config writes (Chunk C, allowlisted + intent-gated).
 */

import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';
import type { SystemInfoService } from '../../types/system-info.js';
import { coerceUserConfigValue } from '../config/coerce-user-config.js';
import { MODEL_SWITCH_INTENT_REGEX } from './pas-classifier.js';

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

const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set(['log_to_notes']);

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
 * Instruction appended to the system prompt when the user message matches
 * NOTES_INTENT_REGEX. Tells the LLM how to request a config change.
 */
export const CONFIG_SET_INSTRUCTION_BLOCK = `
When the user wants to enable or disable daily notes logging, include exactly one of these tags in your response (it will be removed from your visible reply after processing):
  To enable:  <config-set key="log_to_notes" value="true"/>
  To disable: <config-set key="log_to_notes" value="false"/>
Only emit this tag when the user explicitly requests a change. Do not emit it to report the current state.`.trim();

export interface ProcessConfigSetTagsOptions {
	userId: string;
	userMessage: string;
	config: AppConfigService;
	manifest: ManifestUserConfig[];
	logger: AppLogger;
}

/**
 * Process <config-set> tags emitted by the LLM.
 *
 * Security guards (in order):
 * 1. Keys not in ALLOWED_CONFIG_KEYS → strip and warn.
 * 2. User message lacks notes intent → strip all tags, no writes.
 * 3. Coercion failure → strip and warn (no user-facing message).
 * 4. Otherwise → updateOverrides with only the changed key (raw overrides only).
 */
export async function processConfigSetTags(
	response: string,
	options: ProcessConfigSetTagsOptions,
): Promise<{ cleanedResponse: string; confirmations: string[] }> {
	const confirmations: string[] = [];

	if (!response.includes('<config-set')) {
		return { cleanedResponse: response, confirmations };
	}

	// Collect all tags, validating the allowlist
	const allowedTags: Array<{ key: string; value: string }> = [];
	for (const match of response.matchAll(CONFIG_SET_TAG_REGEX)) {
		const key = match[1] ?? '';
		const value = match[2] ?? '';
		if (!ALLOWED_CONFIG_KEYS.has(key)) {
			options.logger.warn('<config-set> rejected key not in allowlist: %s (userId=%s)', key, options.userId);
			continue;
		}
		allowedTags.push({ key, value });
	}

	// Strip all well-formed tags; sweep for malformed/reordered/extra-attr remnants
	const stripped = response.replace(CONFIG_SET_TAG_REGEX, '').replace(/<config-set\b[^>]*\/?>/g, '');

	// Gate: intent regex must match the actual user message
	if (!NOTES_INTENT_REGEX.test(options.userMessage)) {
		return { cleanedResponse: normalizeResponse(stripped), confirmations };
	}

	// Process surviving tags
	for (const { key, value } of allowedTags) {
		const entry = options.manifest.find((e) => e.key === key);
		if (!entry) {
			options.logger.warn('<config-set> key not in manifest: %s', key);
			continue;
		}

		const result = coerceUserConfigValue(entry, value);
		if (!result.ok) {
			options.logger.warn('<config-set> coercion failed for key %s: %s', key, result.reason);
			continue;
		}

		// Write only raw override keys (never manifest defaults)
		try {
			await options.config.updateOverrides(options.userId, { [key]: result.coerced });
			if (key === 'log_to_notes') {
				confirmations.push(
					result.coerced ? 'Daily notes logging turned ON.' : 'Daily notes logging turned OFF.',
				);
			}
		} catch (err) {
			options.logger.warn('<config-set> failed to persist %s: %s', key, err);
		}
	}

	return { cleanedResponse: normalizeResponse(stripped), confirmations };
}
