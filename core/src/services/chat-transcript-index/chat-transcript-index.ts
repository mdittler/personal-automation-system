import Database from 'better-sqlite3';
import { buildMatchClause } from './fts-query.js';
import { withSqliteRetry } from './retry.js';
import { applyMigrations } from './schema.js';
import type {
	InternalSearchFilters,
	MatchRow,
	MessageRow,
	SearchHit,
	SearchResult,
	SessionRow,
} from './types.js';

export interface ChatTranscriptIndex {
	upsertSession(row: SessionRow): Promise<void>;
	appendMessage(row: MessageRow): Promise<void>;
	endSession(sessionId: string, endedAt: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	searchSessions(filters: InternalSearchFilters): Promise<SearchResult>;
	getSessionMeta(sessionId: string): Promise<SessionRow | undefined>;
	listExpiredSessions(cutoffIso: string): Promise<Array<{ id: string; user_id: string }>>;
	/** @internal Test helper — returns the number of messages rows for the given session. */
	getMessageCount(sessionId: string): Promise<number>;
	close(): Promise<void>;
}

interface FtsRow {
	session_id: string;
	turn_index: number;
	role: 'user' | 'assistant';
	timestamp: string;
	snippet: string;
	bm25: number;
	started_at: string;
	ended_at: string | null;
	title: string | null;
}

export class ChatTranscriptIndexImpl implements ChatTranscriptIndex {
	private db: Database.Database;
	private writeCount = 0;
	private readonly WAL_CHECKPOINT_INTERVAL = 50;
	private closed = false;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		applyMigrations(this.db);
	}

	private maybeCheckpoint(): void {
		this.writeCount++;
		if (this.writeCount % this.WAL_CHECKPOINT_INTERVAL === 0) {
			this.db.pragma('wal_checkpoint(PASSIVE)');
		}
	}

