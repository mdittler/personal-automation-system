/**
 * Generic chatbot handleMessage implementation.
 *
 * Steps:
 *   1. Append the message to today's daily note (preserves pre-chatbot fallback).
 *   2. Load conversation history.
 *   3. Gather context-store entries.
 *   4. If auto_detect_pas is on, run the LLM classifier and choose between the
 *      app-aware prompt and the basic prompt; otherwise always use basic.
 *   5. Call the LLM at standard tier; classify any error to a user-friendly
 *      message.
 *   6. Strip <model-journal> tags, persist their content, and strip any
 *      <switch-model> tags WITHOUT executing them (model switching is
 *      admin-only and requires the explicit /ask path).
 *   7. Send the cleaned response (split for Telegram), then save history.
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
import type { ConversationHistory, ConversationTurn } from '../conversation-history/index.js';
import type { InteractionContextService } from '../interaction-context/index.js';
import {
	extractJournalEntries,
	sanitizeInput,
	writeJournalEntries,
} from '../prompt-assembly/index.js';
import { gatherContext } from './app-data.js';
import { getAutoDetectSetting } from './auto-detect.js';
import { SWITCH_MODEL_TAG_REGEX } from './control-tags.js';
import { appendDailyNote } from './daily-notes.js';
import {
	extractRecentFilePaths,
	formatDataQueryContext,
	formatInteractionContextSummary,
} from './data-query-context.js';
import { classifyPASMessage } from './pas-classifier.js';
import { buildAppAwareSystemPrompt, buildSystemPrompt } from './prompt-builder.js';
import { sendSplitResponse } from './telegram-format.js';
import { buildUserContext } from './user-context.js';

export interface HandleMessageDeps {
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
}

export async function handleMessage(ctx: MessageContext, deps: HandleMessageDeps): Promise<void> {
	// 1. Append to daily notes (preserve existing fallback behavior)
	await appendDailyNote(ctx, {
		data: deps.data,
		logger: deps.logger,
		timezone: deps.timezone,
	});

	// 2. Load conversation history
	const store = deps.data.forUser(ctx.userId);
	const turns = await deps.history.load(store);

	// 3. Gather relevant context from ContextStore
	const contextEntries = await gatherContext(ctx.text, ctx.userId, {
		...(deps.contextStore !== undefined ? { contextStore: deps.contextStore } : {}),
		logger: deps.logger,
	});

	// 4. Determine model identity for journal
	const modelId = deps.llm.getModelForTier?.('standard') ?? 'unknown';
	const modelSlug = slugifyModelId(modelId);

	// 5. Auto-detect PAS classification + system prompt selection
	let systemPrompt: string;
	const autoDetect = await getAutoDetectSetting(ctx.userId, {
		...(deps.config !== undefined ? { config: deps.config } : {}),
	});
	const userCtx = await buildUserContext(ctx, {
		...(deps.appMetadata !== undefined ? { appMetadata: deps.appMetadata } : {}),
		logger: deps.logger,
	});

	const promptDeps = {
		llm: deps.llm,
		...(deps.systemInfo !== undefined ? { systemInfo: deps.systemInfo } : {}),
		...(deps.appMetadata !== undefined ? { appMetadata: deps.appMetadata } : {}),
		...(deps.appKnowledge !== undefined ? { appKnowledge: deps.appKnowledge } : {}),
		...(deps.modelJournal !== undefined ? { modelJournal: deps.modelJournal } : {}),
		data: deps.data,
		logger: deps.logger,
	};

	if (autoDetect) {
		// D2c: get recent interaction context for classifier + dataQuery hints
		const recentEntries = deps.interactionContext?.getRecent(ctx.userId) ?? [];
		const recentContextSummary = formatInteractionContextSummary(recentEntries);
		const recentFilePaths = extractRecentFilePaths(recentEntries);

		const classification = await classifyPASMessage(
			ctx.text,
			{
				llm: deps.llm,
				...(deps.appMetadata !== undefined ? { appMetadata: deps.appMetadata } : {}),
				logger: deps.logger,
			},
			recentContextSummary || undefined,
		);
		if (classification.pasRelated) {
			// D2b: call DataQueryService when message is a data query candidate
			let dataContext = '';
			if (classification.dataQueryCandidate && deps.dataQuery) {
				try {
					const result =
						recentFilePaths.length > 0
							? await deps.dataQuery.query(ctx.text, ctx.userId, { recentFilePaths })
							: await deps.dataQuery.query(ctx.text, ctx.userId);
					if (!result.empty) {
						dataContext = formatDataQueryContext(result);
					}
				} catch (error) {
					deps.logger.warn('DataQueryService call failed: %s', error);
				}
			}
			systemPrompt = await buildAppAwareSystemPrompt(
				ctx.text,
				ctx.userId,
				contextEntries,
				turns,
				promptDeps,
				modelSlug,
				userCtx,
				dataContext,
			);
		} else {
			systemPrompt = await buildSystemPrompt(contextEntries, turns, promptDeps, modelSlug, userCtx);
		}
	} else {
		systemPrompt = await buildSystemPrompt(contextEntries, turns, promptDeps, modelSlug, userCtx);
	}

	// 6. Call LLM
	let response: string;
	try {
		response = await deps.llm.complete(sanitizeInput(ctx.text), {
			tier: 'standard',
			systemPrompt,
			maxTokens: 2048,
			temperature: 0.7,
		});
	} catch (error) {
		deps.logger.error('Chatbot LLM call failed: %s', error);
		const { userMessage } = classifyLLMError(error);
		await deps.telegram.send(
			ctx.userId,
			`${userMessage}\n\nYour message was saved to daily notes.`,
		);
		return;
	}

	// 7. Extract journal entries and clean response
	const { cleanedResponse: afterJournal, entries: journalEntries } =
		extractJournalEntries(response);
	if (deps.modelJournal) {
		await writeJournalEntries(deps.modelJournal, modelSlug, journalEntries, deps.logger);
	}

	// 8. Strip model-switch tags without executing — admin actions via /ask only
	const finalResponse = afterJournal
		.replace(SWITCH_MODEL_TAG_REGEX, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	// 9. Send response, splitting if over Telegram message limit
	await sendSplitResponse(ctx.userId, finalResponse, {
		telegram: deps.telegram,
		logger: deps.logger,
	});

	// 10. Save conversation history (with cleaned response)
	const now = ctx.timestamp.toISOString();
	const userTurn: ConversationTurn = { role: 'user', content: ctx.text, timestamp: now };
	const assistantTurn: ConversationTurn = {
		role: 'assistant',
		content: finalResponse,
		timestamp: now,
	};

	try {
		await deps.history.append(store, userTurn, assistantTurn);
	} catch (error) {
		deps.logger.warn('Failed to save conversation history: %s', error);
	}
}
