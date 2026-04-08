# H10: Cost Tracking and Store Pricing — Design Spec

## Context

Food already captures receipt data via photo parsing (H8) and generates meal plans (H3) and grocery lists (H2). Users have no visibility into food costs — what meals cost, how spending trends over time, or whether a meal plan is expensive relative to their history. H10 adds a cost tracking layer that connects receipt data to recipes, meal plans, and grocery lists.

## Requirements

| ID | Description |
|----|-------------|
| REQ-COST-002 | Cost-per-meal estimates using price database + LLM semantic matching |
| REQ-COST-003 | Weekly/monthly/yearly spend reports via `/foodbudget` command |
| REQ-COST-004 | Budget alerts inline with meal plan generation |
| REQ-GROCERY-010 | Store-aware pricing annotations on grocery lists |
| REQ-GROCERY-011 | Store configuration (preferred_stores, default_store, show_price_estimates) |

## Architecture

### Data Flow

```
Receipt photos ──→ H8 parser ──→ Price Store (auto-update) ──→ Price Database (.md files)
Text messages ────→ Intent parse ──→ Price Store (manual update) ──↗
Manual Obsidian edit ──────────────────────────────────────────────↗
                                                                   │
Recipe ingredients ──→ Cost Estimator ←── Price Database ──────────┘
                           │                    ↑
                           │               LLM semantic match
                           │               + unit conversion
                           ↓
                    ┌──────┴──────┐
                    │             │
              Budget Reporter  Budget Alerts
              (weekly/monthly/ (inline with
               yearly reports)  meal plans)
```

### Key Design Decision: Price DB First, LLM Fallback

The LLM is used for semantic matching ("2 cups AP flour" → "AP flour (25 lb) @ $8.99") and unit conversion, NOT for price estimation. Prices come from the user's own receipt history and manual entries. LLM-estimated prices are only used as a fallback when no price data exists for an ingredient, and are clearly marked as estimates.

## New Services

### 1. price-store.ts

Per-store price database CRUD. Manages Obsidian-compatible .md files in `shared/prices/`.

**Responsibilities:**
- Read/write per-store price files with YAML frontmatter
- Auto-update prices from receipt data (called after H8 receipt parsing)
- Parse text intents for manual price updates ("eggs are $3.50 at costco")
- Normalize item names via LLM (receipt abbreviations → readable names)
- Organize items by department (Dairy, Produce, Meat, Pantry, etc.)

**Price file format** (`shared/prices/{store-slug}.md`):
```markdown
---
store: Costco
last_updated: 2026-04-07
item_count: 24
---

## Dairy
- Eggs (60ct): $7.99 <!-- updated: 2026-04-05 -->
- Milk, whole (1 gal): $3.89 <!-- updated: 2026-04-01 -->

## Produce
- Bananas (3 lb): $1.49 <!-- updated: 2026-04-05 -->

## Meat
- Chicken breast (6 lb): $17.99 <!-- updated: 2026-04-05 -->
```

**Auto-update from receipts:**
1. Receive parsed receipt from H8 (store name, line items with prices)
2. LLM normalizes receipt line item names ("KS ORG EGGS 5DZ" → "Eggs (60ct)")
3. Match normalized names to existing price entries (LLM semantic match)
4. Update existing prices, add new items
5. Return update summary count (e.g., "Updated 8 prices, added 2 new items")

### 2. cost-estimator.ts

Estimates cost per meal and per plan by matching recipe ingredients to the price database.

**Responsibilities:**
- Accept a recipe's ingredient list and a store's price data
- Use LLM to semantically match each ingredient to the closest price entry
- Use LLM to convert units (recipe: "2 cups flour" → price: "25 lb bag" → proportional cost)
- Calculate per-meal and per-person costs
- Fall back to LLM-estimated prices when no price data exists (marked as estimates)
- Support multi-store comparison (estimate same recipe at different stores)

**LLM call pattern:** Single LLM call per recipe with ingredient list + full price database for a store. LLM returns JSON with matched items, unit conversions, and per-ingredient costs.

### 3. budget-reporter.ts

Generates and persists spend reports at weekly, monthly, and yearly granularity.

