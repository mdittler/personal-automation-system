export interface FileIndexEntry {
  /** Relative to data root (e.g., "users/matt/food/recipes/tacos.yaml") */
  path: string;
  /** Derived from path convention */
  appId: string;
  scope: 'user' | 'shared' | 'space';
  /** userId for user-scoped, spaceId for space-scoped, null for shared */
  owner: string | null;
  /** From frontmatter type field */
  type: string | null;
  /** From frontmatter title or first heading */
  title: string | null;
  tags: string[];
  aliases: string[];
  /** From frontmatter entity_keys */
  entityKeys: string[];
  dates: { earliest: string | null; latest: string | null };
  /** From frontmatter related/source fields */
  relationships: Array<{ target: string; type: string }>;
  /** Parsed [[links]] */
  wikiLinks: string[];
  size: number;
  modifiedAt: Date;
  /** From frontmatter description or first non-heading paragraph */
  summary: string | null;
}

export interface FileIndexFilter {
  scope?: 'user' | 'shared' | 'space';
  appId?: string;
  owner?: string;
  type?: string;
  tags?: string[];
  /** ISO date range */
  dateFrom?: string;
  dateTo?: string;
  /** Text search across title, entityKeys, aliases */
  text?: string;
}

/** Archive filename pattern: .YYYY-MM-DD_HH-mm-ss. (from toArchiveTimestamp()) */
export const ARCHIVE_PATTERN = /\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\./;
