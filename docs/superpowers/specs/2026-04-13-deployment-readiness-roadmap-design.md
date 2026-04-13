# PAS Deployment Readiness Roadmap

## Context

PAS is a local-first home automation platform built for household use via Telegram. All infrastructure (phases 0-30) and the Food app (H1-H12b) are complete, with 5856 tests across 235 files. Security review remediation (R1-R7, CR6, CR8, CR9) is done.

The system has not been used in production yet. The target deployment is a Mac Mini (arriving ~3 weeks) serving the owner's household initially, scaling to 5-10 households (15-40 users) on the same single-process instance.

**Problems this roadmap addresses:**
1. Chat experience feels disconnected — poor context tracking, no data awareness
2. Users cannot query their own data via natural language (prices, meal history, nutrition)
3. Users cannot correct data errors via Telegram (OCR mistakes, wrong prices)
4. Codex audit identified 5 findings (scope normalization, XSS, Docker, concurrency, cookies)
5. No operational tooling (backup, health checks, deployment docs)
6. Multi-household isolation and onboarding not validated

**Approach:** UX-first. Make the platform genuinely useful before hardening. Security findings are all low-to-medium severity requiring authenticated access, acceptable for initial local deployment.

---

## Phase D1: Chatbot Context & Conversation Quality

**Goal:** Make the chatbot feel like a natural conversation partner that knows who you are and what's happening in your household.

### Changes

**1. LLM-based PAS context detection** (replaces 66+ hardcoded keywords)
- Remove the static `PAS_KEYWORDS` list in the chatbot
- Use a fast-tier LLM call to classify whether a message is PAS-related
- If PAS-related, inject the app-aware system prompt; otherwise use the basic conversational prompt
- Key file: `apps/chatbot/src/index.ts` (the `isPASRelated()` / auto-detect logic)

**2. Conversation quality improvements**
- Validate the existing recency-weighting fix in `conversation-history.ts` — test that recent messages are prioritized
- Raise the 1024 token response cap to 2048. Add Telegram message splitting (Telegram max is 4096 chars) — if response exceeds limit, split at paragraph boundaries and send as multiple messages. Do not remove the cap entirely (cost control + UX)
- Inject user profile context into system prompt: user's name, household members, active space, recent app activity summary
- Key file: `apps/chatbot/src/conversation-history.ts`

**3. User profile grounding**
- Chatbot system prompt includes: user display name, household context (space membership), which apps are active, and a brief "recent activity" summary (last 3-5 app interactions)
- This makes responses feel personalized rather than generic

### What doesn't change
- Message routing priority unchanged (commands → photos → LLM classification → chatbot fallback)
- Chatbot remains the fallback handler
- Daily notes side-effect stays (useful for Obsidian integration)

### Verification
- Test: send conversational message, verify PAS context injected when relevant and omitted when not
- Test: multi-turn conversation maintains coherent context
- Test: response length is appropriate (no truncation on detailed answers)

---

## Phase D2: NL Data Access (File-Native Graph + Data-Aware Chatbot)

**Goal:** Users can query any data they have access to via natural language in Telegram. "Compare orange prices between Costco and Walmart." "What did I eat last week?" "Which recipe is cheapest with what's in my pantry?"

### Architecture: File-Native Graph

The .md/YAML files remain the authoritative data store. A derived, disposable index makes them programmatically queryable. The index is rebuilt from files at startup and kept fresh via write hooks.

#### FileIndexService (new core service)

**Location:** `core/src/services/file-index/index.ts`

