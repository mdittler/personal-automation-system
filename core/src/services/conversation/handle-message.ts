/**
 * Generic chatbot handleMessage implementation.
 *
 * Fan-out: daily note append, history load, context gather, auto-detect
 * setting, and user context all run in parallel before classification.
 * If auto_detect_pas is on, the LLM classifier chooses between the
 * app-aware prompt and the basic prompt. Otherwise the basic prompt is
 * always used. Model-switch tags are stripped (not executed) — admin
 * model switching requires the explicit /ask path.
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
import type { ChatSessionStore, SessionTurn } from '../conversation-session/chat-session-store.js';
import { resolveOrDefaultSessionKey } from '../conversation-session/session-key.js';
import { getCurrentHouseholdId } from '../context/request-context.js';
import type {
	ConversationContextSnapshot,
	ConversationRetrievalService,
} from '../conversation-retrieval/index.js';
import type { InteractionContextService } from '../interaction-context/index.js';
import {
	extractJournalEntries,
	sanitizeInput,
	writeJournalEntries,
} from '../prompt-assembly/index.js';
import { getAutoDetectSetting } from './auto-detect.js';
import {
	CONFIG_SET_INSTRUCTION_BLOCK,
	NOTES_INTENT_REGEX,
	SWITCH_MODEL_TAG_REGEX,
	normalizeResponse,
	processConfigSetTags,
} from './control-tags.js';
import { appendDailyNote } from './daily-notes.js';
import {
	extractRecentFilePaths,
	formatDataQueryContext,
	formatInteractionContextSummary,
} from './data-query-context.js';
import { CONVERSATION_USER_CONFIG } from './manifest.js';
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
	chatSessions: ChatSessionStore;
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
	/** ConversationRetrievalService — stored here, wired into handlers in Chunk D. */
	conversationRetrieval?: ConversationRetrievalService;
}

