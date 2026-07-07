/**
 * Conversations browser (Batch 6, Task 6.1).
 *
 * Read-only view of a user's own chat transcripts (implements open item D2:
 * "Non-admins see only their own sessions"). Own-sessions-ONLY for EVERY
 * authenticated user, including platform admins — chat transcripts are
 * personal, so this deliberately does not grant admins cross-user read
 * access. If that's wanted later, it's a separate, explicit decision (see
 * docs/open-items.md).
 *
 * Registered only when a ChatTranscriptIndex is present (core/src/gui/index.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ChatTranscriptIndex } from '../../services/chat-transcript-index/chat-transcript-index.js';
import { buildUntrustedQuery } from '../../services/chat-transcript-index/fts-query.js';

export interface SessionsRoutesOptions {
	chatTranscriptIndex: Pick<
		ChatTranscriptIndex,
		'listSessionsForUser' | 'listMessagesForSession' | 'searchSessions'
	>;
	logger: Logger;
}

const DEFAULT_LIMIT = 20;

export function registerSessionsRoutes(
	server: FastifyInstance,
	options: SessionsRoutesOptions,
): void {
	const { chatTranscriptIndex } = options;

	// --- List / search ---
	server.get('/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.user;
		if (!actor) {
			return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
		}

		const query = request.query as { q?: string; limit?: string; offset?: string };
		const limit = clampInt(query.limit, DEFAULT_LIMIT, 1, 100);
		const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
		const rawQuery = (query.q ?? '').trim();

		if (rawQuery) {
			const { terms } = buildUntrustedQuery(rawQuery);
			const result =
				terms.length > 0
					? await chatTranscriptIndex.searchSessions({
							userId: actor.userId,
							householdId: actor.householdId,
							queryTerms: terms,
							limitSessions: limit,
						})
					: { hits: [] };

			return reply.viewAsync('sessions', {
				title: 'Conversations — PAS',
				activePage: 'sessions',
				searchQuery: rawQuery,
				isSearch: true,
				sessions: result.hits.map((hit) => ({
					id: hit.sessionId,
					title: hit.title || 'Untitled conversation',
					startedAt: hit.sessionStartedAt,
					snippet: hit.matches[0]?.snippet ?? '',
				})),
			});
		}

		const sessions = await chatTranscriptIndex.listSessionsForUser({
			userId: actor.userId,
			limit,
			offset,
		});

		return reply.viewAsync('sessions', {
			title: 'Conversations — PAS',
			activePage: 'sessions',
			searchQuery: '',
			isSearch: false,
			sessions: sessions.map((s) => ({
				id: s.id,
				title: s.title || 'Untitled conversation',
				startedAt: s.startedAt,
				messageCount: s.messageCount,
			})),
			limit,
			offset,
			hasMore: sessions.length === limit,
		});
	});

	// --- Detail ---
	server.get(
		'/sessions/:sessionId',
		async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
			const actor = request.user;
			if (!actor) {
				return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
			}

			const { sessionId } = request.params;

			// List the user's own sessions to confirm ownership before fetching
			// messages — avoids leaking existence of another user's session via
			// a different 404 shape (searchSessions/listMessagesForSession alone
			// don't verify ownership).
			const ownSessions = await chatTranscriptIndex.listSessionsForUser({
				userId: actor.userId,
				limit: 10000,
				offset: 0,
			});
			const owned = ownSessions.find((s) => s.id === sessionId);
			if (!owned) {
				return reply.status(404).viewAsync('403', {
					title: 'Not Found — PAS',
					message: 'Conversation not found.',
				});
			}

			const messages = await chatTranscriptIndex.listMessagesForSession(sessionId);

			return reply.viewAsync('session-detail', {
				title: `${owned.title || 'Conversation'} — PAS`,
				activePage: 'sessions',
				session: {
					id: owned.id,
					title: owned.title || 'Untitled conversation',
					startedAt: owned.startedAt,
				},
				messages,
			});
		},
	);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (Number.isNaN(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
