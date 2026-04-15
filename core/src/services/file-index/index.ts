import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, posix } from 'node:path';
import type { DataChangedPayload } from '../../types/data-events.js';
import type { ManifestDataScope } from '../../types/manifest.js';
import { findMatchingScope } from '../data-store/paths.js';
import { parsePathMeta, parseFileContent, isArchived, resolveHouseholdMeta } from './entry-parser.js';
import type { FileIndexEntry, FileIndexFilter } from './types.js';

export { type FileIndexEntry, type FileIndexFilter } from './types.js';

/** Pattern for safe userId/appId/spaceId segments — matches PAS convention. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

export class FileIndexService {
  private readonly entries = new Map<string, FileIndexEntry>();

  /**
   * @param dataDir - Absolute path to the data root
   * @param appScopes - Map of appId → { user: ManifestDataScope[], shared: ManifestDataScope[] }
   *   from the app manifest registry. Files are only indexed if they fall within a registered
   *   app's declared scopes. For space-scoped paths, shared_scopes are used.
   * @param onSkip - Optional callback invoked when a file is skipped due to a read error.
   */
  constructor(
    private readonly dataDir: string,
    private readonly appScopes: Map<string, { user: ManifestDataScope[]; shared: ManifestDataScope[] }>,
    private readonly onSkip?: (path: string, err: unknown) => void,
  ) {}

  /** Full scan of data directories. Replaces current index. */
  async rebuild(): Promise<void> {
    this.entries.clear();

    for (const topDir of ['users', 'spaces', 'households', 'collaborations']) {
      const fullDir = join(this.dataDir, topDir);
      await this.scanDirectory(fullDir, topDir);
    }
  }

  private async scanDirectory(dirPath: string, prefix: string): Promise<void> {
    let dirEntries;
    try {
      dirEntries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirEntries) {
      const entryPath = join(dirPath, entry.name);
      const relativePath = `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        await this.scanDirectory(entryPath, relativePath);
      } else if (entry.isFile() && this.isIndexable(entry.name)) {
        await this.indexFile(entryPath, relativePath);
      }
    }
  }

  private isIndexable(filename: string): boolean {
    if (isArchived(filename)) return false;
    return filename.endsWith('.md') || filename.endsWith('.yaml') || filename.endsWith('.yml');
  }

  private async indexFile(absolutePath: string, relativePath: string): Promise<void> {
    try {
      const pathMeta = parsePathMeta(relativePath);

      // Skip files from unregistered apps
      if (!this.appScopes.has(pathMeta.appId)) return;

      // Skip files outside declared manifest scopes
      const scopes = this.appScopes.get(pathMeta.appId)!;
      // Space-scoped paths use shared scopes (matches DataStoreServiceImpl.forSpace behavior)
      const scopeList = pathMeta.scope === 'user' ? scopes.user : scopes.shared;
      // Derive app-relative path by stripping the prefix segments that precede the app data.
      // The offset varies by layout:
      //   users/matt/food/recipes/tacos.yaml         → offset 3 → recipes/tacos.yaml
      //   households/hh/users/matt/food/recipes.yaml → offset 5 → recipes.yaml
      //   households/hh/shared/food/prices.md        → offset 4 → prices.md
      //   collaborations/sId/food/data.md            → offset 3 → data.md
      const appRelativePath = relativePath.split('/').slice(pathMeta.appRelativeOffset).join('/');
      if (!findMatchingScope(appRelativePath, scopeList)) return;

      const [content, fileStat] = await Promise.all([
        readFile(absolutePath, 'utf-8'),
        stat(absolutePath),
      ]);

      const parsed = parseFileContent(content);

      // Supplement dates from filename if frontmatter dates are absent
      const dates = { ...parsed.dates };
      const filenameDate = this.extractDateFromFilename(basename(absolutePath));
      if (filenameDate) {
        if (!dates.earliest || filenameDate < dates.earliest) dates.earliest = filenameDate;
        if (!dates.latest || filenameDate > dates.latest) dates.latest = filenameDate;
      }

      const hhMeta = resolveHouseholdMeta(relativePath);

      const entry: FileIndexEntry = {
        path: relativePath,
        appId: pathMeta.appId,
        scope: pathMeta.scope,
        owner: pathMeta.owner,
        householdId: hhMeta.householdId,
        spaceKind: hhMeta.spaceKind,
        collaborationId: hhMeta.collaborationId,
        type: parsed.type,
        title: parsed.title,
        tags: parsed.tags,
        aliases: parsed.aliases,
        entityKeys: parsed.entityKeys,
        dates,
        relationships: parsed.relationships,
        wikiLinks: parsed.wikiLinks,
        size: fileStat.size,
        modifiedAt: fileStat.mtime,
        summary: parsed.summary,
      };

      this.entries.set(relativePath, entry);
    } catch (err) {
      this.onSkip?.(relativePath, err);
    }
  }

  private extractDateFromFilename(filename: string): string | null {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] ?? null;
  }

  /**
   * Validate DataChangedPayload fields for safe path construction.
   * Rejects payloads with invalid operation, unsafe segments, or traversal in path.
   */
  private isValidPayload(payload: DataChangedPayload): boolean {
    // Reject empty or trivially-normalized paths
    if (!payload.path || payload.path === '.') return false;

    // Validate operation is a known value
    if (!['write', 'append', 'archive'].includes(payload.operation)) return false;

    // Validate appId
    if (!payload.appId || !SAFE_SEGMENT.test(payload.appId)) return false;

    // Validate userId if present
    if (payload.userId !== null && payload.userId !== undefined) {
      if (!SAFE_SEGMENT.test(payload.userId)) return false;
    }

    // Validate spaceId if present
    if (payload.spaceId !== undefined) {
      if (!SAFE_SEGMENT.test(payload.spaceId)) return false;
    }

    // Validate path: use POSIX normalization, reject if it resolves upward or is absolute
    const normalizedPath = posix.normalize(payload.path.replace(/\\/g, '/'));
    if (normalizedPath.startsWith('..') || normalizedPath.startsWith('/') || /^[a-zA-Z]:/.test(normalizedPath)) return false;

    return true;
  }

  /**
   * Handle a data:changed event. Reconstructs the data-root-relative path
   * from the payload and re-indexes or removes accordingly.
   */
  async handleDataChanged(payload: DataChangedPayload): Promise<void> {
    if (!payload || !this.isValidPayload(payload)) return;

    const relativePath = this.payloadToRelativePath(payload);

    if (payload.operation === 'archive') {
      this.entries.delete(relativePath);
      return;
    }

    // write or append — re-index the file
    const absolutePath = join(this.dataDir, relativePath);
    await this.indexFile(absolutePath, relativePath);
  }

  /** Reconstruct data-root-relative path from DataChangedPayload fields. */
  private payloadToRelativePath(payload: DataChangedPayload): string {
    // New household-scoped layout: households/<hh>/...
    if (payload.householdId) {
      const hh = payload.householdId;
      if (payload.spaceId) {
        return `households/${hh}/spaces/${payload.spaceId}/${payload.appId}/${payload.path}`;
      }
      if (payload.userId) {
        return `households/${hh}/users/${payload.userId}/${payload.appId}/${payload.path}`;
      }
      return `households/${hh}/shared/${payload.appId}/${payload.path}`;
    }

    // Legacy layout (no householdId): collaborations or pre-migration paths
    if (payload.collaborationId) {
      return `collaborations/${payload.collaborationId}/${payload.appId}/${payload.path}`;
    }
    if (payload.spaceId) {
      return `spaces/${payload.spaceId}/${payload.appId}/${payload.path}`;
    }
    if (payload.userId) {
      return `users/${payload.userId}/${payload.appId}/${payload.path}`;
    }
    return `users/shared/${payload.appId}/${payload.path}`;
  }

  /** Re-index a single file by its data-root-relative path. */
  async reindexByPath(dataRootRelativePath: string): Promise<void> {
    const normalized = posix.normalize(dataRootRelativePath.replace(/\\/g, '/'));
    if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return;
    const absolutePath = join(this.dataDir, normalized);
    await this.indexFile(absolutePath, normalized);
  }

  /** Query the index with optional filters. No filter returns all entries. */
  getEntries(filter: FileIndexFilter = {}): FileIndexEntry[] {
    const results: FileIndexEntry[] = [];

    for (const entry of this.entries.values()) {
      if (filter.scope && entry.scope !== filter.scope) continue;
      if (filter.appId && entry.appId !== filter.appId) continue;
      if (filter.owner && entry.owner !== filter.owner) continue;
      if (filter.type && entry.type !== filter.type) continue;
      if (filter.tags && !filter.tags.every((t) => entry.tags.includes(t))) continue;

      if (filter.dateFrom && (!entry.dates.latest || entry.dates.latest < filter.dateFrom)) continue;
      if (filter.dateTo && (!entry.dates.earliest || entry.dates.earliest > filter.dateTo)) continue;

      if (filter.text) {
        const needle = filter.text.toLowerCase();
        const haystack = [entry.title ?? '', ...entry.entityKeys, ...entry.aliases]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) continue;
      }

      results.push(entry);
    }

    return results;
  }

  /** Get graph neighbors: frontmatter relationship edges + wiki-link edges. */
  getRelated(path: string): Array<{ target: string; type: string }> {
    const entry = this.entries.get(path);
    if (!entry) return [];

    return [
      ...entry.relationships,
      ...entry.wikiLinks.map((target) => ({ target, type: 'wiki-link' })),
    ];
  }

  /** Total number of indexed files. */
  get size(): number {
    return this.entries.size;
  }
}