export async function handleMessage(ctx: MessageContext, deps: HandleMessageDeps): Promise<void> {
	const modelId = deps.llm.getModelForTier?.('standard') ?? 'unknown';
	const modelSlug = slugifyModelId(modelId);
	const sessionKey = resolveOrDefaultSessionKey(ctx);

	const [{ wrote: noteWrote }, turns, { sessionId: ensuredSessionId, isNew: sessionIsNew, snapshot: memSnapshot }, autoDetect, userCtx] = await Promise.all([
		appendDailyNote(ctx, {
			data: deps.data,
			logger: deps.logger,
			timezone: deps.timezone,
			config: deps.config,
			systemDefault: deps.chatLogToNotesDefault ?? false,
		}),
		deps.chatSessions.loadRecentTurns({ userId: ctx.userId, sessionKey, householdId: getCurrentHouseholdId() }, { maxTurns: 20 }),
		deps.chatSessions.ensureActiveSession(
			{ userId: ctx.userId, sessionKey, model: modelId, householdId: getCurrentHouseholdId() },
			{
				buildSnapshot: deps.conversationRetrieval
					? () => deps.conversationRetrieval!.buildMemorySnapshot()
					: undefined,
			},
		).catch((err: unknown) => {
			deps.logger.warn('ensureActiveSession failed; continuing without session persistence: %s', err);
			return { sessionId: undefined as string | undefined, isNew: false, snapshot: undefined };
		}),
		getAutoDetectSetting(ctx.userId, deps),
		buildUserContext(ctx, deps),
	]);

	let systemPrompt: string;
	if (autoDetect) {
		const recentEntries = deps.interactionContext?.getRecent(ctx.userId) ?? [];
		const recentContextSummary = formatInteractionContextSummary(recentEntries);
		const recentFilePaths = extractRecentFilePaths(recentEntries);

		const classification = await classifyPASMessage(
			ctx.text,
			deps,
			recentContextSummary || undefined,
		);
		if (classification.pasRelated) {
			if (deps.conversationRetrieval) {
				let snapshot: ConversationContextSnapshot | null = null;
				try {
					snapshot = await deps.conversationRetrieval.buildContextSnapshot({
						question: ctx.text,
						mode: 'free-text',
						dataQueryCandidate: classification.dataQueryCandidate ?? false,
						recentFilePaths,
					});
				} catch (error) {
					deps.logger.warn('ConversationRetrievalService.buildContextSnapshot failed: %s', error);
				}
				systemPrompt = await buildAppAwareSystemPrompt(
					ctx.text,
					ctx.userId,
					[],
					turns,
					deps,
					{ modelSlug, userCtx, dataContextOrSnapshot: snapshot, memorySnapshot: memSnapshot },
				);
			} else {
				let dataContext = '';
				if (classification.dataQueryCandidate && deps.dataQuery) {
					try {
						const result = await deps.dataQuery.query(
							ctx.text,
							ctx.userId,
							recentFilePaths.length > 0 ? { recentFilePaths } : undefined,
						);
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
					[],
					turns,
					deps,
					{ modelSlug, userCtx, dataContextOrSnapshot: dataContext, memorySnapshot: memSnapshot },
				);
			}
		} else {
			systemPrompt = await buildSystemPrompt([], turns, deps, { modelSlug, userCtx, memorySnapshot: memSnapshot });
		}
	} else {
		systemPrompt = await buildSystemPrompt([], turns, deps, { modelSlug, userCtx, memorySnapshot: memSnapshot });
	}

	if (deps.config && NOTES_INTENT_REGEX.test(ctx.text)) {
		systemPrompt = `${systemPrompt}\n\n${CONFIG_SET_INSTRUCTION_BLOCK}`;
	}

	let response: string;
	try {
		response = await deps.llm.complete(sanitizeInput(ctx.text), {
			tier: 'standard',
			systemPrompt,
			maxTokens: 2048,
			temperature: 0.7,
		});
	} catch (error) {
		// If we minted a fresh session this turn, end it so it doesn't persist as an empty shell.
		if (sessionIsNew && ensuredSessionId) {
			await deps.chatSessions.endActive(
				{ userId: ctx.userId, sessionKey },
				'system',
			).catch((rollbackErr: unknown) => {
				deps.logger.warn('Failed to roll back empty session after LLM failure: %s', rollbackErr);
			});
		}
		deps.logger.error('Chatbot LLM call failed: %s', error);
		const { userMessage } = classifyLLMError(error);
		const suffix = noteWrote ? '\n\nYour message was saved to daily notes.' : '';
		await deps.telegram.send(ctx.userId, `${userMessage}${suffix}`);
		return;
	}

	const { cleanedResponse: afterJournal, entries: journalEntries } =
		extractJournalEntries(response);
	if (deps.modelJournal) {
		await writeJournalEntries(deps.modelJournal, modelSlug, journalEntries, deps.logger);
	}

	const afterSwitchStrip = afterJournal.replace(SWITCH_MODEL_TAG_REGEX, '');

	let finalResponse: string;
	if (deps.config) {
		const { cleanedResponse: afterConfigSet, confirmations } = await processConfigSetTags(
			afterSwitchStrip,
			{
				userId: ctx.userId,
				userMessage: ctx.text,
				config: deps.config,
				manifest: CONVERSATION_USER_CONFIG,
				logger: deps.logger,
			},
		);
		finalResponse =
			confirmations.length > 0
				? normalizeResponse(`${afterConfigSet}\n\n${confirmations.join('\n')}`)
				: normalizeResponse(afterConfigSet);
	} else {
		finalResponse = normalizeResponse(afterSwitchStrip);
	}

	await sendSplitResponse(ctx.userId, finalResponse, deps);

	const now = ctx.timestamp.toISOString();
	const userTurn: SessionTurn = { role: 'user', content: ctx.text, timestamp: now };
	const assistantTurn: SessionTurn = { role: 'assistant', content: finalResponse, timestamp: now };

	try {
		await deps.chatSessions.appendExchange(
			{
				userId: ctx.userId,
				sessionKey,
				model: modelId,
				householdId: getCurrentHouseholdId(),
				expectedSessionId: ensuredSessionId,
			},
			userTurn,
			assistantTurn,
		);
	} catch (error) {
		deps.logger.warn('Failed to save conversation history: %s', error);
	}
}
