/**
 * Convert ConversationUserConfigEntry rows to SettingDef shape for SettingsRegistry.
 *
 * The adapter performs two responsibilities:
 *  1. Maps the `chatbot` appId onto every entry (so qualified keys become
 *     `chatbot.<key>`).
 *  2. Fills in defaults for optional metadata fields so SettingsRegistry
 *     validation never fails on a well-formed CONVERSATION_USER_CONFIG row.
 */
import type { SettingDef } from '../settings/settings-registry.js';
import type { ConversationUserConfigEntry } from './manifest.js';

export function conversationManifestToSettingDefs(
	entries: ConversationUserConfigEntry[],
): SettingDef[] {
	return entries.map((e) => ({
		key: e.key,
		appId: 'chatbot',
		category: e.category ?? 'personal',
		label: e.label ?? e.key,
		help: e.help ?? e.description,
		helpDetail: e.helpDetail,
		type: e.type,
		default: e.default,
		adminOnly: e.adminOnly ?? false,
		dangerous: e.dangerous ?? false,
		dangerConfirmPrompt: e.dangerConfirmPrompt,
		hidden: e.hidden ?? false,
		scope: 'per-user' as const,
		nlSafe: e.nlSafe ?? false,
		nlIntentRegex: e.nlIntentRegex,
	}));
}
