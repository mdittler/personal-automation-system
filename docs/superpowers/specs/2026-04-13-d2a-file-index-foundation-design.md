# Phase D2a: File Index Foundation

**Date:** 2026-04-13
**Status:** Draft
**Parent spec:** `docs/superpowers/specs/2026-04-13-deployment-readiness-roadmap-design.md` (Phase D2)

## Context

Phase D2 (NL Data Access) enables users to query any data they have access to via natural language in Telegram. D2 is decomposed into three sub-phases:

- **D2a** (this spec): Scope fix + FileIndexService + frontmatter enrichment — the foundation layer
- **D2b**: DataQueryService + chatbot wiring — the NL query pipeline
- **D2c**: InteractionContextService + contextual follow-ups — deictic resolution and router threshold changes

D2a builds the infrastructure that D2b depends on. Without a file index, DataQueryService has nothing to search. Without enriched frontmatter, the index is sparse. Without the scope fix, broadened data-query reads could exploit the scope bypass.

## 1. Scope Normalization Fix

### Problem

`findMatchingScope()` in `core/src/services/data-store/paths.ts:70` only normalizes Windows backslashes to forward slashes. It does not resolve relative path segments (`.`, `..`) before matching against declared scopes. This allows a declared scope of `grocery/` to match `grocery/../pantry.yaml` because the string prefix check passes — but `resolveScopedPath()` later resolves it to `pantry.yaml`, which may belong to a different scope.

This is a declared-scope bypass within the app's data root (not a base-directory escape). Severity is low-medium, but it becomes a prerequisite for D2 because DataQueryService will broaden data-query reads.

### Fix

Apply **virtual POSIX normalization** to both the input path and declared scope path before the prefix comparison. Do not use OS `path.resolve()` (which resolves against cwd). Instead:

