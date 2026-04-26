/**
 * Manifest constants for the conversation app.
 *
 * Mirrors apps/chatbot/manifest.yaml so a future Chunk B can register the
 * conversation app from core without re-reading the YAML.
 */

import type { ManifestDataScope } from '../../types/manifest.js';

export interface ConversationUserConfigEntry {
	key: string;
	type: 'boolean';
	default: boolean;
	description: string;
}

export const CONVERSATION_USER_CONFIG: ConversationUserConfigEntry[] = [
	{
		key: 'auto_detect_pas',
		type: 'boolean',
		default: true,
		description:
			'Automatically detect PAS-related questions and include app info in responses (uses LLM classification; disable to use basic conversational mode)',
	},
];

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
	{ path: 'history.json', access: 'read-write', description: 'Conversation history for context continuity' },
	{ path: 'daily-notes/', access: 'read-write', description: 'Daily notes fallback logging' },
];
