/**
 * Process `<switch-model>` control tags emitted by the LLM in /ask responses.
 *
 * Guards (in order):
 * 1. No tags present → pass through unchanged.
 * 2. systemInfo missing → strip tags silently.
 * 3. userId missing or not admin → strip tags silently.
 * 4. userMessage lacks model-switch intent → strip tags silently.
 * 5. Otherwise → process each tag via SystemInfoService.setTierModel().
 */

import type { AppLogger } from '../../types/app-module.js';
import type { SystemInfoService } from '../../types/system-info.js';
import { MODEL_SWITCH_INTENT_REGEX } from './pas-classifier.js';

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
			cleanedResponse: response.replace(/\n{3,}/g, '\n\n').trim(),
			confirmations,
		};
	}

	const { systemInfo } = options.deps;

	if (!systemInfo) {
		const cleaned = response.replace(SWITCH_MODEL_TAG_REGEX, '');
		return {
			cleanedResponse: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
			confirmations,
		};
	}

	// Guard: require admin (only when tags are present)
	if (!options.userId || !systemInfo.isUserAdmin(options.userId)) {
		const cleaned = response.replace(SWITCH_MODEL_TAG_REGEX, '');
		return {
			cleanedResponse: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
			confirmations,
		};
	}

	// Guard: require explicit model-switch intent in the user message (only when tags present)
	if (!options.userMessage || !MODEL_SWITCH_INTENT_REGEX.test(options.userMessage)) {
		const cleaned = response.replace(SWITCH_MODEL_TAG_REGEX, '');
		return {
			cleanedResponse: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
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
		cleanedResponse: cleanedResponse.replace(/\n{3,}/g, '\n\n').trim(),
		confirmations,
	};
}
