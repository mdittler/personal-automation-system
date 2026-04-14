# D2c: InteractionContextService + /edit Command

## Context

D2b delivered NL data querying — users can ask "what did I spend at Costco?" and get answers from their stored data files. Two gaps remain before deployment readiness:

1. **Contextual follow-ups are broken.** After capturing a receipt photo, "show me those costs" doesn't resolve because the system has no memory of recent interactions. Each message is classified in isolation.
2. **Data is read-only via Telegram.** Users can view data but cannot correct mistakes (e.g., OCR misreading a receipt item) without manually editing files. The spec calls for an `/edit` command with preview + confirmation.

This phase adds both capabilities: an `InteractionContextService` for short-term interaction memory, and an `/edit` command for safe NL data modification.

## Part 1: InteractionContextService

### Service Design

**New file:** `core/src/services/interaction-context/index.ts`

In-memory per-user store tracking the last 5 interactions with 10-minute TTL auto-expiry.

```typescript
interface InteractionEntry {
  appId: string;
  action: string;              // e.g. 'receipt_captured', 'recipe_saved'
  entityType?: string;         // e.g. 'receipt', 'recipe', 'grocery-list'
  entityId?: string;           // e.g. 'costco-2026-04-14'
  filePaths?: string[];        // data-root-relative paths written
  scope?: 'user' | 'shared' | 'space';
  spaceId?: string;
  metadata?: Record<string, string>;  // app-specific KV
  timestamp: number;           // Date.now()
}

interface InteractionContextService {
  record(userId: string, entry: Omit<InteractionEntry, 'timestamp'>): void;
  getRecent(userId: string): InteractionEntry[];  // non-expired, newest first
}
```

**Implementation details:**
- `Map<string, InteractionEntry[]>` — per-user circular buffer, max 5 entries
- Lazy pruning: `getRecent()` filters out entries older than 10 minutes before returning
- No persistence — restarts clear the buffer (acceptable for short-lived context)
- No cross-user leakage — strict userId key isolation

### CoreServices Integration

Add to `CoreServices` interface:
```typescript
interactionContext?: InteractionContextService;
```

Apps that want to record interactions declare `interaction-context` in their manifest's `required_services`. Bootstrap injects the service instance.

### Food App Recording Points

Instrument these canonical write sites to call `services.interactionContext?.record()`:

| Action | Handler/Store | Entry shape |
|--------|--------------|-------------|
| Receipt photo captured | `photo.ts` handler after OCR + store write | `action: 'receipt_captured', entityType: 'receipt', filePaths: [receipt path]` |
| Recipe saved | handler calling `saveRecipe()` in `index.ts` | `action: 'recipe_saved', entityType: 'recipe', filePaths: [recipe path]` |
| Grocery list updated | handler calling grocery store in `index.ts` | `action: 'grocery_updated', entityType: 'grocery-list', filePaths: [list path]` |
| Meal plan finalized | meal plan handler in `index.ts` | `action: 'meal_plan_finalized', entityType: 'meal-plan', filePaths: [plan path]` |
| Price list updated | handler calling price store in `index.ts` | `action: 'price_updated', entityType: 'price-list', filePaths: [price path]` |

**Recording layer:** All recordings happen at handler call sites (which have access to `services`), NOT inside store functions (which only receive `ScopedDataStore`). This avoids threading `interactionContext` through every store function signature.

### Classifier Integration

**Chatbot `classifyPASMessage()`** — inject recent interaction summary into the classifier prompt. When recent entries exist, append a hint like:
```
Recent user actions: [receipt_captured (food app, 2 min ago), grocery_updated (food app, 5 min ago)]
```
This biases the classifier toward recognizing follow-up references ("those costs", "that list").

**DataQueryService** — extend `query()` signature:
```typescript
query(question: string, userId: string, options?: DataQueryOptions): Promise<DataQueryResult>;

interface DataQueryOptions {
  recentFilePaths?: string[];  // hint from InteractionContextService
}
```

When `recentFilePaths` is provided:
- Intersect with the authorized entry set (context is a hint, not an authorization bypass)
- Authorized matches get a `[recent interaction]` label in the LLM file-selection prompt to bias selection
- They are included in candidates regardless of keyword-overlap score (bypass Stage B pre-filter) but still go through the LLM selection step (Stage C)
- This ensures "those costs" with a recent receipt interaction reliably selects the receipt file

### Router Context-Aware Promotion

**Do NOT lower `confidenceThreshold` from 0.4 to 0.0.** The threshold stays at 0.4 for direct routing.

