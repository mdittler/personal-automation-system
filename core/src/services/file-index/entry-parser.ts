import { parseFrontmatter, extractWikiLinks } from '../../utils/frontmatter.js';
import { ARCHIVE_PATTERN } from './types.js';
import type { SpaceKind } from '../../types/spaces.js';

interface PathMeta {
  appId: string;
  scope: 'user' | 'shared' | 'space' | 'collaboration';
  owner: string | null;
  /**
   * Number of path segments to skip to obtain the app-relative path.
   * Used by FileIndexService.indexFile() for scope matching.
   *
   * Examples:
   *   users/matt/food/recipes/tacos.yaml         → offset 3 → recipes/tacos.yaml
   *   households/hh/users/matt/food/recipes.yaml → offset 5 → recipes.yaml
   *   households/hh/shared/food/prices.md        → offset 4 → prices.md
   *   collaborations/sId/food/data.md            → offset 3 → data.md
   */
  appRelativeOffset: number;
}

/**
 * Derive appId, scope, owner, and app-relative offset from a data-root-relative path.
 *
 * Supported patterns:
 *   users/<userId>/<appId>/...                     → user scope  (offset 3)
 *   users/shared/<appId>/...                       → shared scope (offset 3)
 *   spaces/<spaceId>/<appId>/...                   → space scope  (offset 3)
 *   households/<hh>/users/<uid>/<appId>/...        → user scope  (offset 5)
 *   households/<hh>/shared/<appId>/...             → shared scope (offset 4)
 *   households/<hh>/spaces/<sId>/<appId>/...       → space scope  (offset 5)
 *   collaborations/<sId>/<appId>/...               → collaboration scope (offset 3)
 */
export function parsePathMeta(relativePath: string): PathMeta {
  const parts = relativePath.split('/');

  if (parts[0] === 'users') {
    if (parts[1] === 'shared' && parts.length >= 3) {
      return { appId: parts[2] ?? 'unknown', scope: 'shared', owner: null, appRelativeOffset: 3 };
    }
    if (parts.length >= 3) {
      return { appId: parts[2] ?? 'unknown', scope: 'user', owner: parts[1] ?? null, appRelativeOffset: 3 };
    }
  }

  if (parts[0] === 'spaces' && parts.length >= 3) {
    return { appId: parts[2] ?? 'unknown', scope: 'space', owner: parts[1] ?? null, appRelativeOffset: 3 };
  }

  if (parts[0] === 'households' && parts.length >= 3) {
    const segment2 = parts[2] ?? '';

    if (segment2 === 'users' && parts.length >= 5) {
      // households/<hh>/users/<uid>/<appId>/...
      return { appId: parts[4] ?? 'unknown', scope: 'user', owner: parts[3] ?? null, appRelativeOffset: 5 };
    }
    if (segment2 === 'shared' && parts.length >= 4) {
      // households/<hh>/shared/<appId>/...
      return { appId: parts[3] ?? 'unknown', scope: 'shared', owner: null, appRelativeOffset: 4 };
    }
    if (segment2 === 'spaces' && parts.length >= 5) {
      // households/<hh>/spaces/<sId>/<appId>/...
      return { appId: parts[4] ?? 'unknown', scope: 'space', owner: parts[3] ?? null, appRelativeOffset: 5 };
    }
  }

  if (parts[0] === 'collaborations' && parts.length >= 3) {
    // collaborations/<sId>/<appId>/...
    return { appId: parts[2] ?? 'unknown', scope: 'collaboration', owner: parts[1] ?? null, appRelativeOffset: 3 };
  }

  // Unrecognized path structure — FileIndexService will skip this entry since
  // 'unknown' will not match any registered appId in the scope map.
  return { appId: 'unknown', scope: 'shared', owner: null, appRelativeOffset: 3 };
}

interface ParsedContent {
  title: string | null;
  type: string | null;
  tags: string[];
  aliases: string[];
  entityKeys: string[];
  dates: { earliest: string | null; latest: string | null };
  relationships: Array<{ target: string; type: string }>;
  wikiLinks: string[];
  summary: string | null;
}

