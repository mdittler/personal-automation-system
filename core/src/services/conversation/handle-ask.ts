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
import {
	CONFIG_SET_INSTRUCTION_BLOCK,
	FLUSH_MEMORY_INSTRUCTION_BLOCK,
	MEMORY_FLUSH_INTENT_REGEX,
	MEMORY_KIND_INTENT_REGEX,
	MEMORY_KIND_SET_INSTRUCTION_BLOCK,
	NOTES_INTENT_REGEX,
	normalizeResponse,
	processConfigSetTags,
	processMemoryKindSetTags,
	processModelSwitchTags,
	stripConfigSetTags,
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
import { buildAppAwareSystemPrompt } from './prompt-builder.js';
import { runRecallPipeline } from './recall-pipeline.js';
import { resolveUserBool } from './settings-resolver.js';
import { sendSplitResponse } from './telegram-format.js';
import { buildUserContext } from './user-context.js';

export interface HandleAskDeps {
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
	/** Maximum recall window in days. Default 365. Wired from SystemConfig.chat.recall.max_window_days. */
	recallMaxWindowDays?: number;
	/**
	 * Returns the per-user effective slash-command catalog. When supplied,
	 * forwarded to `buildAppAwareSystemPrompt` for sandboxed catalog injection
	 *.
	 */
	getCommandCatalog?: (
		userId: string,
	) => Promise<import('../router/command-catalog.js').CommandCatalogEntry[]>;
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

	const modelId = deps.llm.getModelForTier?.('standard') ?? 'unknown';
	const modelSlug = slugifyModelId(modelId);
	const sessionKey = resolveOrDefaultSessionKey(ctx);
	const parentSessionId = parentSessionFromIdleReset(ctx.idleResetState);
	const recentEntries = deps.interactionContext?.getRecent(ctx.userId) ?? [];
	const recentContextSummary = formatInteractionContextSummary(recentEntries);
	const recentFilePaths = extractRecentFilePaths(recentEntries);

	// Capture once — used in buildSnapshot callback (P3: avoids type regression from ?.)
	// and reused later for instruction-injection and execution gating.
	const retrieval = deps.conversationRetrieval;

	const [
		{ wrote: noteWrote },
		turns,
		{ sessionId: ensuredSessionId, isNew: sessionIsNew, snapshot: memSnapshot },
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
		buildUserContext(ctx, deps),
	]);

	// ── Recall pipeline (runs before PAS classification) ──────────────────────
	const recalledSessions: SearchHit[] = await runRecallPipeline(question, ensuredSessionId, {
		llm: deps.llm,
		logger: deps.logger,
		conversationRetrieval: deps.conversationRetrieval,
		timezone: deps.timezone,
		maxWindowDays: deps.recallMaxWindowDays ?? 365,
	});

	const askClassification = await classifyPASMessage(
		question,
		deps,
		recentContextSummary || undefined,
	);

	let systemPrompt: string;
	let settingsTrustedInjected = false;
	if (deps.conversationRetrieval) {
		let snapshot: ConversationContextSnapshot | null = null;
		try {
			snapshot = await deps.conversationRetrieval.buildContextSnapshot({
				question,
				mode: 'ask',
				dataQueryCandidate: askClassification.dataQueryCandidate ?? false,
				settingsCandidate: askClassification.settingsCandidate ?? false,
				recentFilePaths,
			});
			if (snapshot?.settingsTrustedInstructions) settingsTrustedInjected = true;
		} catch (error) {
			deps.logger.warn(
				'ConversationRetrievalService.buildContextSnapshot failed in /ask: %s',
				error,
			);
		}
		systemPrompt = await buildAppAwareSystemPrompt(question, ctx.userId, [], turns, deps, {
			modelSlug,
			userCtx,
			dataContextOrSnapshot: snapshot,
			memorySnapshot: memSnapshot,
			recalledSessions,
		});
	} else {
		let askDataContext = '';
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
		systemPrompt = await buildAppAwareSystemPrompt(question, ctx.userId, [], turns, deps, {
			modelSlug,
			userCtx,
			dataContextOrSnapshot: askDataContext,
			memorySnapshot: memSnapshot,
			recalledSessions,
		});
	}

	if (deps.config && !settingsTrustedInjected && NOTES_INTENT_REGEX.test(question)) {
		systemPrompt = `${systemPrompt}\n\n${CONFIG_SET_INSTRUCTION_BLOCK}`;
	}
	if (deps.config && MEMORY_FLUSH_INTENT_REGEX.test(question)) {
		systemPrompt = `${systemPrompt}\n\n${FLUSH_MEMORY_INSTRUCTION_BLOCK}`;
	}
	if (deps.config && SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX.test(question)) {
		systemPrompt = `${systemPrompt}\n\n${SESSION_SEARCH_CONFIG_INSTRUCTION_BLOCK}`;
	}
	if (deps.contextStore && MEMORY_KIND_INTENT_REGEX.test(question)) {
		systemPrompt = `${systemPrompt}\n\n${MEMORY_KIND_SET_INSTRUCTION_BLOCK}`;
	}
	const sessionSearchAllowed =
		deps.config !== undefined &&
		retrieval?.hasSessionSearch() === true &&
		SESSION_SEARCH_TOOL_INTENT_REGEX.test(question) &&
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
		response = await deps.llm.complete(sanitizeInput(question), {
			tier: 'standard',
			systemPrompt,
			maxTokens: 2048,
			temperature: 0.7,
		});
	} catch (error) {
		if (sessionIsNew && ensuredSessionId) {
			await deps.chatSessions
				.endActive({ userId: ctx.userId, sessionKey }, 'system')
				.catch((rollbackErr: unknown) => {
					deps.logger.warn('Failed to roll back empty session after LLM failure: %s', rollbackErr);
				});
		}
		deps.logger.error('Chatbot /ask LLM call failed: %s', error);
		const { userMessage } = classifyLLMError(error);
		const suffix = noteWrote ? '\n\nYour question was saved to your daily notes.' : '';
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
					userMessage: question,
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

	const { cleanedResponse: afterModelSwitch, confirmations: switchConfirmations } =
		await processModelSwitchTags(afterJournal, {
			userId: ctx.userId,
			userMessage: question,
			deps,
		});

	let finalResponse = afterModelSwitch;
	const allConfirmations = [...switchConfirmations];
	if (deps.settingsRegistry && deps.settingsWriter) {
		const { cleanedResponse: afterConfigSet, confirmations: configConfirmations } =
			await processConfigSetTags(afterModelSwitch, {
				userId: ctx.userId,
				userMessage: question,
				settingsRegistry: deps.settingsRegistry,
				settingsWriter: deps.settingsWriter,
				logger: deps.logger,
				disableFlushAndCleanup: deps.disableFlushAndCleanup,
			});
		allConfirmations.push(...configConfirmations);
		finalResponse = afterConfigSet;
	} else {
		// Writer absent — strip config-set tags unconditionally so they don't leak to the user.
		finalResponse = stripConfigSetTags(afterModelSwitch);
	}
	if (deps.contextStore) {
		const { cleanedResponse: afterKindSet, confirmations: kindConfirmations } =
			await processMemoryKindSetTags(finalResponse, {
				userId: ctx.userId,
				userMessage: question,
				contextStore: deps.contextStore,
				logger: deps.logger,
			});
		allConfirmations.push(...kindConfirmations);
		finalResponse = afterKindSet;
	}

	const responseWithConfirmations =
		allConfirmations.length > 0
			? normalizeResponse(`${finalResponse}\n\n${allConfirmations.join('\n')}`)
			: normalizeResponse(finalResponse);

	await sendSplitResponse(ctx.userId, responseWithConfirmations, deps);

	const now = ctx.timestamp.toISOString();
	const userTurn: SessionTurn = {
		role: 'user',
		content: `/ask ${question}`,
		timestamp: now,
		source: 'user',
	};
	const assistantTurn: SessionTurn = {
		role: 'assistant',
		content: responseWithConfirmations,
		timestamp: now,
		source: 'assistant',
	};
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
				userContent: question,
				assistantContent: responseWithConfirmations,
			},
			{
				titleService: deps.titleService,
				llm: deps.llm,
				logger: deps.logger,
			},
		);
	}
}