**Startup indexing:**
- Scan all data directories (`data/users/*/`, `data/users/shared/`, `data/spaces/*/`)
- For each `.md`/`.yaml` file: extract path, app, scope (user/shared/space), frontmatter fields, file stats (size, modified date)
- Build lightweight index records:
  ```
  {
    path: string              // relative to data root
    app: string               // app ID (food, chatbot, etc.)
    scope: 'user' | 'shared' | 'space'
    owner: string | null      // userId for user-scoped, spaceId for space-scoped
    type: string | null       // from frontmatter: recipe, price-list, nutrition-log, etc.
    title: string | null      // from frontmatter or first heading
    tags: string[]            // from frontmatter
    aliases: string[]         // from frontmatter
    entityKeys: string[]      // extracted: ingredient names, store names, recipe slugs
    dates: { earliest, latest } // from filename patterns or frontmatter
    relationships: Array<{ target: string, type: string }> // from frontmatter related/source fields
    wikiLinks: string[]       // parsed [[links]] for human graph
    size: number
    modifiedAt: Date
    summary: string | null    // from frontmatter description or first paragraph
  }
  ```

**Graph edge derivation (deterministic, no LLM):**
1. **Structured frontmatter fields** — `related:`, `source:`, `source_recipe_ids:`, `ingredient_keys:`, `store:`
2. **Path conventions** — `prices/{store}.md` → store entity, `nutrition/YYYY-MM.yaml` → date range, `recipes/{slug}.md` → recipe entity
3. **Entity key matching** — canonical ingredient names appearing in multiple files create implicit edges
4. **Wiki-links** — `[[target]]` parsed as relationship edges (type inferred from context or defaulted to "references")

**Index refresh via `data:changed` events (keeps index fresh):**
- `ScopedDataStore` already emits `data:changed` on write/append/archive with full context (app, scope, path)
- `FileIndexService` subscribes to `data:changed` → re-indexes just the affected file
- Exposes `reindexFile(path)` and `rebuild()` for startup and maintenance
- Direct utility writes (outside ScopedStore) are out-of-band and not indexed unless explicitly reindexed
- No disk persistence of the index — it rebuilds in seconds at startup

#### DataQueryService (new core service)

**Location:** `core/src/services/data-query/index.ts`

**Query flow:**
1. User sends NL question to chatbot
2. Chatbot detects data-query intent (part of the LLM PAS-classification from Phase D1)
3. `DataQueryService.query(question, userId)` is called
4. **Scope filtering** — index entries filtered to files the user can access:
   - User-scoped files: only if `owner === userId`
   - Shared-scoped files: always accessible to household members
   - Space-scoped files: only if user is a member of the space (via `SpaceService.isMember()`)
5. **File selection** — fast-tier LLM sees the filtered metadata index (each entry assigned a numeric ID) and the user's question. Returns list of 1-5 entry IDs to read. **Security: LLM output is untrusted.** DataQueryService validates every returned ID exists in the pre-authorized candidate set. Any ID not in the filtered index is silently dropped — no hallucinated or injected paths become filesystem reads
6. **File reading** — validated files read via `ScopedDataStore`, frontmatter stripped
7. **Context bundle** — file contents + metadata returned to chatbot
8. Chatbot injects data context into system prompt, LLM generates answer

**Scope enforcement is critical:**
- User-scoped files (`data/users/<userId>/<appId>/`): only the owning user. Nina cannot see Matt's `health/` or `nutrition/` files
- Shared-scoped files (`data/users/shared/<appId>/`): accessible to all users in the same PAS instance (household-level shared data like grocery prices, recipes, pantry)
- Space-scoped files (`data/spaces/<spaceId>/<appId>/`): only members of that space. Household A's space data is invisible to Household B
- **Multi-household rule (critical for D6 compatibility):** When spaces exist and the querying user belongs to a space, `DataQueryService` includes: (1) the user's own user-scoped files, (2) space-scoped files for spaces the user is a member of, (3) global shared files ONLY if the user is not in any space OR if the system is in single-household mode. This prevents global shared data from leaking across household boundaries when multi-household spaces are active. The implementation must NOT assume "shared = everyone can see it" — it must check space membership context
- This leverages the existing manifest scope system — no new permission model needed

#### Frontmatter enrichment (on future writes)

