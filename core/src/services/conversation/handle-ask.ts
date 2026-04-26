/**
 * /ask command handler.
 *
 * Always uses the app-aware system prompt (no auto-detect classifier needed
 * here — /ask is explicitly for PAS questions). Still calls
 * classifyPASMessage to decide whether to gather DataQueryService results.
 */

import type { AppKnowledgeBaseService } from '../../types/app-knowledge.js';
import type { AppMetadataService } from '../../types/app-metadata.js';
import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import type { ContextStoreService } from '../../types/context-store.js';
import type { DataQueryService } from '../../types/data-query.js';
import type { DataStoreService } from '../../types/data-store.js';
import type { LLMService } from '../../types/llm.js';
import type { ModelJournalService } from '../../types/model-journal.js';
import type { SystemInfoService } from '../../types/system-info.js';
import type { MessageContext, TelegramService } from '../../types/telegram.js';
import { classifyLLMError } from '../../utils/llm-errors.js';
import { slugifyModelId } from '../../utils/slugify.js';
import type { ConversationHistory } from '../conversation-history/index.js';
import type { InteractionContextService } from '../interaction-context/index.js';
import {
	extractJournalEntries,
	sanitizeInput,
	writeJournalEntries,
} from '../prompt-assembly/index.js';
import { gatherContext } from './app-data.js';
import {
	CONFIG_SET_INSTRUCTION_BLOCK,
	NOTES_INTENT_REGEX,
	normalizeResponse,
	processConfigSetTags,
	processModelSwitchTags,
} from './control-tags.js';
import { appendDailyNote } from './daily-notes.js';
import { CONVERSATION_USER_CONFIG } from './manifest.js';
import {
	extractRecentFilePaths,
	formatDataQueryContext,
	formatInteractionContextSummary,
} from './data-query-context.js';
import { classifyPASMessage } from './pas-classifier.js';
import { buildAppAwareSystemPrompt } from './prompt-builder.js';
import { sendSplitResponse } from './telegram-format.js';
import { buildUserContext } from './user-context.js';

export interface HandleAskDeps {
	llm: LLMService;
	telegram: TelegramService;
	data: DataStoreService;
	logger: AppLogger;
	timezone: string;
	history: ConversationHistory;
	systemInfo?: SystemInfoService;
	appMetadata?: AppMetadataService;
	appKnowledge?: AppKnowledgeBaseService;
	modelJournal?: ModelJournalService;
	contextStore?: ContextStoreService;
	config?: AppConfigService;
	dataQuery?: DataQueryService;
	interactionContext?: InteractionContextService;
	/** System-level default for daily-notes opt-in. Defaults to false if absent. */
	chatLogToNotesDefault?: boolean;
}

