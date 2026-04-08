# Food H6: Food Lifecycle — Leftovers, Freezer, Waste & Perishable Alerts

## Context

Phases H1–H5b cover the "before and during" of cooking: recipes, grocery lists, pantry, meal planning, voting, ratings, and cook mode. But nothing tracks what happens *after* — leftovers sitting in the fridge, perishables approaching expiry, or freezer items forgotten for months.

H6 adds the food lifecycle layer: tracking leftovers, managing freezer inventory, logging waste, and proactively alerting household members to "freeze it now or lose it." These four systems are interconnected — a leftover can be frozen, a pantry item can be rescued before expiry, and anything wasted gets logged for awareness.

## Requirements

### REQ-LO: Leftover Tracking

- **REQ-LO-001**: Users can log leftovers manually via `/leftovers <description>` or natural language ("we have leftover chili")
- **REQ-LO-002**: After rating a cooked meal (nightly 8pm prompt), app asks "Any leftovers?" with Yes/No buttons. Yes triggers leftover logging with recipe name pre-filled
- **REQ-LO-003**: After cook mode ends (done callback), same leftover prompt
- **REQ-LO-004**: `/leftovers` (no args) shows all active leftovers with per-item action buttons: Use, Freeze, Toss
- **REQ-LO-005**: LLM estimates fridge shelf life when a leftover is created; stored as `expiryEstimate` ISO date
- **REQ-LO-006**: Status transitions: `active` → `used` (eaten), `active` → `frozen` (creates FreezerItem), `active` → `wasted` (logs WasteLogEntry)
- **REQ-LO-007**: Natural language support for status changes ("we ate the leftover chili", "freeze the chili", "throw out the soup")

### REQ-FZ: Freezer Management

- **REQ-FZ-001**: `/freezer` (no args) shows all frozen items with age indicators and per-item buttons: Thaw, Toss
- **REQ-FZ-002**: `/freezer <description>` adds an item directly
- **REQ-FZ-003**: Items enter freezer from three sources: leftovers (freeze action), pantry (perishable alert freeze action), or manual add
- **REQ-FZ-004**: `source` field tracks origin (recipe name, "pantry", or "purchased")
- **REQ-FZ-005**: Items frozen 3+ months get ⚠️ quality warning marker in display
- **REQ-FZ-006**: Natural language: "add chicken to freezer", "what's in the freezer?", "thaw the chili"

### REQ-WL: Waste Logging

- **REQ-WL-001**: Waste entries are append-only — no editing or deletion
- **REQ-WL-002**: Waste is recorded automatically when: leftovers expire (daily job), user taps Toss on any item
- **REQ-WL-003**: Waste is recorded via natural language: "the milk went bad", "threw out the old rice"
- **REQ-WL-004**: Each entry tracks: name, quantity, reason (expired/spoiled/discarded), source (leftover/pantry/freezer), date
- **REQ-WL-005**: No standalone `/waste` command in H6 — data is collected for future reporting. Waste is logged silently with a brief confirmation message

### REQ-PA: Perishable Alerts

- **REQ-PA-001**: Daily 9am job checks pantry items with `expiryEstimate` within 2 days of expiry
- **REQ-PA-002**: Alert message shows expiring items with action buttons: Move to Freezer, Still Good, Toss
- **REQ-PA-003**: "Move to Freezer" removes from pantry and creates FreezerItem with `source: 'pantry'`
- **REQ-PA-004**: "Toss" removes from pantry and logs WasteLogEntry
- **REQ-PA-005**: "Still Good" dismisses the alert for that item (no data change)
- **REQ-PA-006**: When perishable items are added to pantry (categories: Produce, Dairy & Eggs, Meat & Seafood, Bakery), estimate expiry via LLM if not already set

### REQ-LC: Leftover Check (Daily Alert)

- **REQ-LC-001**: Daily 10am job checks active leftovers against `expiryEstimate`
- **REQ-LC-002**: Items past expiry are auto-transitioned to `wasted` and logged to waste log
- **REQ-LC-003**: Items expiring today/tomorrow get "freeze it or lose it" alert with buttons: Freeze, We'll Eat It, Toss
- **REQ-LC-004**: Alert sent to all household members
- **REQ-LC-005**: No alert sent if no active leftovers exist