- Modify existing write operations (recipe creation, grocery list generation, price logging, etc.) to include richer frontmatter:
  - `type:` field — use the existing `FrontmatterMeta.type` field. Currently a union of 6 literals; widen to `string` to support app-defined types (recipe, price-list, grocery-list, nutrition-log, meal-plan, etc.). The index signature `[key: string]: unknown` already allows extra fields, but `type` should be first-class
  - `entity_keys:` for searchable entities (ingredient names, store names) — new custom frontmatter field
  - `related:` for explicit cross-file relationships — already in `FrontmatterMeta`
  - `aliases:` for alternative names — already in `FrontmatterMeta`
- No v1 migration of existing files — they work with path-convention and filename-based indexing. Enrichment happens naturally on new writes
- Optional backfill script for existing files (run once, low priority)

### Integration with chatbot

The chatbot's `/ask` command and regular chat both gain data access. The flow:
1. LLM classifies message as PAS-related (Phase D1)
2. If data-query detected, DataQueryService provides context
3. Chatbot LLM answers with data context in system prompt
4. Response clearly indicates data source ("Based on your Costco price history..." or "From your nutrition log for March...")

### Verification
- Test: "Compare orange prices between stores" → reads prices/*.md, returns comparison
- Test: "What did I eat last week?" → reads nutrition/YYYY-MM.yaml, filters to last 7 days
- Test: user A cannot see user B's personal health data via chatbot query
- Test: shared data accessible to all household members
- Test: file index rebuilds correctly from cold start
- Test: file index updates on write without full re-scan

---

## Phase D3: Data Modification via /edit Command

**Goal:** Users can correct data errors through Telegram with explicit confirmation guards.

### Design

**New `/edit` command** registered as a core command (not app-specific):
```
/edit fix the price of oranges at Costco to $4.99
/edit remove the duplicate entry in my grocery list
/edit correct the calories for yesterday's lunch to 450
```

**Flow:**
1. User sends `/edit <natural language description>`
2. System identifies target file(s) using DataQueryService (same scope filtering as Phase D2)
3. Standard-tier LLM reads current file content + edit request, generates proposed changes
4. System sends preview to user via Telegram:
   ```
   Proposed edit to prices/costco.md:
   - oranges: $6.99/bag (4lb)
   + oranges: $4.99/bag (4lb)
   [Confirm] [Cancel]
   ```
5. User taps Confirm → atomic write with change
6. Edit logged: timestamp, userId, file path, before/after hash

**Guards:**
- Only files the user has `read-write` or `write` access to per manifest scopes
- Preview + confirmation required for every edit (no silent writes)
- **Stale-write protection:** on preview generation, compute and store a `beforeHash` of the file content + expiration timestamp (5 minutes). On Confirm, re-read the file, verify hash matches. If file changed between preview and confirm (another user edited it, app updated it), reject and ask user to regenerate the preview. Apply the write under the per-path FileMutex lock (Phase D5)
- One file per edit (no batch edits in v1)
- Edit audit log at `data/system/edit-log.yaml` (append-only)

### Verification
- Test: `/edit` with valid correction shows preview and applies on confirm
- Test: `/edit` targeting a read-only file is rejected
- Test: user cannot edit another user's personal data
- Test: cancel button aborts without writing
- Test: edit audit log records all confirmed edits

---

## Phase D4: Security Hardening (Codex Findings)

**Goal:** Address all 5 Codex audit findings before exposing the system to users beyond the owner.

### Findings and fixes (priority order)

**1. Secure cookie** (finding: `auth.ts:61`) — Severity: medium
- Set `secure: true` when `NODE_ENV=production` or `GUI_SECURE_COOKIES=true` env var
- Add test: production login response sets Secure flag
- Key file: `core/src/gui/auth.ts`

**2. Scope normalization** (finding: `paths.ts:76`, `scoped-store.ts:60`) — Severity: low-medium
- No base-directory escape possible (`resolveScopedPath()` blocks `..` beyond the app data root)
- Valid scope-enforcement bug: a path like `grocery/../pantry.yaml` can match the `grocery/` scope prefix before resolving to `pantry.yaml`, which is a different declared scope. This is a manifest-scope bypass within the app data root — important to fix before D2 broadens data-query reads
- Fix: canonicalize paths before passing to `findMatchingScope()`
- Add tests: `grocery/../pantry.yaml`, `logs/../secret.md`, Windows backslash variants
- Key files: `core/src/services/data-store/paths.ts`, `core/src/services/data-store/scoped-store.ts`

**3. Inline JS escaping** (finding: `data.ts:355`) — Severity: low-medium
- Replace inline `onclick` handlers with `data-*` attributes + delegated event listener from static JS
- Eliminates the HTML→JS escaping context mismatch entirely
- Add tests: filenames with `'`, `"`, `\`, `</script>` characters
- Key file: `core/src/gui/routes/data.ts`

**4. Docker workspace dependency gap** (finding: `Dockerfile:15`) — Severity: low
- Copy all `apps/*/package.json` before `pnpm install` in the cache layer
- Add Docker smoke test: build image, start, assert all bundled app IDs load
- Key file: `Dockerfile`

### Verification
- All existing tests pass
- New security regression tests for each finding
- Docker image builds and starts successfully with all apps

---

## Phase D5: Concurrency & Operational Readiness

**Goal:** Ensure the system is reliable for always-on household deployment.

### Concurrency: In-process file locks

**Reuse existing `AsyncLock`** (`core/src/utils/async-lock.ts`)
- `AsyncLock` already exists in core — reuse it for per-path file locking
- Create a `FileMutex` wrapper: `Map<canonicalPath, AsyncLock>` with `withLock(path, fn)` convenience method
- **Critical: locks must wrap the ENTIRE read-modify-write operation** — not just the save/write step. The lock must be acquired before loading the file and released after the write completes. Locking only the write step does not prevent lost updates because two operations can read the same stale state before either acquires the lock
- Applied to all shared mutable stores: grocery, pantry, freezer, leftovers, household, spaces. Each store's public mutation methods acquire the lock internally, so callers don't need to manage locking
- Key files: all `*-store.ts` files in `apps/food/src/services/`

**Why this is sufficient:** Single Node.js process on Mac Mini. In-process locks serialize all concurrent access. If multi-process ever needed, upgrade to file-level locks (flock) as a future step.

### Health endpoint upgrade

- Expand `GET /health` to include readiness checks:
  - Telegram: bot connection active
  - Scheduler: cron manager running
  - LLM: at least one provider reachable (cached check, refreshed every 60s)
  - File system: data directory writable
- Add `GET /health/ready` (full checks) vs `GET /health/live` (process alive)
- Key file: `core/src/server/health.ts`

### Backup mechanism

- Scheduled backup job: tarball `data/` and `config/` directories
- Configurable: backup path, schedule (default: daily at 3am), retention count (default: 7)
- Configuration in `pas.yaml` under `backup:` section
- Restore: manual untar (document in ops guide)

### Deployment documentation

- `docs/DEPLOYMENT.md`: environment variables, Docker setup, Cloudflare Tunnel, first-run checklist
- `docs/OPERATIONS.md`: backup/restore, monitoring health endpoint, common troubleshooting

### Verification
- Test: two concurrent grocery list updates both survive (no lost updates)
- Test: health endpoint reports unhealthy when Telegram disconnected
- Test: backup creates valid tarball, can be extracted
- Deployment docs reviewed for completeness

---

## Phase D6: Multi-Household Scalability

**Goal:** Support 5-10 households (15-40 users) on a single Mac Mini with proper isolation and onboarding.

### Onboarding flow

- Streamline: admin creates invite code → new user redeems via Telegram → auto-assigned to household space → immediate access to shared data
- Guided first-run experience: bot introduces itself, explains available commands, asks for display name and preferences
- Key files: `core/src/services/invite/`, `core/src/gui/routes/users.ts`

### Per-household data isolation audit

- Verify all shared stores correctly scope via spaces — no data leakage between households
- Automated test: create two spaces with different members, verify cross-space queries return nothing
- Audit food app: all shared_scopes must be space-aware when spaces are active

### Operational monitoring

- GUI dashboard: per-household LLM cost breakdown, active users, data file counts
- Per-household rate limiting: ensure one household's heavy LLM usage doesn't exhaust caps for others
- LLM guard enhancement: per-space cost caps in addition to per-app caps

### Rate limiting for scale

- Current in-memory rate limiter works for single process — sufficient for 15-40 users
- Add per-space rate limit tier to prevent one household monopolizing resources
- Key file: `core/src/middleware/rate-limiter.ts`

### Verification
- Test: full onboarding flow from invite to first query
- Test: household A's data never visible to household B
- Test: LLM cost caps enforced per household
- Test: 40 simulated users don't cause memory/performance issues (load test)

---

## Phase ordering and dependencies

```
Phase D1 ──→ Phase D2 ──→ Phase D3
                              │