export async function handleAsk(
	args: string[],
	ctx: MessageContext,
	deps: HandleAskDeps,
): Promise<void> {
	const question = args.join(' ').trim();

	// No args — send static intro (no LLM cost)
	if (!question) {
		await deps.telegram.send(
			ctx.userId,
			"I'm your PAS assistant. Ask me about installed apps, commands, how things work, system status, or your data.\n\n" +
				'Examples:\n' +
				'  /ask what apps do I have?\n' +
				'  /ask how does scheduling work?\n' +
				'  /ask what commands are available?\n' +
				'  /ask what model is being used?\n' +
				'  /ask how much have I spent this month?\n' +
				"  /ask what's the cost per token?\n" +
				'  /ask switch the fast model to claude-haiku-4-5\n' +
				'  /ask what scheduled jobs are running?\n' +
				'  /ask what data do I have?\n' +
				'  /ask show my recent notes',
		);
		return;
	}

	const store = deps.data.forUser(ctx.userId);
	const modelId = deps.llm.getModelForTier?.('standard') ?? 'unknown';
	const modelSlug = slugifyModelId(modelId);
	// D2c: interaction context is synchronous; compute before fan-out
	const recentEntries = deps.interactionContext?.getRecent(ctx.userId) ?? [];
	const recentContextSummary = formatInteractionContextSummary(recentEntries);
	const recentFilePaths = extractRecentFilePaths(recentEntries);

	const [{ wrote: noteWrote }, turns, contextEntries, userCtx] = await Promise.all([
		appendDailyNote(ctx, {
			data: deps.data,
			logger: deps.logger,
			timezone: deps.timezone,
			config: deps.config,
			systemDefault: deps.chatLogToNotesDefault ?? false,
		}),
		deps.history.load(store),
		gatherContext(question, ctx.userId, deps),
		buildUserContext(ctx, deps),
	]);

	// D2b/D2c: call DataQueryService when classifier detects a data query.
	let askDataContext = '';
	const askClassification = await classifyPASMessage(
		question,
		deps,
		recentContextSummary || undefined,
	);
	if (askClassification.dataQueryCandidate && deps.dataQuery) {
		try {
			const result = await deps.dataQuery.query(
				question,
				ctx.userId,
				recentFilePaths.length > 0 ? { recentFilePaths } : undefined,
			);
			if (!result.empty) {
				askDataContext = formatDataQueryContext(result);
			}
		} catch (error) {
			deps.logger.warn('DataQueryService call failed in /ask: %s', error);
		}
	}

	let systemPrompt = await buildAppAwareSystemPrompt(
		question,
		ctx.userId,
		contextEntries,
		turns,
		deps,
		modelSlug,
		userCtx,
		askDataContext,
	);

	if (deps.config && NOTES_INTENT_REGEX.test(question)) {
		systemPrompt = `${systemPrompt}\n\n${CONFIG_SET_INSTRUCTION_BLOCK}`;
	}

	let response: string;
	try {
		response = await deps.llm.complete(sanitizeInput(question), {
			tier: 'standard',
			systemPrompt,
			maxTokens: 2048,
			temperature: 0.7,
		});
	} catch (error) {
		deps.logger.error('Chatbot /ask LLM call failed: %s', error);
		const { userMessage } = classifyLLMError(error);
		const suffix = noteWrote ? '\n\nYour question was saved to your daily notes.' : '';
		await deps.telegram.send(ctx.userId, `${userMessage}${suffix}`);
		return;
	}

	const { cleanedResponse: afterJournal, entries: journalEntries } =
		extractJournalEntries(response);
	if (deps.modelJournal) {
		await writeJournalEntries(deps.modelJournal, modelSlug, journalEntries, deps.logger);
	}

	const { cleanedResponse: afterModelSwitch, confirmations: switchConfirmations } =
		await processModelSwitchTags(afterJournal, {
			userId: ctx.userId,
			userMessage: question,
			deps,
		});

	let finalResponse = afterModelSwitch;
	const allConfirmations = [...switchConfirmations];
	if (deps.config) {
		const { cleanedResponse: afterConfigSet, confirmations: configConfirmations } =
			await processConfigSetTags(afterModelSwitch, {
				userId: ctx.userId,
				userMessage: question,
				config: deps.config,
				manifest: CONVERSATION_USER_CONFIG,
				logger: deps.logger,
			});
		finalResponse = afterConfigSet;
		allConfirmations.push(...configConfirmations);
	}

	const responseWithConfirmations =
		allConfirmations.length > 0
			? normalizeResponse(`${finalResponse}\n\n${allConfirmations.join('\n')}`)
			: normalizeResponse(finalResponse);

	await sendSplitResponse(ctx.userId, responseWithConfirmations, deps);

	const now = ctx.timestamp.toISOString();
	try {
		await deps.history.append(
			store,
			{ role: 'user', content: `/ask ${question}`, timestamp: now },
			{ role: 'assistant', content: responseWithConfirmations, timestamp: now },
		);
	} catch (error) {
		deps.logger.warn('Failed to save conversation history: %s', error);
	}
}