/** Extract date string if it looks like an ISO date (YYYY-MM-DD...) */
function toDateString(val: unknown): string | null {
  if (typeof val === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(val)) return val.slice(0, 10);
  return null;
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string');
  if (typeof val === 'string') return [val];
  return [];
}

/**
 * Parse file content to extract indexable fields.
 */
export function parseFileContent(content: string): ParsedContent {
  const { meta, content: body } = parseFrontmatter(content);

  // Title: frontmatter > first heading
  let title: string | null = (meta.title as string) ?? null;
  if (!title) {
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (headingMatch?.[1]) title = headingMatch[1].trim();
  }

  const type = typeof meta.type === 'string' ? meta.type : null;
  const tags = toStringArray(meta.tags);
  const aliases = toStringArray(meta.aliases);
  const entityKeys = toStringArray(meta.entity_keys);

  // Dates
  const dateVals = [toDateString(meta.date), toDateString(meta.created)].filter(Boolean) as string[];
  const dates = {
    earliest: dateVals.length ? ([...dateVals].sort()[0] ?? null) : null,
    latest: dateVals.length ? ([...dateVals].sort().reverse()[0] ?? null) : null,
  };

  // Relationships from related and source fields
  const relationships: Array<{ target: string; type: string }> = [];
  for (const rel of toStringArray(meta.related)) {
    relationships.push({ target: rel, type: 'related' });
  }
  // Only create source relationships for path-like values (contains / or .ext)
  if (typeof meta.source === 'string' && (meta.source.includes('/') || /\.\w+$/.test(meta.source))) {
    relationships.push({ target: meta.source, type: 'source' });
  }

  // Wiki-links
  const wikiLinks = extractWikiLinks(body);

  // Summary: first non-heading, non-empty paragraph
  let summary: string | null = null;
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-') && !trimmed.startsWith('```')) {
      summary = trimmed;
      break;
    }
  }

  return { title, type, tags, aliases, entityKeys, dates, relationships, wikiLinks, summary };
}

/** Check if a filename matches the archive naming pattern. */
export function isArchived(filename: string): boolean {
  return ARCHIVE_PATTERN.test(filename);
}

export interface HouseholdMeta {
  householdId: string | null;
  spaceKind: SpaceKind | null;
  collaborationId: string | null;
}

/**
 * Resolve household-boundary metadata from a data-root-relative path.
 *
 * Supported patterns:
 *   households/<hh>/users/<uid>/<app>/...   → householdId: <hh>, spaceKind: null, collaborationId: null
 *   households/<hh>/shared/<app>/...        → householdId: <hh>, spaceKind: null, collaborationId: null
 *   households/<hh>/spaces/<sId>/<app>/...  → householdId: <hh>, spaceKind: 'household', collaborationId: null
 *   collaborations/<sId>/<app>/...          → householdId: null, spaceKind: 'collaboration', collaborationId: <sId>
 *   system/...                              → householdId: null, spaceKind: null, collaborationId: null
 *   users/<uid>/<app>/... (legacy)          → householdId: null, spaceKind: null, collaborationId: null
 *   spaces/<sId>/<app>/... (legacy)         → householdId: null, spaceKind: null, collaborationId: null
 */
export function resolveHouseholdMeta(relativePath: string): HouseholdMeta {
  const NULL_META: HouseholdMeta = { householdId: null, spaceKind: null, collaborationId: null };
  const parts = relativePath.split('/');

  if (parts[0] === 'households' && parts.length >= 3) {
    const hh = parts[1] ?? '';
    const segment2 = parts[2] ?? '';

    if (segment2 === 'spaces' && parts.length >= 4) {
      // households/<hh>/spaces/<sId>/...
      return { householdId: hh, spaceKind: 'household', collaborationId: null };
    }
    // households/<hh>/users/<uid>/... or households/<hh>/shared/...
    return { householdId: hh, spaceKind: null, collaborationId: null };
  }

  if (parts[0] === 'collaborations' && parts.length >= 3) {
    const sId = parts[1] ?? '';
    return { householdId: null, spaceKind: 'collaboration', collaborationId: sId };
  }

  // system/, legacy users/, legacy spaces/, or anything else → no household
  return NULL_META;
}