**Responsibilities:**
- Generate weekly reports: this week's meals + costs, total, avg per meal, per person, vs last week
- Generate monthly reports: weekly breakdown, projected month total, vs last month, spending by category
- Generate yearly reports: monthly totals, YTD, trends, most-cooked meals
- Persist reports as Obsidian .md files in `shared/cost-history/`
- Format reports for Telegram output

**Cost history file paths:**
- `shared/cost-history/YYYY-WNN.md` — weekly (e.g., `2026-W15.md`)
- `shared/cost-history/YYYY-MM.md` — monthly (e.g., `2026-04.md`)
- `shared/cost-history/YYYY.md` — yearly (e.g., `2026.md`)

**Report generation:** Reports are generated on-demand when `/foodbudget` is called. The cost history files are updated/created as a side effect, so they accumulate over time for historical queries via `/ask`.

### 4. budget-alerts.ts

Analyzes meal plan costs and flags expensive plans with swap suggestions.

**Responsibilities:**
- After a meal plan is generated, estimate its total cost
- Compare against rolling 4-week average
- If significantly above average (>15%), flag with warning
- Use LLM to suggest cheaper alternative meals that could bring the total down
- Format alert as inline annotation on the meal plan output

## New Handler

### budget.ts

Handles the `/foodbudget` command and price update text intents.

**Commands:**
- `/foodbudget` (no args) — weekly summary (default)
- `/foodbudget month` — monthly summary
- `/foodbudget year` — year-in-review

**Text intents (routed via LLM classification):**
- "eggs are $3.50 at costco" → price update
- "update milk price to $4.29" → price update

Note: Price lookups ("how much does chicken cost?") are handled by the chatbot's `/ask` command via AppKnowledgeBase, which can read the price files. No special intent routing needed for queries.

## Integration Points

### Receipt parser integration (H8 → H10)
After `receipt-parser.ts` processes a photo and stores the receipt, call `price-store.updateFromReceipt()` to auto-update prices. Add this to the photo handler's receipt processing flow.

### Meal planner integration (H3 → H10)
After `meal-planner.ts` generates a plan, call `cost-estimator.estimatePlanCost()` and `budget-alerts.checkPlan()` to annotate the plan output with costs and alerts.

### Grocery generator integration (H2 → H10)
When generating a grocery list, call `cost-estimator.estimateGroceryListCost()` to annotate items with prices and add a store total.

### Chatbot /ask integration
Cost history .md files are queryable via the existing `/ask` app-awareness system. No special integration needed — the files are in the data directory and accessible to AppKnowledgeBase.

## Manifest Changes

The following config fields are already defined in the manifest:
- `preferred_stores` (string) — comma-separated list of store names
- `default_store` (string) — default store for price lookups
- `show_price_estimates` (boolean, default: false) — show prices on grocery lists

New command already in manifest:
- `/foodbudget` — "View food cost tracking and reports"

No manifest changes needed.

## Data Storage

All new data in `shared/` (household-scoped):
- `shared/prices/{store-slug}.md` — per-store price databases
- `shared/cost-history/YYYY-WNN.md` — weekly cost breakdowns
- `shared/cost-history/YYYY-MM.md` — monthly summaries
- `shared/cost-history/YYYY.md` — yearly summaries

## Testing Strategy

Estimated: 40-55 new tests across 4 test files.

| Test File | Focus |
|-----------|-------|
| `price-store.test.ts` | Price file CRUD, receipt auto-update, text intent parsing, name normalization |
| `cost-estimator.test.ts` | Ingredient-to-price matching, unit conversion, fallback estimation, multi-store |
| `budget-reporter.test.ts` | Weekly/monthly/yearly report generation, trend calculations, history file persistence |
| `budget-handler.test.ts` | /foodbudget command routing, price update intents, integration with reporter + alerts |

## Verification

1. Send a receipt photo → verify price file is created/updated for that store
2. Text "eggs are $3.50 at costco" → verify price entry is updated
3. Run `/foodbudget` → verify weekly report with meal costs appears
4. Run `/foodbudget month` and `/foodbudget year` → verify report formats
5. Generate a meal plan → verify inline cost estimates and budget alert (if applicable)
6. Generate a grocery list with `show_price_estimates: true` → verify per-item prices and total
7. Check that cost history files are created in `shared/cost-history/`
8. Verify price files are readable in Obsidian with proper frontmatter
