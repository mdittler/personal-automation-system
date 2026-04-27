import { ConversationService } from '../services/conversation/conversation-service.js';
import type { EditService } from '../services/edit/index.js';
import type { CoreServices } from '../types/app-module.js';

export function makeConversationService(
	services: CoreServices & { editService?: EditService },
): ConversationService {
	return new ConversationService({
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: 'UTC',
		systemInfo: services.systemInfo,
		appMetadata: services.appMetadata,
		appKnowledge: services.appKnowledge,
		modelJournal: services.modelJournal,
		contextStore: services.contextStore,
		config: services.config,
		dataQuery: services.dataQuery ?? undefined,
		interactionContext: services.interactionContext ?? undefined,
		editService: services.editService,
	});
}
