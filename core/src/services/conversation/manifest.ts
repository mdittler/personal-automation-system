/**
 * Manifest constants for the conversation service.
 *
 * Provides the CONVERSATION_USER_CONFIG, LLM safeguards, and data-scope
 * declarations used to register the chatbot as a core service with the
 * settings registry, app-config service, and LLM guard.
 */

import type { ManifestDataScope, ManifestUserConfig } from '../../types/manifest.js';
import type { SettingsCategory } from '../settings/settings-registry.js';
import { MEMORY_FLUSH_INTENT_REGEX, NOTES_INTENT_REGEX } from './control-tags.js';
import { SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX } from './control-tags/session-search-instruction.js';

/**
 * Internal TypeScript representation of a chatbot user-config entry.
 *
 * Extends the YAML-serializable ManifestUserConfig shape with:
 *  - `nlIntentRegex`: a compiled RegExp (not a string source) used at runtime
 *    for intent-gating NL config changes. The adapter in manifest-settings.ts
 *    forwards this directly to SettingDef without re-compilation.
 *  - Rich metadata fields (`label`, `help`, `helpDetail`, `category`, etc.)
 *    for SettingsRegistry registration.
 *
 * Note: CONVERSATION_USER_CONFIG is NOT directly assignable to ManifestUserConfig[]
 * because nlIntentRegex is RegExp here vs. string in the YAML schema. virtual-app.ts
 * maps entries to the plain ManifestUserConfig shape when building the AppManifest.
 */
export interface ConversationUserConfigEntry {
	key: string;
	type: 'boolean';
	default: boolean;
	description: string;
	label?: string;
	help?: string;
	helpDetail?: string;
	category?: SettingsCategory;
	adminOnly?: boolean;
	dangerous?: boolean;
	dangerConfirmPrompt?: string;
	hidden?: boolean;
	nlSafe?: boolean;
	/** Compiled RegExp (not a string source) — used directly by SettingsRegistry. */
	nlIntentRegex?: RegExp;
	/** Dot-path through SystemConfig used as effective default when no user override exists. */
	systemConfigBackingKey?: string;
}

export const CONVERSATION_USER_CONFIG: ConversationUserConfigEntry[] = [
	{
		key: 'auto_detect_pas',
		type: 'boolean',
		default: true,
		description:
			'Automatically detect PAS-related questions (uses LLM classification; disable to use basic conversational mode)',
		label: 'Smart chat detection',
		help: 'Detect when questions are PAS-related to inject app context.',
		category: 'personal',
		nlSafe: false,
	},
	{
		key: 'log_to_notes',
		type: 'boolean',
		default: false,
		description: 'Append every message to a daily-notes file (per-user opt-in, default OFF)',
		label: 'Daily notes logging',
		help: 'Save every chat message to your daily notes file.',
		category: 'personal',
		nlSafe: true,
		nlIntentRegex: NOTES_INTENT_REGEX,
		// When no user override exists, the system-wide chat.logToNotes value serves as the
		// effective default so the GUI and catalog show the operator default, not the manifest default.
		systemConfigBackingKey: 'chat.logToNotes',
	},
	{
		key: 'flush_memory_on_idle_reset',
		type: 'boolean',
		default: false,
		description:
			'When an idle session auto-resets, save a short summary of the conversation to your durable memory so the next session can refer back to it. (Per-user opt-in, default OFF. Turning OFF also deletes the most recent saved summary.)',
		label: 'Memory flush on session reset',
		help: 'Summarize the session to memory when the chat auto-resets.',
		category: 'memory-sessions',
		nlSafe: true,
		nlIntentRegex: MEMORY_FLUSH_INTENT_REGEX,
	},
	{
		key: 'session_search_tool_enabled',
		type: 'boolean',
		default: true,
		description:
			'Allow the chatbot to search your past conversations mid-reply when the model decides extra context is needed. (Per-user opt-in, default ON.)',
		label: 'Session search tool',
		help: 'Allow the chatbot to search your past conversations mid-reply.',
		category: 'memory-sessions',
		nlSafe: true,
		nlIntentRegex: SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX,
	},
	{
		key: 'app_message_bridge_enabled',
		type: 'boolean',
		default: true,
		description:
			'When enabled, messages that PAS apps send to you proactively (weekly menus, scheduled reports, alerts) are recorded in your chat session so the chatbot can discuss them. Disable to keep them out of the transcript.',
		label: 'Show app-sent messages in chat memory',
		help: 'Record proactive app notifications in your chat session so the chatbot can reference them.',
		category: 'memory-sessions',
		nlSafe: false,
	},
];

/**
 * Plain ManifestUserConfig[] form of CONVERSATION_USER_CONFIG.
 *
 * Use this wherever ManifestUserConfig[] is required (AppConfigServiceImpl,
 * processConfigSetTags, AppManifest.user_config). The nlIntentRegex RegExp
 * fields are stripped because ManifestUserConfig.nlIntentRegex is a string
 * source (for YAML serialisation).
 */
export const CONVERSATION_USER_CONFIG_MANIFEST: ManifestUserConfig[] = CONVERSATION_USER_CONFIG.map(
	({ nlIntentRegex: _regex, ...rest }) => rest,
);

export interface ConversationLLMSafeguards {
	tier: 'standard';
	rate_limit: { max_requests: number; window_seconds: number };
	monthly_cost_cap: number;
}

export const CONVERSATION_LLM_SAFEGUARDS: ConversationLLMSafeguards = {
	tier: 'standard',
	// 60 req/hour: auto_detect_pas (default on) makes 2 LLM calls per message
	// (fast-tier classifier + standard-tier response), so 60 preserves ~30
	// effective messages/hour.
	rate_limit: { max_requests: 60, window_seconds: 3600 },
	monthly_cost_cap: 15.0,
};

export type { ManifestDataScope as ConversationDataScope };

export const CONVERSATION_DATA_SCOPES: ManifestDataScope[] = [
	{
		path: 'history.json',
		access: 'read-write',
		description: 'Conversation history for context continuity',
	},
	{ path: 'daily-notes/', access: 'read-write', description: 'Daily notes fallback logging' },
	{
		path: 'conversation/',
		access: 'read-write',
		description: 'Per-session transcript files and active-session index',
	},
];
