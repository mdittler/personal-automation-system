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

	// Append to daily notes (opt-in)
	const { wrote: noteWrote } = await appendDailyNote(ctx, {
		data: deps.data,
		logger: deps.logger,
		timezone: deps.timezone,
		config: deps.config,
		systemDefault: deps.chatLogToNotesDefault ?? false,
	});

	// Load conversation context
	const store = deps.data.forUser(ctx.userId);
	const turns = await deps.history.load(store);
	const contextEntries = await gatherContext(question, ctx.userId, {
		...(deps.contextStore !== undefined ? { contextStore: deps.contextStore } : {}),
		logger: deps.logger,
	});

	// Determine model identity for journal
	const modelId = deps.llm.getModelForTier?.('standard') ?? 'unknown';
	const modelSlug = slugifyModelId(modelId);

	// Build app-aware prompt (always app-aware for /ask, no classification needed)
	const userCtx = await buildUserContext(ctx, {
		...(deps.appMetadata !== undefined ? { appMetadata: deps.appMetadata } : {}),
		logger: deps.logger,
	});

	// D2b/D2c: call DataQueryService when classifier detects a data query.
	const recentEntries = deps.interactionContext?.getRecent(ctx.userId) ?? [];
	const recentContextSummary = formatInteractionContextSummary(recentEntries);
	const recentFilePaths = extractRecentFilePaths(recentEntries);

	let askDataContext = '';
	const askClassification = await classifyPASMessage(
		question,
		{
			llm: deps.llm,
			...(deps.appMetadata !== undefined ? { appMetadata: deps.appMetadata } : {}),
			logger: deps.logger,
		},
		recentContextSummary || undefined,
	);
	if (askClassification.dataQueryCandidate && deps.dataQuery) {
		try {
			const result =
				recentFilePaths.length > 0
					? await deps.dataQuery.query(question, ctx.userId, { recentFilePaths })
					: await deps.dataQuery.query(question, ctx.userId);
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
		{
			llm: deps.llm,
			...(deps.systemInfo !== undefined ? { systemInfo: deps.systemInfo } : {}),
			...(deps.appMetadata !== undefined ? { appMetadata: deps.appMetadata } : {}),
			...(deps.appKnowledge !== undefined ? { appKnowledge: deps.appKnowledge } : {}),
			...(deps.modelJournal !== undefined ? { modelJournal: deps.modelJournal } : {}),
			data: deps.data,
			logger: deps.logger,
		},
		modelSlug,
		userCtx,
		askDataContext,
	);

	// Append <config-set> instruction post-prompt-build when question has notes intent
	if (NOTES_INTENT_REGEX.test(question) && deps.config) {
		systemPrompt = `${systemPrompt}\n\n${CONFIG_SET_INSTRUCTION_BLOCK}`;
	}

	// Call LLM
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

	// Extract journal entries and clean response
	const { cleanedResponse: afterJournal, entries: journalEntries } =
		extractJournalEntries(response);
	if (deps.modelJournal) {
		await writeJournalEntries(deps.modelJournal, modelSlug, journalEntries, deps.logger);
	}

	// Process model switch tags (admin-only, requires explicit intent)
	const { cleanedResponse: afterModelSwitch, confirmations: switchConfirmations } =
		await processModelSwitchTags(afterJournal, {
			userId: ctx.userId,
			userMessage: question,
			deps: {
				...(deps.systemInfo !== undefined ? { systemInfo: deps.systemInfo } : {}),
				logger: deps.logger,
			},
		});

	// Process <config-set> tags (user-facing config writes, allowlisted + intent-gated)
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
		allConfirmations.length > 0 ? `${finalResponse}\n\n${allConfirmations.join('\n')}` : finalResponse;

	// Send response, splitting if over Telegram message limit
	await sendSplitResponse(ctx.userId, responseWithConfirmations, {
		telegram: deps.telegram,
		logger: deps.logger,
	});

	// Save conversation history (with cleaned response)
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
