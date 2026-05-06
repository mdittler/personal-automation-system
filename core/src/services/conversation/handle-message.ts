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
import { buildUntrustedQuery } from '../chat-transcript-index/index.js';
import type { SearchHit } from '../chat-transcript-index/index.js';
import { getCurrentHouseholdId } from '../context/request-context.js';
import type {
	ConversationContextSnapshot,
	ConversationRetrievalService,
} from '../conversation-retrieval/index.js';
import type { ChatSessionStore, SessionTurn } from '../conversation-session/chat-session-store.js';
import { parentSessionFromIdleReset } from '../conversation-session/parent-session-from-idle-reset.js';
import { resolveOrDefaultSessionKey } from '../conversation-session/session-key.js';
import { scheduleTitleAfterFirstExchange } from '../conversation-titling/auto-title-hook.js';
import type { TitleService } from '../conversation-titling/title-service.js';
import type { InteractionContextService } from '../interaction-context/index.js';
import {
	extractJournalEntries,
	sanitizeInput,
	writeJournalEntries,
} from '../prompt-assembly/index.js';
import type { SettingsRegistry } from '../settings/settings-registry.js';
import type { SettingsWriter } from '../settings/settings-writer.js';
import { getAutoDetectSetting } from './auto-detect.js';
import {
	CONFIG_SET_INSTRUCTION_BLOCK,
	FLUSH_MEMORY_INSTRUCTION_BLOCK,
	MEMORY_FLUSH_INTENT_REGEX,
	MEMORY_KIND_INTENT_REGEX,
	MEMORY_KIND_SET_INSTRUCTION_BLOCK,
	NOTES_INTENT_REGEX,
	SWITCH_MODEL_TAG_REGEX,
	normalizeResponse,
	processConfigSetTags,
	processMemoryKindSetTags,
} from './control-tags.js';
import {
	SESSION_SEARCH_CONFIG_INSTRUCTION_BLOCK,
	SESSION_SEARCH_INSTRUCTION_BLOCK,
	SESSION_SEARCH_TOOL_INTENT_REGEX,
	SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX,
} from './control-tags/session-search-instruction.js';
import {
	extractSessionSearchTag,
	stripSessionSearchTags,
} from './control-tags/session-search-tag.js';
import { appendDailyNote } from './daily-notes.js';
import {
	extractRecentFilePaths,
	formatDataQueryContext,
	formatInteractionContextSummary,
} from './data-query-context.js';
import { classifyPASMessage } from './pas-classifier.js';
import { buildToolContinuationPrompt } from './prompt-assembly/tool-continuation-prompt.js';
import { buildAppAwareSystemPrompt, buildSystemPrompt } from './prompt-builder.js';
import { runRecallPipeline } from './recall-pipeline.js';
import { resolveUserBool } from './settings-resolver.js';
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
	/** TitleService — when present, auto-title fires after first exchange. */
	titleService?: TitleService;
	/** Called when flush_memory_on_idle_reset is turned OFF via <config-set> tag. */
	disableFlushAndCleanup?: (userId: string) => Promise<void>;
	/** SettingsRegistry — when present, enables <config-set> tag processing via registry allowlist. */
	settingsRegistry?: SettingsRegistry;
	/** SettingsWriter — when present, routes <config-set> writes through registry-aware writer. */
	settingsWriter?: SettingsWriter;
}