### REQ-FC: Freezer Check (Weekly Reminder)

- **REQ-FC-001**: Monday 9am job checks for items frozen 3+ months
- **REQ-FC-002**: Sends informational reminder listing aging items — no action buttons needed
- **REQ-FC-003**: No message sent if no aging items exist

## Data Model

### Existing Types (no changes needed)

```typescript
// types.ts — already defined
interface Leftover {
  name: string;
  quantity: string;
  fromRecipe?: string;
  storedDate: string;       // ISO date
  expiryEstimate: string;   // ISO date, LLM-estimated
  status: 'active' | 'used' | 'frozen' | 'wasted';
}

interface FreezerItem {
  name: string;
  quantity: string;
  frozenDate: string;       // ISO date
  source?: string;          // recipe name, "pantry", or "purchased"
}
```

### New Type

```typescript
// types.ts — add
interface WasteLogEntry {
  name: string;
  quantity: string;
  reason: 'expired' | 'spoiled' | 'discarded';
  source: 'leftover' | 'pantry' | 'freezer';
  date: string;             // ISO date
}
```

### Data Files (all shared scope, already declared in manifest)

| File | Format | Root structure |
|------|--------|----------------|
| `leftovers.yaml` | YAML + frontmatter | `{ items: Leftover[] }` |
| `freezer.yaml` | YAML + frontmatter | `{ items: FreezerItem[] }` |
| `waste-log.yaml` | YAML + frontmatter | `{ entries: WasteLogEntry[] }` |

## Architecture

### Service Layer

#### `services/leftover-store.ts`

```typescript
// Data access
loadLeftovers(store): Promise<Leftover[]>
saveLeftovers(store, items): Promise<void>

// Mutations (pure functions on arrays)
addLeftover(existing, item): Leftover[]
updateLeftoverStatus(items, index, status): Leftover[]

// Queries
getActiveLeftovers(items): Leftover[]
getExpiringLeftovers(items, withinDays, today): Leftover[]

// Formatting
formatLeftoverList(items): string
buildLeftoverButtons(items): InlineButton[][]

// Parsing
parseLeftoverInput(text, fromRecipe?, timezone): Omit<Leftover, 'expiryEstimate'>

// LLM
estimateFridgeExpiry(services, foodName): Promise<string>  // returns ISO date
```

#### `services/freezer-store.ts`

```typescript
loadFreezer(store): Promise<FreezerItem[]>
saveFreezer(store, items): Promise<void>

addFreezerItem(existing, item): FreezerItem[]
removeFreezerItem(items, index): FreezerItem[]

getAgingFreezerItems(items, olderThanMonths, today): FreezerItem[]

formatFreezerList(items): string
buildFreezerButtons(items): InlineButton[][]

parseFreezerInput(text, source?, timezone): FreezerItem
```

#### `services/waste-store.ts`

```typescript
loadWasteLog(store): Promise<WasteLogEntry[]>
appendWaste(store, entry): Promise<void>

formatWasteSummary(entries, periodDays): string
```

### Handler Layer

#### `handlers/leftover-handler.ts`

- `handleLeftoverCallback(services, action, userId, chatId, messageId, store)` — routes `use:<idx>`, `freeze:<idx>`, `toss:<idx>`, `add`, `post-meal:yes`, `post-meal:no`, `keep:<idx>` sub-actions
- `handleLeftoverCheckJob(services, todayOverride?)` — daily 10am cron: auto-waste expired, alert on expiring

#### `handlers/freezer-handler.ts`

- `handleFreezerCallback(services, action, userId, chatId, messageId, store)` — routes `thaw:<idx>`, `toss:<idx>`, `add` sub-actions
- `handleFreezerCheckJob(services, todayOverride?)` — Monday 9am: remind about aging items

#### `handlers/perishable-handler.ts`

- `handlePerishableCallback(services, action, userId, chatId, messageId, store)` — routes `freeze:<idx>`, `ok:<idx>`, `toss:<idx>` sub-actions
- `handlePerishableCheckJob(services, todayOverride?)` — daily 9am: check pantry expiry

### Routing in `index.ts`

#### Commands

```typescript
case 'leftovers':
  await handleLeftoversCommand(args, ctx);
  break;
case 'freezer':
  await handleFreezerCommand(args, ctx);
  break;
```

