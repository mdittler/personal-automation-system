# Food Phase H2a: Grocery Lists + Basic Pantry

## Context

Phase H1 built the foundation: household CRUD, recipe storage/search/editing, food questions. Users can save and find recipes, but can't yet turn them into actionable grocery lists or track what they have on hand. H2a makes Food practically useful for meal planning by adding the grocery-to-shopping workflow and basic pantry awareness.

## Scope

**9 requirements** from the full H2 set:

| ID | Name | Summary |
|----|------|---------|
| GL-1 | Recipe-to-grocery | Aggregate ingredients from recipes into a grocery list |
| GL-2 | Staples handling | Exclude assumed-on-hand items (configurable) |
| GL-3 | Manual item addition | "add milk and eggs" parsed and added |
| GL-5 | Shared grocery list | Household members share one list |
| GL-6 | Duplicate removal | Exact + LLM fuzzy dedup, "Add all" batch option |
| GL-7 | View current list | Inline keyboard grouped by department |
| GL-8 | Interactive shopping | Tap-to-toggle checkboxes, refresh, clear purchased |
| PI-1 | Pantry tracker | Text input + inference from grocery purchases |
| PI-3 | Auto-exclude from grocery | Skip pantry items when generating grocery lists |

**Deferred to H2b:** GL-4 (photo-to-grocery), GL-9 (shopping follow-up), GL-10 (store pricing), GL-11 (store config), PI-2 ("what can I make?"), PI-4 (expiry alerts), PI-5 (freezer).

## Infrastructure Changes

### Problem

The current `TelegramService` only offers `sendOptions()` — a one-shot "pick one" mechanism. Grocery list checkboxes need:
- Custom inline keyboards with arbitrary callback data
- Message editing to update checkmarks in-place
- Multi-click handling on the same message
- App-level callback routing

### New Types

**File: `core/src/types/telegram.ts`**

```typescript
/** Button for custom inline keyboards. */
export interface InlineButton {
  text: string;
  callbackData: string; // max 64 bytes (Telegram limit)
}

/** Identifies a sent message for later editing. */
export interface SentMessage {
  chatId: number;
  messageId: number;
}

/** Context passed to app callback handlers. */
export interface CallbackContext {
  userId: string;
  chatId: number;
  messageId: number; // the message the button was on
}
```

### TelegramService Extensions

```typescript
// Added to TelegramService interface:
sendWithButtons(userId: string, text: string, buttons: InlineButton[][]): Promise<SentMessage>;
editMessage(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<void>;
```

- `buttons: InlineButton[][]` — outer array = rows, inner = buttons per row
- `editMessage` handles Telegram's "message is not modified" error gracefully (no-op)

### AppModule Extension

```typescript
// Added to AppModule interface (optional):
handleCallbackQuery?(data: string, ctx: CallbackContext): Promise<void>;
```

The `data` parameter is the app-specific portion after prefix stripping.

### Callback Routing

**Callback data format:** `app:<appId>:<custom-data>`

Examples: `app:food:toggle:3`, `app:food:refresh`, `app:food:clear`

**Bootstrap routing** (extends existing `bot.on('callback_query:data')`):
1. If prefix is `opt:` — existing `sendOptions()` handling (unchanged)
2. If prefix is `app:` — extract appId + custom data, look up app in registry, verify `isAppEnabled`, call `handleCallbackQuery(customData, callbackCtx)`
3. Wrap in `llmContext.run({ userId })` for cost attribution
4. Always call `answerCallbackQuery()`

### Mock Updates

`createMockCoreServices()` gains:
- `sendWithButtons: vi.fn().mockResolvedValue({ chatId: 123, messageId: 456 })`
- `editMessage: vi.fn().mockResolvedValue(undefined)`

## Grocery List Design

### Data Model

Storage: `grocery/active.yaml` in shared scope (`data/users/shared/food/grocery/active.yaml`).

Uses existing `GroceryList` and `GroceryItem` types from `types.ts` — no changes needed.

Archive: when purchased items are cleared, they're saved to `grocery/history/YYYY-MM-DD.yaml` for future reference.

### Departments (Hardcoded)

```
Produce, Dairy & Eggs, Meat & Seafood, Bakery, Frozen,
Pantry & Dry Goods, Beverages, Snacks, Household, Other
```