	async upsertSession(row: SessionRow): Promise<void> {
		await withSqliteRetry(() => {
			const txn = this.db.transaction(() => {
				this.db
					.prepare(
						`INSERT OR REPLACE INTO sessions(id, user_id, household_id, source, started_at, ended_at, model, title)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						row.id,
						row.user_id,
						row.household_id ?? null,
						row.source,
						row.started_at,
						row.ended_at ?? null,
						row.model ?? null,
						row.title ?? null,
					);
			});
			txn();
		});
		this.maybeCheckpoint();
	}

	async appendMessage(row: MessageRow): Promise<void> {
		await withSqliteRetry(() => {
			const txn = this.db.transaction(() => {
				this.db
					.prepare(
						`INSERT OR IGNORE INTO messages(session_id, turn_index, role, content, timestamp)
             VALUES (?, ?, ?, ?, ?)`,
					)
					.run(row.session_id, row.turn_index, row.role, row.content, row.timestamp);
			});
			txn();
		});
		this.maybeCheckpoint();
	}

	async endSession(sessionId: string, endedAt: string): Promise<void> {
		await withSqliteRetry(() => {
			const txn = this.db.transaction(() => {
				this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId);
			});
			txn();
		});
		this.maybeCheckpoint();
	}

	async deleteSession(sessionId: string): Promise<void> {
		await withSqliteRetry(() => {
			const txn = this.db.transaction(() => {
				// Explicitly delete messages first so the messages_ad trigger fires per-row,
				// cleaning up messages_fts before the parent session row is removed.
				// ON DELETE CASCADE alone does NOT fire row-level AFTER DELETE triggers on the
				// child table in SQLite, so orphaned FTS rows would otherwise be left behind.
				this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
				this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
			});
			txn();
		});
		this.maybeCheckpoint();
	}

	async searchSessions(filters: InternalSearchFilters): Promise<SearchResult> {
		if (!filters.queryTerms || filters.queryTerms.length === 0) {
			return { hits: [] };
		}

		const limitSessions = filters.limitSessions ?? 5;
		const limitMessagesPerSession = filters.limitMessagesPerSession ?? 3;
		// Over-fetch to allow grouping + capping
		const fetchLimit = limitSessions * limitMessagesPerSession * 4;

		const matchClause = buildMatchClause(filters.queryTerms);

		const conditions: string[] = ['messages_fts MATCH ?', 'm.user_id = ?'];
		const params: unknown[] = [matchClause, filters.userId];

		if (filters.startedAfter) {
			conditions.push('s.started_at >= ?');
			params.push(filters.startedAfter);
		}
		if (filters.startedBefore) {
			conditions.push('s.started_at < ?');
			params.push(filters.startedBefore);
		}
		if (filters.excludeSessionIds && filters.excludeSessionIds.length > 0) {
			const placeholders = filters.excludeSessionIds.map(() => '?').join(', ');
			conditions.push(`s.id NOT IN (${placeholders})`);
			params.push(...filters.excludeSessionIds);
		}

		params.push(fetchLimit);

		const sql = `
      SELECT
        m.session_id,
        m.turn_index,
        m.role,
        m.timestamp,
        snippet(messages_fts, 0, '[', ']', '...', 10) AS snippet,
        bm25(messages_fts) AS bm25,
        s.started_at,
        s.ended_at,
        s.title
      FROM messages_fts m
      JOIN sessions s ON s.id = m.session_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY bm25 ASC, m.session_id ASC, m.turn_index ASC
      LIMIT ?
    `;

		const rows = this.db.prepare(sql).all(...params) as FtsRow[];

		// Group rows by session_id
		const sessionMap = new Map<
			string,
			{ rows: FtsRow[]; started_at: string; ended_at: string | null; title: string | null }
		>();

		for (const row of rows) {
			const entry = sessionMap.get(row.session_id);
			if (entry) {
				entry.rows.push(row);
			} else {
				sessionMap.set(row.session_id, {
					rows: [row],
					started_at: row.started_at,
					ended_at: row.ended_at,
					title: row.title,
				});
			}
		}

		// For each session: keep top limitMessagesPerSession rows, compute minBm25
		type SessionAccum = {
			sessionId: string;
			started_at: string;
			ended_at: string | null;
			title: string | null;
			minBm25: number;
			matches: MatchRow[];
		};

		const sessions: SessionAccum[] = [];

		for (const [sessionId, { rows: sessionRows, started_at, ended_at, title }] of sessionMap) {
			// rows already sorted by bm25 ASC, turn_index ASC from the SQL query
			const topRows = sessionRows.slice(0, limitMessagesPerSession);
			if (topRows.length === 0) continue;
			const minBm25 = topRows.reduce((min, r) => (r.bm25 < min ? r.bm25 : min), topRows[0]?.bm25);
			const matches: MatchRow[] = topRows.map((r) => ({
				turn_index: r.turn_index,
				role: r.role,
				timestamp: r.timestamp,
				snippet: r.snippet,
				bm25: r.bm25,
			}));
			sessions.push({ sessionId, started_at, ended_at, title, minBm25, matches });
		}

		// Order sessions: minBm25 ASC, sessionStartedAt DESC, sessionId ASC
		sessions.sort((a, b) => {
			if (a.minBm25 !== b.minBm25) return a.minBm25 - b.minBm25;
			// started_at DESC: more recent first
			if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
			// sessionId ASC as final tiebreak
			return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
		});

		const capped = sessions.slice(0, limitSessions);

		const hits: SearchHit[] = capped.map((s) => ({
			sessionId: s.sessionId,
			sessionStartedAt: s.started_at,
			sessionEndedAt: s.ended_at,
			title: s.title,
			matches: s.matches,
		}));

		return { hits };
	}

	async getSessionMeta(sessionId: string): Promise<SessionRow | undefined> {
		const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
			| SessionRow
			| undefined;
		return row;
	}

	async listExpiredSessions(cutoffIso: string): Promise<Array<{ id: string; user_id: string }>> {
		const rows = this.db
			.prepare(
				`SELECT id, user_id FROM sessions
         WHERE ended_at IS NOT NULL AND ended_at < ?
         ORDER BY ended_at ASC`,
			)
			.all(cutoffIso) as Array<{ id: string; user_id: string }>;
		return rows;
	}

	/** @internal Test helper — returns the number of messages rows for the given session. */
	async getMessageCount(sessionId: string): Promise<number> {
		const row = this.db
			.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
			.get(sessionId) as { cnt: number };
		return row.cnt;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}

export function createChatTranscriptIndex(dbPath: string): ChatTranscriptIndex {
	return new ChatTranscriptIndexImpl(dbPath);
}