#### Callback Prefixes

| Prefix | Handler | Examples |
|--------|---------|----------|
| `lo:` | `handleLeftoverCallback` | `lo:use:0`, `lo:freeze:1`, `lo:toss:2`, `lo:add`, `lo:post-meal:yes` |
| `fz:` | `handleFreezerCallback` | `fz:thaw:0`, `fz:toss:1`, `fz:add` |
| `pa:` | `handlePerishableCallback` | `pa:freeze:0`, `pa:ok:1`, `pa:toss:2` |

Index-based addressing (matching existing `toggle:<index>` pattern for grocery items).

#### Intent Detection

Check before the broad food-question intent, after cook mode intercepts:

- **Leftover add**: "we have leftover chili", "save the remaining pasta", "there's leftover soup"
- **Leftover view**: "show leftovers", "any leftovers?", "what's left over?"
- **Freezer**: "add chicken to freezer", "what's in the freezer?", "freeze the chili"
- **Waste**: "the milk went bad", "threw out the rice", "food spoiled"

#### Scheduled Job Dispatch

```typescript
if (jobId === 'perishable-check') {
  await handlePerishableCheckJob(services);
  return;
}
if (jobId === 'leftover-check') {
  await handleLeftoverCheckJob(services);
  return;
}
if (jobId === 'freezer-check') {
  await handleFreezerCheckJob(services);
  return;
}
```

### Pending State

Following existing patterns (`pendingPantryItems` map with 5-min TTL):

```typescript
const pendingLeftoverAdd = new Map<string, { fromRecipe?: string; expiresAt: number }>();
const pendingFreezerAdd = new Map<string, { expiresAt: number }>();
```

Checked in `handleMessage` before other intent detection, same position as existing `hasPendingCookRecipe` check.

## UX Details

### `/leftovers` View

```
🥘 Leftovers (3 active)

• Chili — ~3 servings (from Beef Chili)
  📅 Stored Mar 31 · Expires Apr 3

• Rice — about 2 cups
  📅 Stored Mar 31 · Expires Apr 2 ⚠️

• Soup — 1 container (from Chicken Soup)
  📅 Stored Mar 29 · Expires Apr 1 ❌

[➕ Add Leftovers]
[✅ Use: Chili]  [🧊 Freeze: Chili]  [🗑 Toss: Chili]
[✅ Use: Rice]   [🧊 Freeze: Rice]   [🗑 Toss: Rice]
[✅ Use: Soup]   [🧊 Freeze: Soup]   [🗑 Toss: Soup]
```

Expiry indicators: ⚠️ = expires tomorrow, ❌ = expires today or past

### `/freezer` View

```
🧊 Freezer (5 items)

• Chicken breasts — 2 lbs (purchased)
  📅 Frozen Mar 15

• Beef Chili — ~4 servings (from Beef Chili)
  📅 Frozen Mar 20

• Banana bread — 1 loaf (homemade)
  📅 Frozen Jan 10 ⚠️ 2+ months

[➕ Add to Freezer]
[🔥 Thaw: Chicken]  [🗑 Toss: Chicken]
[🔥 Thaw: Chili]    [🗑 Toss: Chili]
[🔥 Thaw: Banana]   [🗑 Toss: Banana]
```

### Leftover Check Alert (daily 10am)

```
⚠️ Leftovers Alert!

❌ Expired (logged as waste):
• Soup — 1 container (from Chicken Soup)

🔥 Use today or freeze:
• Rice — about 2 cups (expires today)
  [🧊 Freeze it] [✅ We'll eat it] [🗑 Toss it]

⏰ Expiring tomorrow:
• Chili — ~3 servings (from Beef Chili)
  [🧊 Freeze it] [✅ Got it]
```

### Perishable Alert (daily 9am)

```
🥬 Perishable Alert!

Items approaching expiry in your pantry:

• Chicken breasts — 1 lb (expires tomorrow)
  [🧊 Move to Freezer] [👍 Still good]

• Yogurt — 2 cups (expires today)
  [🗑 Toss] [👍 Still good]
```

### Freezer Check (Monday 9am)

