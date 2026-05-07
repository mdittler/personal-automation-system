/**
 * Shared recall pipeline for handleMessage and handleAsk.
 *
 * Runs a two-stage recall gate:
 *   1. recallPreFilter  — cheap regex/heuristic guard (skips most turns)
 *   2. classifyRecallIntent — fast-tier LLM classifier
 * Then issues a searchSessions call and returns the hits.
 */

import type { AppLogger } from '../../types/app-module.js';
import type { LLMService } from '../../types/llm.js';
import { localDayToUtcRange } from '../../utils/temporal.js';
import { buildUntrustedQuery } from '../chat-transcript-index/fts-query.js';
import type { SearchHit } from '../chat-transcript-index/index.js';
import type { ConversationRetrievalService } from '../conversation-retrieval/index.js';
import {
	classifyRecallIntent,
	recallPreFilter,
} from '../conversation-retrieval/recall-classifier.js';
import type { TimeAnchor } from '../conversation-retrieval/recall-classifier.js';

/**
 * Translate a validated TimeAnchor into UTC message-timestamp filter bounds.
 *
 * - null anchor → no filter (empty object)
 * - absolute anchor → exact day in the given timezone
 * - window anchor → open-ended or bounded interval
 *
 * @param anchor  Validated TimeAnchor from parseRecallVerdict
 * @param tz      IANA timezone string (e.g. 'America/New_York', 'UTC')
 */
export function timeAnchorToFilters(
	anchor: TimeAnchor,
	tz: string,
): { messageAfter?: string; messageBefore?: string } {
	if (!anchor) return {};

	if (anchor.type === 'absolute') {
		const { startUtc, endUtcExclusive } = localDayToUtcRange(anchor.on, tz);
		return { messageAfter: startUtc, messageBefore: endUtcExclusive };
	}

	// window
	return {
		messageAfter: anchor.after ? localDayToUtcRange(anchor.after, tz).startUtc : undefined,
		messageBefore: anchor.before
			? localDayToUtcRange(anchor.before, tz).endUtcExclusive
			: undefined,
	};
}

export interface RecallPipelineDeps {
	llm: LLMService;
	logger: AppLogger;
	conversationRetrieval: ConversationRetrievalService | undefined;
	/** IANA timezone; used to compute today's local date for the classifier. Default: system. */
	timezone?: string;
	/** Maximum allowed temporal-window age/span in days. Default 365. REQ-CONV-TEMPORAL-013. */
	maxWindowDays?: number;
}

/**
 * Run the full recall pipeline for the given message.
 *
 * Returns an empty array if:
 *   - no ConversationRetrievalService is wired, or it has no session search index
 *   - the pre-filter heuristic decides to skip
 *   - the LLM classifier says no recall is needed
 *   - the query produces no usable FTS terms
 *   - any step throws (errors are logged and swallowed)
 */
export async function runRecallPipeline(
	message: string,
	activeSessionId: string | undefined,
	deps: RecallPipelineDeps,
): Promise<SearchHit[]> {
	const retrieval = deps.conversationRetrieval;
	if (!retrieval?.hasSessionSearch()) return [];

	const preFilter = recallPreFilter(message);
	if (preFilter.skip) return [];

	try {
		// Compute today's local date (YYYY-MM-DD) for the classifier prompt.
		const today = new Intl.DateTimeFormat('en-CA', {
			timeZone: deps.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		}).format(new Date());

		const verdict = await classifyRecallIntent(message, {
			llm: deps.llm,
			logger: deps.logger,
			today,
			maxWindowDays: deps.maxWindowDays ?? 365,
		});
		if (!verdict.shouldRecall || !verdict.query) return [];

		const { terms } = buildUntrustedQuery(verdict.query);
		if (terms.length === 0) return [];

		const tz = deps.timezone ?? 'UTC';
		const { messageAfter, messageBefore } = timeAnchorToFilters(verdict.timeAnchor, tz);

		const result = await retrieval.searchSessions({
			queryTerms: terms,
			limitSessions: 5,
			limitMessagesPerSession: 3,
			messageAfter,
			messageBefore,
			excludeSessionIds: activeSessionId ? [activeSessionId] : [],
		});
		return result.hits;
	} catch (err) {
		deps.logger.warn('recall pipeline failed; continuing without recall: %s', err);
		return [];
	}
}
