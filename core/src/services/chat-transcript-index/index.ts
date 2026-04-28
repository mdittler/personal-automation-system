export type { SessionRow, MessageRow, MatchRow, SearchHit, SearchResult, InternalSearchFilters, RetryOpts } from './types.js';
export { applyMigrations, openWithPragmas, SCHEMA_VERSION } from './schema.js';
export { withSqliteRetry } from './retry.js';
export { buildUntrustedQuery, buildMatchClause, buildTrustedQuery } from './fts-query.js';