**Problem:** Today `IntentClassifier.classify()` returns `null` when below threshold — the router never sees the low-confidence result. To enable context promotion, we need the classifier to expose low-confidence results.

**Implementation:**
1. Add a new `IntentClassifier.classifyWithLowConfidence(text, intentTable)` method that returns the result regardless of confidence (or returns null only on error/no intents). This avoids changing the existing `classify()` contract.
2. In `Router.routeFreeText()`, when `classify()` returns null (below threshold):
   - Call `classifyWithLowConfidence()` to get the low-confidence result
   - Check `interactionContext.getRecent(userId)` for entries whose `appId` matches the result's appId
   - If match found AND `routeVerifier` is configured → enter verification path with the low-confidence result
   - If verifier confirms → route to app
   - If verifier disagrees, throws, or is not configured → fall back to chatbot
   - If no context match → fall through to chatbot (unchanged behavior)
3. The verifier prompt must receive interaction context. Add `recentInteractions?: string` to `VerificationPromptInput` and include it in `buildVerificationPrompt()` so the verifier knows about recent activity (e.g., "User recently captured a receipt in the food app").

**Safety invariants:**
- Low-confidence results NEVER direct-route without verifier confirmation
- No verifier configured → always fall through to chatbot (safe default)
- Verifier failure/throw → chatbot fallback

### App-Level Data Query Fallback

When an app's free-text handler can't match an intent, it should try DataQueryService before sending a generic error — but only when gated:

**Gate conditions** (either must be true):
1. Recent interaction context exists for this user + this app (within 10-min window)
2. Message contains data-question indicators (heuristic: starts with or contains "show", "what", "how much", "how many", "list", "tell me about")

**Response path:** Extract the shared answer-formatting logic from chatbot into a reusable `formatDataAnswer(question, dataResult, services)` utility. Food app's fallback calls this when the gate passes. The utility uses a standard-tier LLM call to synthesize a brief answer from file content.

**File:** New shared utility at `core/src/utils/data-answer-formatter.ts` (or inline in the chatbot, exported for reuse).

## Part 2: /edit Command

### Registration

`/edit` is added to the chatbot's `manifest.yaml` alongside `/ask`:
```yaml
commands:
  - command: /ask
    args: [question]
    description: "Ask about PAS apps, commands, system status, costs, models, or how things work"
  - command: /edit
    args: [description]
    description: "Edit a data file using natural language (e.g., /edit fix orange price at Costco to $4.99)"
```

The chatbot's `handleCommand()` dispatches `/edit` to a core `EditService`.

### EditService

**New file:** `core/src/services/edit/index.ts`

```typescript
interface EditProposal {
  kind: 'proposal';            // discriminant
  filePath: string;            // data-root-relative
  absolutePath: string;        // resolved absolute path (for write)
  appId: string;
  userId: string;
  description: string;         // original edit request
  scope: 'user' | 'shared' | 'space';
  spaceId?: string;
  beforeContent: string;
  afterContent: string;
  beforeHash: string;          // SHA-256 of beforeContent
  diff: string;                // human-readable inline diff
  expiresAt: number;           // Date.now() + 5 minutes
}

interface EditError {
  kind: 'error';               // discriminant
  message: string;             // user-facing status
  action: 'no_match' | 'ambiguous' | 'access_denied' | 'generation_failed';
}

type ProposeEditResult = EditProposal | EditError;

interface EditResult {
  success: boolean;
  message: string;
}

interface EditService {
  proposeEdit(description: string, userId: string): Promise<ProposeEditResult>;
  confirmEdit(proposal: EditProposal): Promise<EditResult>;
}
```

**Discriminated union:** `ProposeEditResult` uses `kind` field for clean type narrowing — no brittle shape checks.

Added to `CoreServices` as `editService?: EditService`. Chatbot declares `edit-service` in required_services.

### Edit Flow

1. **User sends** `/edit fix the price of oranges at Costco to $4.99`
2. **Chatbot** parses args, calls `editService.proposeEdit(description, userId)`
3. **File discovery:** EditService calls `DataQueryService.query(description, userId)` with interaction context hints. **Important:** DataQueryService returns truncated/stripped content for prompt use. EditService uses DataQuery ONLY for file discovery (path + appId), then re-reads the full raw file content for hashing, prompting, diffing, and writing.
4. **Ambiguity handling:**
   - 0 files → return `{ kind: 'error', action: 'no_match', message: "I couldn't find a matching data file. Try being more specific about which file to edit." }`
   - >1 files → return `{ kind: 'error', action: 'ambiguous', message: "Multiple files match. Please be more specific:\n- file1.md (food/recipes)\n- file2.md (food/prices)" }`
   - 1 file → proceed
