const MAX_QUERY_LENGTH = 500;
const FTS5_OPERATORS = /["*()\:^]/g;
// Zero-width and bidi characters
const ZERO_WIDTH = /[​-‍﻿­‪-‮]/g;

export interface UntrustedQuery {
  terms: string[];
}

export function buildUntrustedQuery(raw: string): UntrustedQuery {
  if (!raw || typeof raw !== 'string') return { terms: [] };
  const truncated = raw.slice(0, MAX_QUERY_LENGTH);
  const sanitized = truncated.replace(ZERO_WIDTH, ' ').replace(FTS5_OPERATORS, ' ');
  const terms = sanitized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return { terms };
}

// Build MATCH clause from pre-sanitized terms (each term is quoted)
export function buildMatchClause(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
}

// Pass-through for internal/test callers who need raw FTS5 syntax (phrase, boolean, prefix)
export function buildTrustedQuery(matchExpr: string): string {
  return matchExpr;
}
