/**
 * Core conversation service — pure helpers used by the chatbot shim.
 *
 * Each export takes its dependencies explicitly so it can be unit-tested
 * without a CoreServices closure. The chatbot shim wires up its captured
 * `services` reference to these helpers.
 */

export { pendingEdits } from './pending-edits.js';

export { getAutoDetectSetting } from './auto-detect.js';

export {
	splitTelegramMessage,
	stripMarkdown,
	sendSplitResponse,
} from './telegram-format.js';

export { appendDailyNote } from './daily-notes.js';

export {
	MAX_CONTEXT_ENTRIES,
	MAX_KNOWLEDGE_ENTRIES,
	formatAppMetadata,
	gatherContext,
	getEnabledAppInfos,
	searchKnowledge,
} from './app-data.js';

export {
	extractRecentFilePaths,
	formatDataQueryContext,
	formatInteractionContextSummary,
} from './data-query-context.js';

export { buildUserContext } from './user-context.js';

export {
	MODEL_SWITCH_INTENT_REGEX,
	PAS_KEYWORDS,
	classifyPASMessage,
	isPasRelevant,
} from './pas-classifier.js';
export type { PASClassification } from './pas-classifier.js';

export {
	CATEGORY_KEYWORDS,
	categorizeQuestion,
	formatUptime,
	gatherSystemData,
	gatherUserDataOverview,
} from './system-data.js';
export type { QuestionCategory } from './system-data.js';

export { SWITCH_MODEL_TAG_REGEX, processModelSwitchTags } from './control-tags.js';

export { buildAppAwareSystemPrompt, buildSystemPrompt } from './prompt-builder.js';
export type { PromptBuilderDeps } from './prompt-builder.js';

export { handleEdit } from './handle-edit.js';
export type { HandleEditDeps } from './handle-edit.js';

export { handleAsk } from './handle-ask.js';
export type { HandleAskDeps } from './handle-ask.js';

export { handleMessage } from './handle-message.js';
export type { HandleMessageDeps } from './handle-message.js';

export {
	CONVERSATION_USER_CONFIG,
	CONVERSATION_LLM_SAFEGUARDS,
	CONVERSATION_DATA_SCOPES,
} from './manifest.js';
export type {
	ConversationUserConfigEntry,
	ConversationLLMSafeguards,
	ConversationDataScope,
} from './manifest.js';
