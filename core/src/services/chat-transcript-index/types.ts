export interface SessionRow {
  id: string;
  user_id: string;
  household_id: string | null;
  source: 'telegram' | 'legacy-import';
  started_at: string;  // ISO8601 UTC
  ended_at: string | null;
  model: string | null;
  title: string | null;
}

export interface MessageRow {
  session_id: string;
  turn_index: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;  // ISO8601 UTC
}

export interface MatchRow {
  turn_index: number;
  role: 'user' | 'assistant';
  timestamp: string;
  snippet: string;   // produced by FTS5 snippet()
  bm25: number;
}

export interface SearchHit {
  sessionId: string;
  sessionStartedAt: string;
  sessionEndedAt: string | null;
  title: string | null;
  matches: MatchRow[];
}

export interface SearchResult {
  hits: SearchHit[];
}

export interface InternalSearchFilters {
  userId: string;
  /** Stored for indexing context. Auth filtering is userId-only; household boundary is enforced at the service layer. */
  householdId: string | null;
  queryTerms: string[];            // already sanitized non-empty terms
  limitSessions?: number;          // default 5
  limitMessagesPerSession?: number; // default 3
  startedAfter?: string;           // ISO8601 inclusive
  startedBefore?: string;          // ISO8601 exclusive
  excludeSessionIds?: string[];
}

export interface RetryOpts {
  maxAttempts?: number;     // default 15
  minJitterMs?: number;     // default 20
  maxJitterMs?: number;     // default 150
}