export async function handleMessage(ctx: MessageContext, deps: HandleMessageDeps): Promise<void> {
	const modelId = deps.llm.getModelForTier?.('standard') ?? 'unknown';
	const modelSlug = slugifyModelId(modelId);
	const sessionKey = resolveOrDefaultSessionKey(ctx);

	// Capture once — used in buildSnapshot callback (P3: avoids type regression from ?.)
	// and reused later for instruction-injection and execution gating.
	const retrieval = deps.conversationRetrieval;
	const parentSessionId = parentSessionFromIdleReset(ctx.idleResetState);
	const [
		{ wrote: noteWrote },
		turns,
		{ sessionId: ensuredSessionId, isNew: sessionIsNew, snapshot: memSnapshot },
		autoDetect,
		userCtx,
	] = await Promise.all([
		appendDailyNote(ctx, {
			data: deps.data,
			logger: deps.logger,
			timezone: deps.timezone,
			config: deps.config,
			systemDefault: deps.chatLogToNotesDefault ?? false,
		}),
		deps.chatSessions.loadRecentTurns(
			{ userId: ctx.userId, sessionKey, householdId: getCurrentHouseholdId() },
			{ maxTurns: 20 },
		),
		deps.chatSessions
			.ensureActiveSession(
				{
					userId: ctx.userId,
					sessionKey,
					model: modelId,
					householdId: getCurrentHouseholdId(),
					...(parentSessionId !== null ? { parentSessionId } : {}),
				},
				{
					buildSnapshot: retrieval
						? async () => {
								const flushEnabled = deps.config
									? await resolveUserBool(
											deps.config,
											ctx.userId,
											'flush_memory_on_idle_reset',
											false,
											deps.logger,
										)
									: false;
								return retrieval.buildMemorySnapshot(flushEnabled ? {} : { pinnedKeys: [] });
							}
						: undefined,
				},
			)
			.catch((err: unknown) => {
				deps.logger.warn(
					'ensureActiveSession failed; continuing without session persistence: %s',
					err,
				);
				return { sessionId: undefined as string | undefined, isNew: false, snapshot: undefined };
			}),
		getAutoDetectSetting(ctx.userId, deps),
		buildUserContext(ctx, deps),
	]);

	// ── Recall pipeline (runs before PAS classification) ──────────────────────
	const recalledSessions: SearchHit[] = await runRecallPipeline(ctx.text, ensuredSessionId, {
		llm: deps.llm,
		logger: deps.logger,
		conversationRetrieval: deps.conversationRetrieval,
		timezone: deps.timezone,
	});

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
				systemPrompt = await buildAppAwareSystemPrompt(ctx.text, ctx.userId, [], turns, deps, {
					modelSlug,
					userCtx,
					dataContextOrSnapshot: snapshot,
					memorySnapshot: memSnapshot,
					recalledSessions,
				});
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
				systemPrompt = await buildAppAwareSystemPrompt(ctx.text, ctx.userId, [], turns, deps, {
					modelSlug,
					userCtx,
					dataContextOrSnapshot: dataContext,
					memorySnapshot: memSnapshot,
					recalledSessions,
				});
			}
		} else {
			systemPrompt = await buildSystemPrompt([], turns, deps, {
				modelSlug,
				userCtx,
				memorySnapshot: memSnapshot,
				recalledSessions,
			});
		}
	} else {
		systemPrompt = await buildSystemPrompt([], turns, deps, {
			modelSlug,
			userCtx,
			memorySnapshot: memSnapshot,
			recalledSessions,
		});
	}

	if (deps.config && NOTES_INTENT_REGEX.test(ctx.text)) {
		systemPrompt = `${systemPrompt}\n\n${CONFIG_SET_INSTRUCTION_BLOCK}`;
	}
	if (deps.config && MEMORY_FLUSH_INTENT_REGEX.test(ctx.text)) {
		systemPrompt = `${systemPrompt}\n\n${FLUSH_MEMORY_INSTRUCTION_BLOCK}`;
	}
	if (deps.config && SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX.test(ctx.text)) {
		systemPrompt = `${systemPrompt}\n\n${SESSION_SEARCH_CONFIG_INSTRUCTION_BLOCK}`;
	}
	if (deps.contextStore && MEMORY_KIND_INTENT_REGEX.test(ctx.text)) {
		systemPrompt = `${systemPrompt}\n\n${MEMORY_KIND_SET_INSTRUCTION_BLOCK}`;
	}
	const sessionSearchAllowed =
		deps.config !== undefined &&
		retrieval?.hasSessionSearch() === true &&
		SESSION_SEARCH_TOOL_INTENT_REGEX.test(ctx.text) &&
		(await resolveUserBool(
			deps.config,
			ctx.userId,
			'session_search_tool_enabled',
			true,
			deps.logger,
		));
	if (sessionSearchAllowed) {
		systemPrompt = `${systemPrompt}\n\n${SESSION_SEARCH_INSTRUCTION_BLOCK}`;
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
			await deps.chatSessions
				.endActive({ userId: ctx.userId, sessionKey }, 'system')
				.catch((rollbackErr: unknown) => {
					deps.logger.warn('Failed to roll back empty session after LLM failure: %s', rollbackErr);
				});
		}
		deps.logger.error('Chatbot LLM call failed: %s', error);
		const { userMessage } = classifyLLMError(error);
		const suffix = noteWrote ? '\n\nYour message was saved to daily notes.' : '';
		await deps.telegram.send(ctx.userId, `${userMessage}${suffix}`);
		return;
	}

	// ── Session-search pseudo-tool re-prompt driver ───────────────────────────
	// Runs before journal/switch-model/config-set so the second response flows
	// through the full existing post-processing chain.
	let workingResponse = response;
	const {
		query: toolQuery,
		after: toolAfter,
		before: toolBefore,
		beforeTag,
	} = extractSessionSearchTag(workingResponse);
	if (toolQuery !== null && sessionSearchAllowed && retrieval) {
		try {
			const queryTerms = buildUntrustedQuery(toolQuery).terms;
			if (queryTerms.length > 0) {
				// Convert after/before date attrs to UTC message-timestamp filter bounds
				const tz = deps.timezone ?? 'UTC';
				const { localDayToUtcRange } = await import('../../utils/temporal.js');
				const messageAfter = toolAfter ? localDayToUtcRange(toolAfter, tz).startUtc : undefined;
				const messageBefore = toolBefore
					? localDayToUtcRange(toolBefore, tz).endUtcExclusive
					: undefined;
				const search = await retrieval.searchSessions({
					queryTerms,
					limitSessions: 5,
					limitMessagesPerSession: 3,
					excludeSessionIds: ensuredSessionId ? [ensuredSessionId] : [],
					messageAfter,
					messageBefore,
				});
				const continuationPrompt = buildToolContinuationPrompt({
					userMessage: ctx.text,
					assistantPreTag: beforeTag,
					toolQuery,
					toolResult: search.hits,
					toolAfter,
					toolBefore,
				});
				const second = await deps.llm.complete(continuationPrompt, {
					tier: 'standard',
					systemPrompt,
					maxTokens: 2048,
					temperature: 0.7,
				});
				workingResponse = second;
			} else {
				workingResponse =
					beforeTag.trim() || 'I was unable to search past conversations. Please try again.';
			}
		} catch (err) {
			deps.logger.warn('session-search tool loop failed, falling back to first response: %s', err);
			workingResponse =
				beforeTag.trim() || 'I was unable to search past conversations. Please try again.';
		}
	} else {
		workingResponse = stripSessionSearchTags(workingResponse);
	}
	// Final strip — removes any straggler tag emitted by the second response (recursion cap).
	workingResponse = stripSessionSearchTags(workingResponse);

	const { cleanedResponse: afterJournal, entries: journalEntries } =
		extractJournalEntries(workingResponse);
	if (deps.modelJournal) {
		await writeJournalEntries(deps.modelJournal, modelSlug, journalEntries, deps.logger);
	}

	const afterSwitchStrip = afterJournal.replace(SWITCH_MODEL_TAG_REGEX, '');

	let finalResponse: string;
	const allConfirmations: string[] = [];
	if (deps.settingsRegistry && deps.settingsWriter) {
		const { cleanedResponse: afterConfigSet, confirmations: configConfirmations } =
			await processConfigSetTags(afterSwitchStrip, {
				userId: ctx.userId,
				userMessage: ctx.text,
				settingsRegistry: deps.settingsRegistry,
				settingsWriter: deps.settingsWriter,
				logger: deps.logger,
				disableFlushAndCleanup: deps.disableFlushAndCleanup,
			});
		allConfirmations.push(...configConfirmations);
		if (deps.contextStore) {
			const { cleanedResponse: afterKindSet, confirmations: kindConfirmations } =
				await processMemoryKindSetTags(afterConfigSet, {
					userId: ctx.userId,
					userMessage: ctx.text,
					contextStore: deps.contextStore,
					logger: deps.logger,
				});
			allConfirmations.push(...kindConfirmations);
			finalResponse = afterKindSet;
		} else {
			finalResponse = afterConfigSet;
		}
	} else if (deps.contextStore) {
		const { cleanedResponse: afterKindSet, confirmations: kindConfirmations } =
			await processMemoryKindSetTags(afterSwitchStrip, {
				userId: ctx.userId,
				userMessage: ctx.text,
				contextStore: deps.contextStore,
				logger: deps.logger,
			});
		allConfirmations.push(...kindConfirmations);
		finalResponse = afterKindSet;
	} else {
		finalResponse = normalizeResponse(afterSwitchStrip);
	}

	if (allConfirmations.length > 0) {
		finalResponse = normalizeResponse(`${finalResponse}\n\n${allConfirmations.join('\n')}`);
	}

	await sendSplitResponse(ctx.userId, finalResponse, deps);

	const now = ctx.timestamp.toISOString();
	const userTurn: SessionTurn = { role: 'user', content: ctx.text, timestamp: now };
	const assistantTurn: SessionTurn = { role: 'assistant', content: finalResponse, timestamp: now };

	let appendSucceeded = false;
	try {
		await deps.chatSessions.appendExchange(
			{
				userId: ctx.userId,
				sessionKey,
				model: modelId,
				householdId: getCurrentHouseholdId(),
				expectedSessionId: ensuredSessionId,
				...(parentSessionId !== null ? { parentSessionId } : {}),
			},
			userTurn,
			assistantTurn,
		);
		appendSucceeded = true;
	} catch (error) {
		deps.logger.warn('Failed to save conversation history: %s', error);
	}

	if (
		appendSucceeded &&
		deps.titleService &&
		sessionIsNew &&
		turns.length === 0 &&
		ensuredSessionId
	) {
		scheduleTitleAfterFirstExchange(
			{
				userId: ctx.userId,
				sessionId: ensuredSessionId,
				userContent: ctx.text,
				assistantContent: finalResponse,
			},
			{
				titleService: deps.titleService,
				llm: deps.llm,
				logger: deps.logger,
			},
		);
	}
}
