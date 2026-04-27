import type { AppManifest } from '../../types/manifest.js';
import type { AppModule } from '../../types/app-module.js';
import {
	CONVERSATION_DATA_SCOPES,
	CONVERSATION_LLM_SAFEGUARDS,
	CONVERSATION_USER_CONFIG,
} from './manifest.js';

/**
 * Build the synthetic chatbot AppManifest + AppModule pair used after
 * apps/chatbot/ is deleted (Hermes P1 Chunk D, REQ-CONV-013). The module's
 * handleMessage throws as a regression tripwire — Router free-text dispatch
 * goes through ConversationService.handleMessage, never app.module.handleMessage.
 */
export function buildVirtualChatbotApp(): { manifest: AppManifest; module: AppModule } {
	const manifest: AppManifest = {
		app: {
			id: 'chatbot',
			name: 'Chatbot',
			version: '1.3.0',
			description:
				'AI assistant with PAS app awareness and system introspection. Handles messages when no other app matches.',
			pas_core_version: '>=0.1.0',
		},
		capabilities: { messages: { intents: [] } },
		requirements: {
			services: [
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
			],
			data: { user_scopes: CONVERSATION_DATA_SCOPES },
			llm: {
				tier: CONVERSATION_LLM_SAFEGUARDS.tier,
				rate_limit: CONVERSATION_LLM_SAFEGUARDS.rate_limit,
				monthly_cost_cap: CONVERSATION_LLM_SAFEGUARDS.monthly_cost_cap,
			},
		},
		user_config: CONVERSATION_USER_CONFIG,
	} as unknown as AppManifest;

	const module: AppModule = {
		init: async () => {},
		handleMessage: async () => {
			throw new Error(
				'virtual chatbot app.module.handleMessage was invoked — Router free-text dispatch ' +
					'must go through ConversationService.handleMessage (REQ-CONV-013 tripwire).',
			);
		},
	};

	return { manifest, module };
}