Phase D4 (independent) ───────┤
                              │
              Phase D5 ───────┤
                              │
                        Phase D6
```

- **D1 before D2**: chatbot context quality is the foundation for data-aware chat
- **D2 before D3**: /edit uses DataQueryService for file discovery
- **D4 is independent**: can run in parallel with D1-D3 if desired
- **D5 before D6**: concurrency locks and ops tooling needed before multi-household
- **D6 last**: only needed when expanding beyond the owner's household

### Estimated scope per phase
- **D1**: ~1 session (chatbot modifications, LLM classifier, tests)
- **D2**: ~2-3 sessions (FileIndexService + DataQueryService + chatbot integration + tests)
- **D3**: ~1 session (/edit command + preview flow + tests)
- **D4**: ~1 session (4 targeted fixes + regression tests)
- **D5**: ~1-2 sessions (FileMutex + health + backup + docs)
- **D6**: ~1-2 sessions (onboarding + isolation audit + monitoring)

---

## Codex findings assessment summary

| # | Finding | Severity | Verdict | Phase |
|---|---------|----------|---------|-------|
| 1 | Data-scope normalization (`paths.ts:76`) | Low-medium | Valid scope-enforcement bug within app data root. No base-dir escape, but manifest-scope bypass possible. Fix before D2. | D4 |
| 2 | Inline JS escaping (`data.ts:355`) | Low-medium | Valid — HTML escaper in JS context. Fix by removing inline JS. | D4 |
| 3 | Docker workspace dependency gap (`Dockerfile:15`) | Low | Valid — affects caching, not correctness. | D4 |
| 4 | Shared file read-modify-write (grocery/pantry) | Low | Valid — in-process locks sufficient for single process. | D5 |
| 5 | Secure cookie (`auth.ts:61`) | Medium | Valid — easy conditional fix. | D4 |

## Scalability assessment

| Concern | Current state | Action | Phase |
|---------|--------------|--------|-------|
| Concurrent file writes | No locking | In-process FileMutex | D5 |
| Multi-process coordination | N/A (single process) | Not needed for 15-40 users | Deferred |
| Rate limiting | In-memory, per-user | Add per-household tier | D6 |
| Scheduled job execution | Single process, works | No change needed | — |
| Data backup/restore | None | Scheduled tarball + docs | D5 |
| Health/readiness | Basic alive check | Full readiness endpoint | D5 |
| Plugin trust | In-process, trusted | Acceptable for known apps | Deferred |
| SQLite migration | Not needed | Only if multi-process required | Deferred |

## Design principles

1. **.md files are the source of truth** — the index is derived, disposable, and rebuildable
2. **Metadata is the machine contract, wiki-links are the human graph** — both valuable, different purposes
3. **Deterministic indexing first, LLM second** — path conventions, frontmatter fields, and entity keys do most of the work; LLM only for ambiguous classification
4. **No v1 migration** — enrich on future writes, optionally backfill later
5. **Scope enforcement everywhere** — personal data stays personal, shared data respects space membership
6. **Single process is fine** — for 15-40 users on a Mac Mini, in-process coordination is sufficient
