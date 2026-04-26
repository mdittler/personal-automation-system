/**
 * Chatbot app — thin shim over `@pas/core/services/conversation`.
 *
 * The real logic lives in `core/src/services/conversation/`. This shim
 * captures the CoreServices reference at init() and forwards each
 * AppModule callback into the corresponding core helper, passing the
 * services explicitly.
 *
 * See `core/src/services/conversation/` for the conversation app's
 * helpers, prompt builders, and command handlers.
 */

import {
	MODEL_SWITCH_INTENT_REGEX,
	categorizeQuestion,
	buildAppAwareSystemPrompt as coreBuildAppAwareSystemPrompt,
	buildSystemPrompt as coreBuildSystemPrompt,
	buildUserContext as coreBuildUserContext,
	classifyPASMessage as coreClassifyPASMessage,
	handleMessage as coreHandleMessage,
	isPasRelevant as coreIsPasRelevant,
	processModelSwitchTags as coreProcessModelSwitchTags,
	extractRecentFilePaths,
	formatInteractionContextSummary,
	gatherSystemData,
	handleAsk,
	handleEdit,
	pendingEdits,
	splitTelegramMessage,
} from '@pas/core/services/conversation';
import type { ConversationTurn } from '@pas/core/services/conversation-history';
import { ConversationHistory } from '@pas/core/services/conversation-history';
import type { AppModule, CoreServices, MessageContext } from '@pas/core/types';

let services: CoreServices;
const history = new ConversationHistory({ maxTurns: 20 });

export {
	pendingEdits,
	MODEL_SWITCH_INTENT_REGEX,
	categorizeQuestion,
	extractRecentFilePaths,
	formatInteractionContextSummary,
	gatherSystemData,
	splitTelegramMessage,
};
export type { PASClassification } from '@pas/core/services/conversation';

export const init: AppModule['init'] = async (s) => {
	services = s;
};

/** Build the dependency object passed to core conversation helpers. */
function makeDeps() {
	return {
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: services.timezone,
		history,
		systemInfo: services.systemInfo,
		appMetadata: services.appMetadata,
		appKnowledge: services.appKnowledge,
		modelJournal: services.modelJournal,
		contextStore: services.contextStore,
		config: services.config,
		dataQuery: services.dataQuery,
		interactionContext: services.interactionContext,
	};
}

export const handleMessage: AppModule['handleMessage'] = async (ctx: MessageContext) => {
	return coreHandleMessage(ctx, makeDeps());
};

/**
 * @deprecated The Router no longer dispatches /ask or /edit through this path
 * (they are Router built-ins since Chunk C). This export is kept only for the
 * existing test suite; it will be removed in Chunk D when apps/chatbot/ is deleted.
 */
export const handleCommand: AppModule['handleCommand'] = async (
	command: string,
	args: string[],
	ctx: MessageContext,
) => {
	// Router strips the leading slash before dispatching — we receive the
	// bare command name. See AppModule.handleCommand documentation.
	if (command === 'edit') {
		await handleEdit(args, ctx, {
			editService: services.editService,
			telegram: services.telegram,
			logger: services.logger,
			pendingEdits,
		});
		return;
	}

	if (command !== 'ask') return;

	await handleAsk(args, ctx, makeDeps());
};

// ---------------------------------------------------------------------------
// Re-exports that wrap core helpers with the captured services closure so
// existing tests keep their original signatures.
// ---------------------------------------------------------------------------

export async function buildSystemPrompt(
	contextEntries: string[],
	turns: ConversationTurn[],
	modelSlug?: string,
	userCtx?: string,
): Promise<string> {
	return coreBuildSystemPrompt(contextEntries, turns, makeDeps(), modelSlug, userCtx);
}

export async function buildAppAwareSystemPrompt(
	question: string,
	userId: string,
	contextEntries: string[],
	turns: ConversationTurn[],
	modelSlug?: string,
	userCtx?: string,
	dataContext?: string,
): Promise<string> {
	return coreBuildAppAwareSystemPrompt(
		question,
		userId,
		contextEntries,
		turns,
		makeDeps(),
		modelSlug,
		userCtx,
		dataContext,
	);
}

export async function buildUserContext(
	ctx: MessageContext,
	svc: CoreServices,
): Promise<string> {
	return coreBuildUserContext(ctx, svc);
}

export function isPasRelevant(text: string): boolean {
	return coreIsPasRelevant(text, services);
}

export async function classifyPASMessage(
	text: string,
	svc: CoreServices,
	recentContext?: string,
): Promise<{ pasRelated: boolean; dataQueryCandidate?: boolean }> {
	return coreClassifyPASMessage(text, svc, recentContext);
}

export async function processModelSwitchTags(
	response: string,
	options?: { userId?: string; userMessage?: string },
): Promise<{ cleanedResponse: string; confirmations: string[] }> {
	return coreProcessModelSwitchTags(response, {
		userId: options?.userId,
		userMessage: options?.userMessage,
		deps: services,
	});
}