Department assignment: local lookup table for common items (200+ mappings). LLM assigns departments for unknown items during recipe-to-grocery conversion (fast tier, bundled with dedup call).

### Recipe-to-Grocery Flow (GL-1 + GL-2 + PI-3)

1. User: "generate grocery list for chicken stir fry and pasta primavera"
2. Load recipes from shared store (reuse `searchRecipes()` + `findRecipeByTitle()`)
3. Aggregate all ingredients across recipes (local)
4. Exact-match merge (normalized lowercase + same unit)
5. Load pantry → exclude items already on hand (PI-3), note exclusions
6. Filter staples (from user config `staple_items`) → note exclusions
7. LLM dedup pass (fast tier) for remaining fuzzy matches + department assignment for unknowns
8. Save to `grocery/active.yaml`
9. Send summary: list + "Skipped: salt, pepper (staples), olive oil (in pantry). Add anyway?" with per-item inline buttons + "Add all skipped" button

### Manual Add Flow (GL-3)

1. User: "add milk and eggs" or `/addgrocery milk, eggs, 2 lbs chicken`
2. Local parse: split on comma/and/newline, extract quantity+unit+name via regex
3. Assign departments from lookup table
4. Check for exact duplicates against current list (merge quantities)
5. If ambiguous duplicates exist, LLM fuzzy check (fast tier)
6. Add to `grocery/active.yaml`
7. Confirm: "Added 3 items to grocery list"

### View List Flow (GL-7 + GL-8)

User sends `/grocery` → bot replies with inline keyboard message:

```
🛒 Grocery List (12 items)

🥬 Produce
☐ Broccoli — 2 cups
☐ Onion — 1
✅ Carrots — 1 lb

🥛 Dairy & Eggs
☐ Milk — 1 gallon
☐ Eggs — 1 dozen
```

**Inline keyboard below the message:**
- One button per item: tap toggles `☐` ↔ `✅`
- Bottom row: `[🔄 Refresh]` `[🗑 Clear ✅]` `[📦 → Pantry]`

Each button tap:
1. Reads `grocery/active.yaml`
2. Toggles `purchased` on the item
3. Saves back
4. Calls `editMessage()` to update the display in-place