1. Replace `\` with `/`
2. Collapse `.` and `..` segments using `path.posix.normalize()` (or manual equivalent)
3. Strip leading `./` if present
4. Preserve trailing `/` on scope paths (directory-scope semantics)
5. Then perform the existing `startsWith` comparison

Both the input path and the manifest scope path are normalized, ensuring consistent matching regardless of how either side is expressed.

**File:** `core/src/services/data-store/paths.ts` — modify `findMatchingScope()`

### Tests

Add to `core/src/services/data-store/__tests__/paths.test.ts` (or the existing scoped-store test):

| Input path | Declared scope | Expected |
|-----------|---------------|----------|
| `grocery/../pantry.yaml` | `grocery/` | No match |
| `grocery\\..\\pantry.yaml` | `grocery/` | No match |
| `grocery/./list.md` | `grocery/` | Match (resolves to `grocery/list.md`) |
| `grocery/sub/../list.md` | `grocery/` | Match (resolves to `grocery/list.md`) |
| `grocery/../../secret.md` | `grocery/` | No match (escapes scope) |
| `logs/../secret.md` | `logs/` | No match |
| `grocery/items.yaml` | `grocery/items.yaml` | Match (exact file scope) |
| `grocery/items.yaml` | `grocery/` | Match (directory scope) |

The existing CR9 "scope parent-traversal regression" test in `scoped-store.test.ts` should continue to pass.

## 2. FileIndexService

### Overview

An in-memory index of all `.md` and `.yaml` data files, rebuilt from the filesystem at startup and kept fresh via `data:changed` events. **Internal infrastructure only in D2a** — not exposed on `CoreServices` or to apps. D2b's DataQueryService will consume it directly via import.

**Location:** `core/src/services/file-index/index.ts`

### Design Decisions

- **Internal-only:** Not added to `CoreServices` in D2a. No manifest enum, no DI wiring to apps. The service is instantiated in bootstrap and passed to DataQueryService in D2b. If apps need direct access later, it can be promoted to `CoreServices` with manifest gating at that time.
- **No disk persistence:** Index rebuilds from filesystem at startup. Target PAS data volumes (a few hundred files per household) rebuild in well under 1 second.
- **Archived files excluded:** Files matching the archive naming pattern (`*.YYYYMMDD-HHmmss.*`) are excluded from indexing at both startup scan and `data:changed` event processing. This ensures cold-start rebuild and live-event behavior are consistent.
- **Conservative graph edges:** No directory-sibling edges (too noisy). D2a stores `entityKeys` and path-derived metadata as index fields, but `getRelated()` only returns explicit frontmatter `related`/`source` edges and wiki-link edges. Entity-key matching and path-convention semantic edges are D2b concerns.
- **Manifest-aware indexing:** FileIndexService receives the app manifest registry at construction. Files whose derived `appId` does not match any registered app are indexed with `appId: 'unknown'` — D2b's DataQueryService will exclude these from query results by default.
- **Bootstrap lifecycle:** Instantiated after app registry load (needs manifests for validation) and before Telegram/router handling begins. Subscribes to `data:changed` via EventBus; unsubscribes on shutdown via ShutdownManager.

### Index Entry Schema

```typescript
interface FileIndexEntry {
  path: string;              // relative to data root (e.g., "users/matt/food/recipes/tacos.yaml")
  appId: string;             // derived from path convention
  scope: 'user' | 'shared' | 'space';
  owner: string | null;      // userId for user-scoped, spaceId for space-scoped, null for shared
  type: string | null;       // from frontmatter type field
  title: string | null;      // from frontmatter title or first heading
  tags: string[];            // from frontmatter tags
  aliases: string[];         // from frontmatter aliases
  entityKeys: string[];      // from frontmatter entity_keys
  dates: { earliest: string | null; latest: string | null }; // ISO dates from frontmatter or filename
  relationships: Array<{ target: string; type: string }>; // from frontmatter related/source
  wikiLinks: string[];       // parsed [[links]]
  size: number;              // file size in bytes
  modifiedAt: Date;          // file mtime
  summary: string | null;    // from frontmatter description or first non-heading paragraph
}
```

### Startup Indexing

1. Scan known PAS data directories: `data/users/*/`, `data/users/shared/`, `data/spaces/*/`
2. For each `.md` or `.yaml` file:
   - Skip if filename matches archive pattern (`*.YYYYMMDD-HHmmss.*`)
   - Derive `appId`, `scope`, and `owner` from path convention
   - Parse frontmatter via existing `parseFrontmatter()`
   - Extract wiki-links via existing `extractWikiLinks()`
   - Extract dates from frontmatter `date`/`created` fields and filename patterns (e.g., `YYYY-MM-DD.md`, `YYYY-MM.yaml`)
   - Build `FileIndexEntry`

### Graph Edges (D2a scope)

D2a implements only explicit, deterministic edges — no semantic inference:

1. **Frontmatter relationships** — `related: [path1, path2]` and `source: path` fields create explicit edges
2. **Wiki-links** — `[[target]]` creates a "references" edge

`entityKeys` and path-derived metadata (e.g., `prices/{store}.md` → entity type "store") are stored as index fields for D2b's DataQueryService to use for semantic matching at query time. They are NOT pre-computed as graph edges in D2a to avoid O(n^2) edge explosion.

### Index Refresh

Subscribe to `data:changed` events (already emitted by ScopedStore):

- **write/append** → re-index the affected file (re-read, re-parse frontmatter, update entry)
- **archive** → remove the entry for the original path (the renamed archive file is excluded by naming pattern)

Expose:
- `handleDataChanged(payload: DataChangedPayload)` — event handler wired to `data:changed`. Reconstructs the data-root-relative path from payload fields (`appId`, `userId`, `path`, `spaceId`) and re-indexes or removes accordingly
- `reindexByPath(dataRootRelativePath: string)` — re-read and update a single entry by its data-root-relative path (for manual/programmatic use)
- `rebuild()` — full rescan (used at startup)
- `getEntries(filter?: FileIndexFilter)` — query the index with optional filters (scope, appId, type, owner, tags, date range, text search on title/entityKeys/aliases)
- `getRelated(path: string)` — return graph neighbors (frontmatter relationships + wiki-link targets only in D2a)

### File: `core/src/services/file-index/index.ts`

Key implementation notes:
- Store entries in a `Map<string, FileIndexEntry>` keyed by relative path
- Path derivation: `data/users/<userId>/<appId>/...` → scope=user, owner=userId, appId from path segment. `data/users/shared/<appId>/...` → scope=shared. `data/spaces/<spaceId>/<appId>/...` → scope=space, owner=spaceId
- Use `fs.readdir` recursive for startup scan
- Archive pattern regex: `/\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\./` (matches `.2026-04-13_14-30-22.` in archived filenames, from `toArchiveTimestamp()`)

## 3. Frontmatter Enrichment

### Type Change

Widen `FrontmatterMeta.type` in `core/src/utils/frontmatter.ts` from the current 6-literal union (`'daily-note' | 'report' | 'alert' | 'journal' | 'diff' | 'log'`) to `string`. This allows app-defined types like `recipe`, `price-list`, `receipt`, `grocery-list`, `nutrition-log`, `meal-plan`, etc.

### Enrichment Targets

Only new writes are enriched — no migration of existing files. The specific write sites to modify:

**Food app (`apps/food/`):**

| Write site | File | Add to frontmatter |
|-----------|------|-------------------|
| Recipe save (create + update) | `services/recipe-store.ts` (`saveRecipe` + `updateRecipe`) | `type: 'recipe'`, `entity_keys: [recipe name, ...main ingredients]` |
| Receipt capture | `handlers/photo.ts` | `type: 'receipt'`, `entity_keys: [store name]`, `date: receiptDate` |
| Price logging | `services/price-store.ts` | `type: 'price-list'`, `entity_keys: [store name, store slug]` |
| Grocery list | `services/grocery-store.ts` | `type: 'grocery-list'`, `entity_keys: [list name or date]` |
| Nutrition logging | `services/macro-tracker.ts` | `type: 'nutrition-log'` (no entity_keys — monthly files) |
| Meal plan (save + archive) | `services/meal-plan-store.ts` (`savePlan` + `archivePlan`) | `type: 'meal-plan'`, `entity_keys: [week identifier]` |
| Pantry | `services/pantry-store.ts` | `type: 'pantry'` |
| Health metrics | `services/health-store.ts` | `type: 'health-metrics'` (no entity_keys — monthly files) |
| Cultural calendar | `services/cultural-calendar.ts` | `type: 'cultural-calendar'` |

**Important: enrich both creation and update writes.** Any store that rewrites the entire file (e.g., `updateRecipe()`, `archivePlan()`) must include the enriched frontmatter, otherwise an update would regress the index by dropping `type`/`entity_keys` fields.

**Non-target food write sites (D2a scope):** The following food stores are NOT enriched in D2a and remain indexed by path/title/existing-frontmatter only: freezer, leftovers, waste log, budget history, quick meals, guests, family profiles, ingredient cache. These are lower-priority for NL querying. They can be enriched in a follow-up if D2b reveals gaps.

**Price file entity_keys rule:** Include store name, slug, and top-level category keys only — NOT individual item names. Price files can grow large; the indexer can derive item-level detail from file body if needed in D2b.

**Receipt entity_keys rule:** Include store name only — NOT individual line items. Line items are in the YAML body and queryable by DataQueryService in D2b.

**Chatbot app:** Already writes `type: 'daily-note'` — no changes needed.

**Notes app:** Already writes `type: 'daily-note'` — no changes needed.

### `generateFrontmatter` Changes

No changes to the function itself needed — it already supports arbitrary keys via the `[key: string]: unknown` index signature. The `entity_keys` field will be serialized as a YAML array automatically.

## 4. Files to Modify

| File | Change |
|------|--------|
| `core/src/services/data-store/paths.ts` | Virtual POSIX normalization in `findMatchingScope()` |
| `core/src/utils/frontmatter.ts` | Widen `FrontmatterMeta.type` to `string` |
| `core/src/services/file-index/index.ts` | **New file** — FileIndexService |
| `core/src/services/file-index/__tests__/file-index.test.ts` | **New file** — FileIndexService tests |
| `core/src/services/data-store/__tests__/paths.test.ts` | Scope normalization regression tests |
| `apps/food/src/services/recipe-store.ts` | Frontmatter enrichment (`saveRecipe` + `updateRecipe`) |
| `apps/food/src/handlers/photo.ts` | Receipt frontmatter enrichment |
| `apps/food/src/services/price-store.ts` | Price frontmatter enrichment |
| `apps/food/src/services/grocery-store.ts` | Grocery list frontmatter enrichment |
| `apps/food/src/services/macro-tracker.ts` | Nutrition log frontmatter enrichment |
| `apps/food/src/services/meal-plan-store.ts` | Meal plan frontmatter enrichment (`savePlan` + `archivePlan`) |
| `apps/food/src/services/pantry-store.ts` | Pantry frontmatter enrichment |
| `apps/food/src/services/health-store.ts` | Health metrics frontmatter enrichment |
| `apps/food/src/services/cultural-calendar.ts` | Cultural calendar frontmatter enrichment |

## 5. Verification

### Scope normalization tests
- All 8 cases from the table in Section 1
- Existing CR9 regression test continues to pass

### FileIndexService tests
- **Startup rebuild:** Create temp data directory with user/shared/space files, verify index entries have correct scope, owner, appId, type, tags, entityKeys
- **Archive exclusion:** Place an archived file (e.g., `recipe.20260413-143022.yaml`) in the scan directory, verify it is NOT indexed
- **Manifest-aware indexing:** Files under an unregistered app path are indexed with `appId: 'unknown'`
- **Event-driven reindex on write:** Simulate `data:changed` event via `handleDataChanged()`, verify entry updated
- **Event-driven removal on archive:** Simulate `data:changed` event with operation=archive, verify entry removed
- **Rebuild consistency:** Index a file, archive it via event, rebuild from scratch — verify same result (no archived file in index)
- **Frontmatter extraction:** File with `type`, `entity_keys`, `tags`, `related`, `aliases` — verify all fields extracted correctly
- **Wiki-link extraction:** File with `[[target]]` links — verify wikiLinks populated
- **Date extraction:** File named `2026-03-15.md` with frontmatter `date: 2026-03-15` — verify dates.earliest and dates.latest
- **Filter queries:** Test `getEntries()` with scope, appId, type, owner, and text search filters
- **Related query:** Test `getRelated()` returns frontmatter relationships and wiki-link targets only (no entity-key edges)

### Frontmatter enrichment tests
- Recipe write includes `type: recipe` and `entity_keys` in frontmatter
- Receipt write includes `type: receipt`, `entity_keys: [storeName]`, and `date` in frontmatter
- Price write includes `type: price-list` and `entity_keys: [storeName, storeSlug]` in frontmatter
- Verify `generateFrontmatter()` correctly serializes `entity_keys` arrays
- Verify existing tests still pass (no regressions from type widening)

### Integration smoke test
- Start with a data directory containing food app files
- Run FileIndexService rebuild
- Verify index contains entries for recipes, prices, receipts, nutrition logs
- Write a new recipe via the recipe store
- Verify `data:changed` event triggers re-index and new entry appears