5. **Write access check:** Verify the file's app manifest declares write access for the scope. Read-only files → return `{ kind: 'error', action: 'access_denied', message: "That file is read-only." }`
6. **Path safety:** Resolve absolute path via `realpath()`, verify it stays within the data directory (path containment check). This defends against symlink/junction escapes before any write.
7. **Generate edit:** Read full raw file content, send to standard-tier LLM with prompt:
   ```
   You are editing a data file. Return the complete updated file content.
   
   Current file ({filePath}):
   ---
   {currentContent}
   ---
   
   Edit request: {description}
   
   Rules:
   - Return ONLY the updated file content, nothing else
   - Preserve all existing formatting, frontmatter, and structure
   - Make the minimum change needed to fulfill the request
   - Do not add, remove, or modify anything not related to the request
   ```
7. **Compute diff:** Generate a human-readable before/after diff (unified diff format, truncated to fit Telegram message limits)
8. **Record proposal:** SHA-256 hash of current content, 5-minute expiry
9. **Return `EditProposal`** to chatbot

### Confirmation Flow

1. **Chatbot** formats the diff as a Telegram message:
   ```
   📝 Proposed edit to food/prices/costco.md:
   
   - oranges: $3.99/bag
   + oranges: $4.99/bag
   
   Confirm this edit?
   ```
2. **Chatbot** calls `telegram.sendOptions(userId, diffMessage, ['✓ Confirm', '✗ Cancel'])`
3. **On "✓ Confirm":** chatbot calls `editService.confirmEdit(proposal)`
   - Check expiry first (before any I/O)
   - Re-check authorization (user may have lost access during the 5-minute window)
   - Acquire per-path `AsyncLock` to serialize concurrent confirms on the same file
   - Re-read the file, compute SHA-256
   - If hash matches `beforeHash` → atomic write → record change log entry → emit `data:changed` event → log to audit → release lock → return success
   - If hash mismatch → return `{ success: false, message: "File was modified since the preview. Please try /edit again." }`
   - If past `expiresAt` → return `{ success: false, message: "Edit expired (5-minute limit). Please try /edit again." }`
   - **Per-path lock:** The lock covers re-read → hash compare → atomic write → post-write side effects. Without it, two concurrent confirms could both pass the hash check. Uses `AsyncLock` (existing utility at `core/src/utils/async-lock.ts`).
   - **Infrastructure side effects:** Since EditService bypasses app-scoped stores, it must directly emit `data:changed` event (for FileIndexService re-indexing) and write a change log entry (for daily diffs). Otherwise /edit writes won't appear in future data queries or daily diff summaries.
4. **On "✗ Cancel" or timeout:** chatbot sends "Edit cancelled." Log to audit with `action: 'cancelled'`.

### Write Access Validation

EditService maintains its own authorization check, independent of app-scoped stores:

1. Look up the file's `appId` from `FileIndexService` entry
2. Load that app's manifest scopes
3. Check if the file path falls within a `read-write` or `write` scope for that app
4. Check user ownership: user-scoped files require userId match; shared-scoped files require household membership; space-scoped files require space membership

This reuses the same authorization logic as `DataQueryService.getAuthorizedEntries()` but adds the write-access check on top. Manifest scopes with `read-write` or `write` mode are write-eligible. Read-only scopes are not. The authorization method should be extracted into a shared utility (or EditService calls into DataQueryService/FileIndexService for the authorized-entries list and then filters for write-eligible scopes).

### Audit Log

**File:** `data/system/edit-log.jsonl` (append-only JSONL, consistent with `change-log.jsonl`)

Each line:
```json
{"timestamp":"2026-04-14T10:30:00.000Z","userId":"matt","filePath":"users/shared/food/prices/costco.md","appId":"food","action":"confirmed","beforeHash":"abc123...","afterHash":"def456...","description":"fix the price of oranges at Costco to $4.99"}
```

Actions: `confirmed`, `cancelled`, `stale_rejected`, `expired`, `no_match`, `access_denied`.

Written via `appendFile()` (same pattern as `ChangeLog`).

### Constraints