**Refresh button:** Re-reads YAML and re-renders (shows partner's changes).

**Clear purchased:** Removes all `purchased: true` items. Prompts: "Add purchased items to pantry?" with `[Add all]` `[Skip]` buttons.

**Pagination:** If list exceeds 50 items (unlikely), show first 50 with "Next page" button. Telegram allows max 100 buttons per message.

### Deduplication (GL-6)

Two tiers:
1. **Exact match** (local, free): normalize to lowercase, compare name. Merge quantities if units match.
2. **Fuzzy match** (LLM, fast tier): for items that look similar but aren't exact ("chicken breast" vs "boneless chicken"). LLM returns merge suggestions. Applied during recipe-to-grocery and manual add.

User confirmation for fuzzy merges via inline buttons: `[Merge "chicken breast" + "boneless chicken"]` `[Keep separate]`

### Staples (GL-2)

Default: `salt, pepper, olive oil, butter, garlic` (configurable via `staple_items` user config).

During recipe-to-grocery, staple ingredients are excluded with summary and per-item "Add anyway" buttons.

## Pantry Design

### Data Model

Storage: `pantry.yaml` in shared scope. Uses existing `PantryItem` type.

### Adding Items (PI-1)

Two input methods in H2a:

1. **Text:** "add to pantry: eggs, milk, chicken" → parse items, add with `addedDate: today`, auto-assign `category` from department lookup
2. **Grocery inference:** When clearing purchased grocery items, offer "Add all to pantry" button. Converts `GroceryItem[]` → `PantryItem[]`.

### Auto-Exclude from Grocery (PI-3)

During recipe-to-grocery generation (step 5 of the flow above):
- Load pantry items
- For each recipe ingredient, check if pantry contains a match (case-insensitive)
- Exclude matches, append to exclusion summary
- User can override via "Add anyway" buttons (same UI as staples)

### View Pantry

`/pantry` shows current inventory grouped by category. Plain text (no inline keyboard needed for now — pantry is less frequently interacted with than grocery).

```
📦 Pantry (8 items)

🥬 Produce
• Onions — about 3
• Garlic — 1 head

🥛 Dairy & Eggs
• Eggs — 1 dozen
• Butter — 1 stick
```

Pantry modification via text: "remove eggs from pantry", "update eggs to 2 dozen".

## New Files

### Infrastructure (core/)
| File | Purpose |
|------|---------|
| `core/src/types/telegram.ts` | Add InlineButton, SentMessage, CallbackContext; extend TelegramService, AppModule |
| `core/src/services/telegram/index.ts` | Implement sendWithButtons, editMessage |
| `core/src/bootstrap.ts` | Extend callback routing for `app:*` prefix |
| `core/src/testing/mock-services.ts` | Add mocks for new methods |
| `core/src/services/telegram/__tests__/telegram-buttons.test.ts` | Tests for new methods + routing |

### Food App (apps/food/)
| File | Purpose |
|------|---------|
| `src/services/grocery-store.ts` | Grocery list CRUD, formatting, button generation |
| `src/services/grocery-dedup.ts` | LLM fuzzy dedup + department assignment |
| `src/services/grocery-generator.ts` | Recipe-to-grocery pipeline (aggregation, staples, pantry check, dedup) |
| `src/services/pantry-store.ts` | Pantry CRUD, contains check, grocery-to-pantry conversion |
| `src/services/item-parser.ts` | Local text parsing for "2 lbs chicken, milk, eggs" |
| `src/index.ts` | New commands, intents, handleCallbackQuery |
| `src/__tests__/grocery-store.test.ts` | Grocery CRUD + formatting + buttons |
| `src/__tests__/grocery-dedup.test.ts` | LLM dedup, sanitization, errors |
| `src/__tests__/grocery-generator.test.ts` | Full pipeline, staples, pantry exclusion |
| `src/__tests__/pantry-store.test.ts` | Pantry CRUD, contains, conversion |
| `src/__tests__/item-parser.test.ts` | Parsing various input formats |

## Intent Detection

New functions in `index.ts`:

- `isGroceryViewIntent(text)` — "show grocery list", "what do we need", "grocery"
- `isGroceryAddIntent(text)` — "add milk to grocery", "we need eggs", "put X on the list"
- `isGroceryGenerateIntent(text)` — "make grocery list for X", "generate grocery list from X"
- `isPantryViewIntent(text)` — "what's in the pantry", "show pantry"
- `isPantryAddIntent(text)` — "add X to pantry", "we have X"
- `isPantryRemoveIntent(text)` — "remove X from pantry", "we're out of X"

## Callback Data Reference

| Callback Data | Action |
|--------------|--------|
| `app:food:toggle:<index>` | Toggle purchased on grocery item |
| `app:food:refresh` | Re-render grocery list |
| `app:food:clear` | Clear purchased items |
| `app:food:pantry-all` | Add all purchased items to pantry |
| `app:food:pantry-skip` | Skip pantry addition |
| `app:food:staple-add:<name>` | Add excluded staple to grocery list |
| `app:food:staple-all` | Add all excluded staples |
| `app:food:exclude-add:<name>` | Add excluded pantry item to grocery |

## Security Considerations

- `sanitizeInput()` on all LLM prompts (dedup, department assignment)
- Anti-instruction framing on all user-content-containing prompts
- Callback data validated: index bounds checked, names validated against current list state
- `classifyLLMError()` on all LLM catch blocks with user-friendly messages
- Household membership enforced via `requireHousehold()` on all operations
- Frontmatter on all YAML writes

## Testing Strategy

Each test file covers: standard (happy path), edge (empty list, single item, 0-quantity, no department match), error (malformed YAML, LLM failure), security (sanitization, invalid callback data), state transitions (toggle on/off, clear then re-add).

Estimated: ~100-130 new tests across 6-7 test files.

## Verification

1. `pnpm build` — no TypeScript errors
2. `pnpm lint` — no Biome issues
3. `pnpm test` — all tests pass (existing + new)
4. Manual: send `/grocery` in Telegram → see inline keyboard → tap items → see checkmarks update
5. Manual: "generate grocery list for [recipe]" → see department-grouped list with staple/pantry exclusions
6. Manual: second household member sends `/grocery` → sees same list state
