import { describe, expect, test } from 'vitest';
import {
	CONVERSATION_DATA_SCOPES,
	CONVERSATION_LLM_SAFEGUARDS,
	CONVERSATION_USER_CONFIG,
} from '../manifest.js';
import { buildVirtualChatbotApp } from '../virtual-app.js';

describe('Virtual chatbot manifest — full structural contract (post-Chunk-D)', () => {
	const { manifest } = buildVirtualChatbotApp();

	test('app metadata: id, name, version, non-empty description', () => {
		expect(manifest.app.id).toBe('chatbot');
		expect(manifest.app.name).toBe('Chatbot');
		expect(manifest.app.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.app.description.length).toBeGreaterThan(20);
	});

	test('requirements.services lists every service ConversationService consumes', () => {
		expect(manifest.requirements.services).toEqual([
			'telegram',
			'data-store',
			'llm',
			'context-store',
			'app-metadata',
			'app-knowledge',
			'model-journal',
			'system-info',
			'data-query',
			'interaction-context',
			'edit-service',
		]);
	});

	test('requirements.data.user_scopes equals CONVERSATION_DATA_SCOPES (history.json + daily-notes/, both read-write)', () => {
		expect(manifest.requirements.data?.user_scopes).toEqual(CONVERSATION_DATA_SCOPES);
		expect(CONVERSATION_DATA_SCOPES).toEqual([
			{ path: 'history.json', access: 'read-write', description: expect.any(String) },
			{ path: 'daily-notes/', access: 'read-write', description: expect.any(String) },
		]);
	});

	test('requirements.llm matches CONVERSATION_LLM_SAFEGUARDS (tier=standard, 60/3600s, $15/mo)', () => {
		expect(manifest.requirements.llm).toEqual(CONVERSATION_LLM_SAFEGUARDS);
		expect(CONVERSATION_LLM_SAFEGUARDS).toEqual({
			tier: 'standard',
			rate_limit: { max_requests: 60, window_seconds: 3600 },
			monthly_cost_cap: 15.0,
		});
	});

	test('user_config exposes auto_detect_pas (default true) and log_to_notes (default false) per REQ-CONV-007', () => {
		const autoDetect = manifest.user_config?.find((c) => c.key === 'auto_detect_pas');
		const logToNotes = manifest.user_config?.find((c) => c.key === 'log_to_notes');
		expect(manifest.user_config?.map((c) => c.key)).toEqual(['auto_detect_pas', 'log_to_notes']);
		expect(autoDetect?.default).toBe(true);
		expect(logToNotes?.default).toBe(false);
		expect(manifest.user_config).toEqual(CONVERSATION_USER_CONFIG);
	});
});
