/**
 * /recall slash command handler — user-facing transcript search.
 *
 * Calls ConversationRetrievalService.searchSessions (which derives userId
 * from requestContext — auth boundary enforced by the service layer).
 * Does NOT pass excludeSessionIds: the user's active session is intentionally
 * searchable from /recall (explicit user intent). The pseudo-tool path excludes
 * the active session instead.
 *
 * REQ-CONV-RECALL-001..009
 */

import type { AppLogger } from '../../types/app-module.js';
import type { MessageContext, TelegramService } from '../../types/telegram.js';
import { buildUntrustedQuery } from '../chat-transcript-index/index.js';
import type { ConversationRetrievalService } from '../conversation-retrieval/conversation-retrieval-service.js';
import { formatRecallReply } from './prompt-assembly/recall-reply.js';
import { sendSplitResponse } from './telegram-format.js';

export interface HandleRecallDeps {
	conversationRetrieval: ConversationRetrievalService | undefined;
	telegram: TelegramService;
	logger: AppLogger;
}

export async function handleRecall(
	args: string[],
	ctx: MessageContext,
	deps: HandleRecallDeps,
): Promise<void> {
	const query = args.join(' ').trim();

	if (!query) {
		await deps.telegram.send(ctx.userId, 'Usage: /recall <query>');
		return;
	}

	if (!deps.conversationRetrieval || !deps.conversationRetrieval.hasSessionSearch()) {
		await deps.telegram.send(ctx.userId, 'Search is not available.');
		return;
	}

	const { terms: queryTerms } = buildUntrustedQuery(query);

	if (queryTerms.length === 0) {
		await deps.telegram.send(ctx.userId, 'No searchable terms in your query.');
		return;
	}

	try {
		const result = await deps.conversationRetrieval.searchSessions({
			queryTerms,
			limitSessions: 5,
			limitMessagesPerSession: 3,
		});

		if (result.hits.length === 0) {
			const escapedQuery = query.replace(/[*_`[\]()]/g, (m) => `\\${m}`);
			await deps.telegram.send(ctx.userId, `No past conversations matched "${escapedQuery}".`);
			return;
		}

		const reply = formatRecallReply(result.hits, queryTerms);
		await sendSplitResponse(ctx.userId, reply, deps);
	} catch (error) {
		deps.logger.warn('handleRecall: searchSessions failed: %s', error);
		await deps.telegram.send(ctx.userId, 'Search failed. Try again later.');
	}
}