- **One file per edit** — no batch edits in v1
- **No structural changes** — /edit modifies content within existing files, does not create/delete/rename files
- **5-minute proposal expiry** — prevents stale edits
- **SHA-256 stale-write guard** — prevents lost updates from concurrent modification
- **Standard-tier LLM** — edit generation uses standard tier (not fast) for quality

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `core/src/services/interaction-context/index.ts` | InteractionContextService implementation |
| `core/src/services/interaction-context/__tests__/interaction-context.test.ts` | Service unit tests |
| `core/src/services/edit/index.ts` | EditService implementation |
| `core/src/services/edit/__tests__/edit-service.test.ts` | Service unit tests |
| `core/src/utils/data-answer-formatter.ts` | Shared data answer formatting utility |
| `core/src/utils/diff.ts` | Simple unified diff generator for edit previews |

### Modified Files
| File | Change |
|------|--------|
| `core/src/types/app-module.ts` | Add `interactionContext?` and `editService?` to CoreServices |
| `core/src/types/data-query.ts` | Add `DataQueryOptions` type, extend `query()` signature |
| `core/src/services/data-query/index.ts` | Accept `options.recentFilePaths`, intersect with authorized entries |
| `core/src/services/router/index.ts` | Context-aware low-confidence promotion to verifier |
| `core/src/bootstrap.ts` | Create and inject InteractionContextService + EditService |
| `apps/chatbot/manifest.yaml` | Add `/edit` command, add `interaction-context` + `edit-service` to required_services |
| `apps/chatbot/src/index.ts` | Handle `/edit` command, inject context into classifier, export `formatDataAnswer` |
| `apps/food/manifest.yaml` | Add `interaction-context` to required_services |
| `apps/food/src/index.ts` | Record interactions at write sites, add data query fallback gate |
| `apps/food/src/handlers/photo.ts` | Record receipt_captured interaction |
| `core/src/services/router/intent-classifier.ts` | Add `classifyWithLowConfidence()` method |
| `core/src/services/llm/prompt-templates.ts` | Add `recentInteractions` to `VerificationPromptInput` |

## Verification

### Automated Tests

**InteractionContextService:**
- Record + retrieve entries for a user
- Entries expire after 10 minutes (use fake timers)
- Buffer caps at 5 entries (oldest evicted)
- User A cannot see User B's entries
- `getRecent()` returns newest-first order

**Classifier integration:**
- Recent interaction context biases classification toward the recent app
- Expired context does not affect classification
- Unrelated newer interaction does not hijack references

**Router context promotion:**
- Low-confidence match with matching interaction context → enters verifier
- Low-confidence match without context → falls through to chatbot (unchanged)
- Verifier disagreement with context promotion → chatbot fallback

**DataQueryService context hints:**
- `recentFilePaths` that are authorized get priority inclusion
- `recentFilePaths` that are not authorized are silently dropped
- Works correctly when `options` is omitted (backwards compatible)

**Router context promotion:**
- Verifier failure/throw below 0.4 → chatbot fallback (not crash)
- Low-confidence result never direct-routes without verifier confirmation
- Verifier receives interaction context in its prompt

**EditService:**
- Propose edit finds correct file, generates valid diff
- Propose edit re-reads full raw file (not DataQuery's truncated content)
- Confirm edit with matching hash → write succeeds
- Confirm edit with mismatched hash → stale rejection
- Confirm edit past expiry → expiry rejection
- Confirm re-checks authorization (membership could change during 5-min window)
- Read-only file → access denied
- User cannot edit another user's personal data
- Shared file editable by household members
- Cancel → no file modification
- Audit log records all outcomes
- Empty/missing file → appropriate error message
- Realpath/path containment check on write (symlink escape defense)
- `data:changed` event emitted after write (FileIndexService re-indexes)
- Change log entry written after write (daily diffs see the edit)
- Concurrent confirms on same file serialized by AsyncLock (second confirm sees updated hash)
- Prompt injection in editable file content does not break LLM edit generation
- LLM returns no-change output → detected, user told "no changes needed"
- LLM returns oversized/malformed output → rejected with error message
- `ProposeEditResult` discriminated union: `kind: 'proposal'` vs `kind: 'error'`

**App-level fallback:**
- Food app fallback with recent context → DataQueryService called
- Food app fallback without context and no question indicators → original fallback
- Food app fallback with question indicators → DataQueryService called

### Manual Verification
1. Send a receipt photo, then "show me those costs" → resolves to receipt data
2. Wait 11 minutes, send "show me those costs" → asks for clarification
3. `/edit fix orange price at Costco to $4.99` → shows diff preview
4. Tap Confirm → file updated, audit logged
5. Tap Cancel → no change
6. `/edit` targeting a read-only scope → rejected with message
7. `/edit` with ambiguous target → asks user to be more specific
