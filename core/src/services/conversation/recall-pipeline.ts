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
import { buildUntrustedQuery } from '../chat-transcript-index/fts-query.js';
import type { SearchHit } from '../chat-transcript-index/index.js';
import type { ConversationRetrievalService } from '../conversation-retrieval/index.js';
import {
	classifyRecallIntent,
	recallPreFilter,
} from '../conversation-retrieval/recall-classifier.js';

export interface RecallPipelineDeps {
	llm: LLMService;
	logger: AppLogger;
	conversationRetrieval: ConversationRetrievalService | undefined;
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
		const verdict = await classifyRecallIntent(message, {
			llm: deps.llm,
			logger: deps.logger,
		});
		if (!verdict.shouldRecall || !verdict.query) return [];

		const { terms } = buildUntrustedQuery(verdict.query);
		if (terms.length === 0) return [];

		const result = await retrieval.searchSessions({
			queryTerms: terms,
			limitSessions: 5,
			limitMessagesPerSession: 3,
			excludeSessionIds: activeSessionId ? [activeSessionId] : [],
			startedAfter:
				verdict.timeWindow === 'recent'
					? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
					: undefined,
		});
		return result.hits;
	} catch (err) {
		deps.logger.warn('recall pipeline failed; continuing without recall: %s', err);
		return [];
	}
}