```
🧊 Freezer Check

These items have been frozen a while — consider using them soon:

• Banana bread — frozen 2+ months (Jan 10)
• Chicken stock — frozen 3+ months (Dec 15)

Use /freezer to manage your inventory.
```

### Post-Rating Leftover Prompt

```
Any leftovers from tonight's Beef Chili?
[Yes, log leftovers] [No leftovers]
```

## Integration Points

### Rating Flow (modify `handlers/rating.ts`)

After `handleRateCallback` records the rating, send leftover prompt to the user who rated. Callback prefix: `lo:post-meal:yes` / `lo:post-meal:no`. On "yes", set pending state with `fromRecipe` pre-filled.

### Cook Mode (modify `handlers/cook-mode.ts`)

When cook session ends via the done callback, send same leftover prompt with recipe name pre-filled.

### Pantry Enrichment (modify `services/pantry-store.ts`)

When items are added to pantry (the `pantry-all` flow after grocery clear), estimate expiry for perishable categories via LLM:
- **Estimate**: Produce, Dairy & Eggs, Meat & Seafood, Bakery
- **Skip**: Pantry & Dry Goods, Beverages, Snacks, Household, Frozen (already in freezer context)

Add a new function: `enrichWithExpiry(services, items): Promise<PantryItem[]>` — calls LLM for each perishable item without `expiryEstimate`.

### Cross-Store Operations

"Move to freezer" from perishable alert or leftover freeze:
1. Remove item from source store (pantry or leftovers)
2. Create FreezerItem with appropriate `source`
3. Save both stores
4. Confirm to user

## LLM Usage

| Purpose | Prompt | Tier |
|---------|--------|------|
| Leftover expiry estimation | "How many days does {food} last in the fridge? Reply with just a number." | fast |
| Pantry expiry estimation | Same prompt, for perishable categories | fast |

Estimated: ~2–5 LLM calls per day. Well within rate/cost limits.

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `src/services/leftover-store.ts` | Leftover CRUD, formatting, expiry |
| `src/services/freezer-store.ts` | Freezer CRUD, formatting, aging |
| `src/services/waste-store.ts` | Append-only waste log |
| `src/handlers/leftover-handler.ts` | Leftover callbacks + daily check job |
| `src/handlers/freezer-handler.ts` | Freezer callbacks + Monday check job |
| `src/handlers/perishable-handler.ts` | Perishable callbacks + daily pantry check |
| `src/__tests__/services/leftover-store.test.ts` | Unit tests |
| `src/__tests__/services/freezer-store.test.ts` | Unit tests |
| `src/__tests__/services/waste-store.test.ts` | Unit tests |
| `src/__tests__/handlers/leftover-handler.test.ts` | Handler tests |
| `src/__tests__/handlers/freezer-handler.test.ts` | Handler tests |
| `src/__tests__/handlers/perishable-handler.test.ts` | Handler tests |

### Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `WasteLogEntry` interface |
| `src/index.ts` | Commands, callback routing, intent detection, job dispatch, pending state maps |
| `src/handlers/rating.ts` | Post-rating leftover prompt |
| `src/handlers/cook-mode.ts` | Post-cook leftover prompt |
| `src/services/pantry-store.ts` | Expiry estimation for perishable items |

## Deferred Items

- **Waste reporting** (`/waste` command with monthly summaries) — defer to future phase
- **Meal plan awareness** (suggest meals based on leftovers/freezer inventory) — defer to future phase
- **Smart freeze suitability** (warn about foods that don't freeze well) — optional future enhancement
- **Nutrition tracking for waste** (cost of wasted food) — defer to nutrition phase
- **Batch expiry estimation** (estimate multiple items in one LLM call) — optimization if needed

## Verification

1. **Unit tests**: All store functions tested with mock data
2. **Handler tests**: Each callback action tested, each scheduled job tested with mock stores
3. **Integration**: Natural language routing for all intent patterns
4. **Manual testing**:
   - `/leftovers` with no items, with items, with expiring items
   - `/freezer` with no items, with items, with aging items
   - Freeze a leftover → verify it appears in `/freezer`
   - Toss items → verify waste log entries
   - Rate a meal → verify leftover prompt appears
   - Add perishables to pantry → verify expiry estimation
   - Wait for scheduled jobs (or trigger manually) → verify alerts
