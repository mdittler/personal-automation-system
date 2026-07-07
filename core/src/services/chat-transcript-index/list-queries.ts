/**
 * Additive read-only list/count queries on top of the chat transcript index.
 *
 * These exist for the GUI Conversations browser (Batch 6) and the metrics
 * endpoints that power Home's activity chart (Batch 2). They are pure,
 * synchronous prepared-statement helpers over a `better-sqlite3` Database —
 * ChatTranscriptIndexImpl delegates to them using its own `db` handle.
 *
 * Additive only: no existing ChatTranscriptIndex method signature changes.
 */
import type Database from 'better-sqlite3';

export interface SessionListItem {
	id: string;
	title: string | null;
	startedAt: string;
	endedAt: string | null;
	messageCount: number;
}

export interface ListSessionsForUserOpts {
	userId: string;
	limit?: number;
	offset?: number;
}

export interface TranscriptMessage {
	role: 'user' | 'assistant';
	text: string;
	timestamp: string;
}

export interface CountMessagesByDayOpts {
	/** When omitted, counts across all users (admin path). */
	userId?: string;
	/** ISO8601 inclusive lower bound on message timestamp. */
	sinceIso: string;
}

export interface DailyMessageCount {
	date: string; // YYYY-MM-DD
	count: number;
}

/**
 * List sessions for a single user, most recent first, with a per-session
 * message count. Read-only — never crosses the user boundary.
 */
export function listSessionsForUser(
	db: Database.Database,
	opts: ListSessionsForUserOpts,
): SessionListItem[] {
	const limit = opts.limit ?? 20;
	const offset = opts.offset ?? 0;
	const rows = db
		.prepare(
			`SELECT
        s.id AS id,
        s.title AS title,
        s.started_at AS startedAt,
        s.ended_at AS endedAt,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
      FROM sessions s
      WHERE s.user_id = ?
      ORDER BY s.started_at DESC
      LIMIT ? OFFSET ?`,
		)
		.all(opts.userId, limit, offset) as SessionListItem[];
	return rows;
}

/**
 * List all messages for a single session, oldest first. Read-only.
 */
export function listMessagesForSession(
	db: Database.Database,
	sessionId: string,
): TranscriptMessage[] {
	const rows = db
		.prepare(
			`SELECT role AS role, content AS text, timestamp AS timestamp
       FROM messages
       WHERE session_id = ?
       ORDER BY timestamp ASC, turn_index ASC`,
		)
		.all(sessionId) as TranscriptMessage[];
	return rows;
}

/**
 * Count messages per calendar day (UTC, YYYY-MM-DD) since a given timestamp,
 * optionally scoped to a single user. Omitting `userId` aggregates across all
 * users (admin path only — callers must gate this on isPlatformAdmin).
 */
export function countMessagesByDay(
	db: Database.Database,
	opts: CountMessagesByDayOpts,
): DailyMessageCount[] {
	const params: unknown[] = [opts.sinceIso];
	let userFilter = '';
	if (opts.userId) {
		userFilter = 'AND m.session_id IN (SELECT id FROM sessions WHERE user_id = ?)';
		params.push(opts.userId);
	}
	const rows = db
		.prepare(
			`SELECT substr(m.timestamp, 1, 10) AS date, COUNT(*) AS count
       FROM messages m
       WHERE m.timestamp >= ? ${userFilter}
       GROUP BY date
       ORDER BY date ASC`,
		)
		.all(...params) as DailyMessageCount[];
	return rows;
}
