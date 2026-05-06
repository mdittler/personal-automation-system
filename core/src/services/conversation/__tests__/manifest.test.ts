import { describe, expect, it } from 'vitest';
import { CONVERSATION_USER_CONFIG } from '../manifest.js';
import { SettingsRegistry } from '../../settings/settings-registry.js';
import { conversationManifestToSettingDefs } from '../manifest-settings.js';

describe('CONVERSATION_USER_CONFIG settings registration', () => {
	it('three nlSafe keys have nlSafe=true and nlIntentRegex', () => {
		const keysWithExistingNlSupport = new Set([
			'log_to_notes',
			'flush_memory_on_idle_reset',
			'session_search_tool_enabled',
		]);
		for (const e of CONVERSATION_USER_CONFIG) {
			if (keysWithExistingNlSupport.has(e.key)) {
				expect(e.nlSafe, `${e.key} must be nlSafe`).toBe(true);
				expect(e.nlIntentRegex, `${e.key} must have nlIntentRegex`).toBeDefined();
			}
		}
	});

	it('all entries register into SettingsRegistry without throwing', () => {
		const reg = new SettingsRegistry();
		const defs = conversationManifestToSettingDefs(CONVERSATION_USER_CONFIG);
		for (const def of defs) reg.register(def);
		expect(reg.getAll().length).toBe(CONVERSATION_USER_CONFIG.length);
		expect(reg.getByQualifiedKey('chatbot.log_to_notes')).toBeDefined();
	});

	it('auto_detect_pas registers under category="personal"', () => {
		const reg = new SettingsRegistry();
		for (const def of conversationManifestToSettingDefs(CONVERSATION_USER_CONFIG)) reg.register(def);
		expect(reg.getByAppKey('chatbot', 'auto_detect_pas')?.category).toBe('personal');
	});
});
