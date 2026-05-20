/**
 * Build SettingsRegistry from chatbot virtual manifest + installed app manifests.
 *
 * Filters appId === 'chatbot' from installed apps to prevent double-register.
 * Throws on invalid nlIntentRegex strings — silent downgrade would make settings
 * undiscoverable and hard to debug.
 */
import type { AppManifest, ManifestUserConfig } from '../../types/manifest.js';
import { conversationManifestToSettingDefs } from '../conversation/manifest-settings.js';
import { CONVERSATION_USER_CONFIG } from '../conversation/manifest.js';
import { type SettingDef, type SettingsCategory, SettingsRegistry } from './settings-registry.js';

export interface BuildSettingsRegistryDeps {
	installedApps: AppManifest[];
	/** System-scope setting defs to register with appId: 'system'. */
	systemDefs?: ReadonlyArray<Omit<SettingDef, 'appId'>>;
}

export function buildSettingsRegistry(deps: BuildSettingsRegistryDeps): SettingsRegistry {
	const reg = new SettingsRegistry();

	// 1. Chatbot virtual manifest (registered first).
	for (const def of conversationManifestToSettingDefs(CONVERSATION_USER_CONFIG)) {
		reg.register(def);
	}

	// 2. System-scope defs (appId: 'system').
	for (const def of deps.systemDefs ?? []) {
		reg.register({ ...def, appId: 'system' });
	}

	// 3. Installed app manifests — skip appId === 'chatbot' (no double-register).
	for (const manifest of deps.installedApps) {
		const appId = manifest.app.id;
		if (appId === 'chatbot') continue;
		const entries = (manifest as { user_config?: ManifestUserConfig[] }).user_config ?? [];
		for (const entry of entries) {
			reg.register(entryToDef(entry, appId));
		}
	}

	return reg;
}

function entryToDef(entry: ManifestUserConfig, appId: string): SettingDef {
	let nlIntentRegex: RegExp | undefined;
	const nlSafe = entry.nlSafe ?? false;
	if (nlSafe) {
		if (typeof entry.nlIntentRegex !== 'string' || entry.nlIntentRegex.length === 0) {
			throw new Error(
				`buildSettingsRegistry: nlIntentRegex required when nlSafe=true (key '${appId}.${entry.key}')`,
			);
		}
		try {
			nlIntentRegex = new RegExp(entry.nlIntentRegex, 'i');
		} catch (err) {
			throw new Error(
				`buildSettingsRegistry: invalid nlIntentRegex for key '${appId}.${entry.key}': ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	const isHidden = entry.hidden === true;
	if (!isHidden && (!entry.help || !entry.help.trim())) {
		throw new Error(
			`buildSettingsRegistry: 'help' is required for non-hidden manifest entry '${appId}.${entry.key}' (REQ-SETTINGS-006)`,
		);
	}

	return {
		key: entry.key,
		appId,
		category: (entry.category as SettingsCategory) ?? defaultCategoryForApp(appId),
		label: entry.label ?? entry.key,
		help: entry.help ?? '',
		helpDetail: entry.helpDetail,
		type: entry.type,
		options: entry.options,
		default: entry.default,
		adminOnly: entry.adminOnly ?? false,
		dangerous: entry.dangerous ?? false,
		dangerConfirmPrompt: entry.dangerConfirmPrompt,
		hidden: entry.hidden ?? false,
		scope: 'per-user',
		nlSafe,
		nlIntentRegex,
		min: entry.min,
		max: entry.max,
	};
}

function defaultCategoryForApp(appId: string): SettingsCategory {
	if (appId === 'food') return 'food';
	if (appId === 'notes') return 'notes';
	return 'personal';
}
