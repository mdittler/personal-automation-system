# F9: Telegram Markdown Escaping — Design Spec

## Context

Finding 9 from the codebase security review identifies inconsistent Telegram Markdown escaping across PAS. `TelegramService.send()`, `sendWithButtons()`, and `editMessage()` all set `parse_mode: 'Markdown'` (legacy), which treats `*`, `_`, `` ` ``, and `[` as control characters. When stored data, user input, or LLM-generated content contains these characters, Telegram either rejects the message or renders garbled formatting.

Three separate `escapeMarkdown` implementations exist:
- **Food app** (`apps/food/src/utils/escape-markdown.ts`): escapes `*_`[]()` — correct for legacy Markdown
- **Router** (`core/src/services/router/index.ts:30`): escapes 19+ MarkdownV2 characters — over-escapes for legacy parse mode, producing unnecessary visible backslashes
- **Route-verifier** (`core/src/services/router/route-verifier.ts:58`): identical to router, same mismatch

Most food app formatters and all of chatbot, echo, notes, reports, and alerts send data-bearing messages with zero escaping.

## Approach: Hybrid (Escape in Formatters + Shared Utility)

1. Create a single shared `escapeMarkdown` in core
2. Fix the 8 food app formatter functions to escape data interpolations
3. Fix specific unsafe sends in echo, notes, reports, and alerts
4. Replace router/verifier inline implementations with the shared utility
5. Leave LLM output (chatbot, report summaries, alert summaries) unescaped — the LLM is a trusted formatter whose intentional Markdown should be preserved

### What does NOT change

- `TelegramService` parse mode stays as `'Markdown'` (legacy)
- Buttons/inline keyboards are unaffected (not Markdown)
- Intentional formatting (`*bold*`, `_italic_`) in server-controlled strings is preserved
- LLM responses continue to use Markdown formatting in chatbot, report summaries, and alert summaries

## Component Design

### 1. Shared `escapeMarkdown` Utility

**File:** `core/src/utils/escape-markdown.ts` (new)

```ts
/** Escape Telegram legacy Markdown control characters in user/stored data. */
const SPECIALS = /[*_`[\]()]/g;
export function escapeMarkdown(text: string): string {
  return text.replace(SPECIALS, (m) => '\\' + m);
}
```

Characters escaped: `*`, `_`, `` ` ``, `[`, `]`, `(`, `)`. Matches the food app's existing implementation. `(` and `)` are only meaningful after `]` in legacy Markdown but escaping them is harmless and prevents edge cases.

**Food app:** `apps/food/src/utils/escape-markdown.ts` stays as-is (apps cannot import from `@core/`). It already has the correct implementation. The core utility is a new copy with the same logic, used by core consumers (router, verifier, reports, alerts). Both implementations are identical — the duplication is forced by the app/core boundary.

### 2. Food App Formatter Fixes

Each formatter wraps user/LLM data fields with `escapeMarkdown()` before interpolation. Intentional Markdown markers (`*`, `**`) remain outside the escape call.

| Formatter | File | Fields to escape |
|-----------|------|-----------------|
| `formatRecipe()` | `recipe-store.ts` | title, cuisine, tags, ingredient name/notes, instruction steps |
| `formatSearchResults()` | `recipe-store.ts` | title |
| `formatPlanMessage()` | `meal-plan-store.ts` | recipeTitle, cuisine, description |
| `formatTonightMessage()` | `meal-plan-store.ts` | recipeTitle, description |
| `formatGroceryMessage()` | `grocery-store.ts` | department names, item names |
| `formatPantry()` | `pantry-store.ts` | department/category names, item names, quantities |
| `formatChildProfile()` | `family-profiles.ts` | name, allergens, dietary notes, food/allergen names |
| `formatGuestProfile()` | `guest-profiles.ts` | name, restrictions, allergies, notes |

### 3. Specific Unsafe Send Fixes

| Source | File | Fix |
|--------|------|-----|
| Echo app | `apps/echo/src/index.ts` lines 21, 37 | Escape user input before send |
| Notes list | `apps/notes/src/index.ts` line 92 | Escape stored note lines |
| Report formatter | `core/src/services/reports/report-formatter.ts` | Escape `report.name`, `report.description`, `section.label`, `section.content` |
| Alert executor | `core/src/services/alerts/alert-executor.ts` | Escape `vars.data` and `vars.alertName` in `resolveTemplate()` |

### 4. Router/Verifier Migration

Replace inline `escapeMarkdown` definitions with import from `core/src/utils/escape-markdown.ts`:
- `core/src/services/router/index.ts` line 30 — delete inline function, add import
- `core/src/services/router/route-verifier.ts` line 58 — delete inline function, add import

**Behavioral change:** The router/verifier currently over-escape MarkdownV2 characters (`.`, `!`, `-`, `~`, `>`, `#`, `+`, `=`, `|`, `{`, `}`). After migration, these characters will no longer be escaped. This removes unnecessary visible backslashes from router messages. No existing tests assert MarkdownV2-specific escaping.

### 5. LLM Output Rule

LLM responses are **not escaped** — they intentionally use Markdown for formatting (bold, italic, code blocks, lists). Escaping would strip all formatting from:
- Chatbot fallback and `/ask` responses
- Report LLM summaries (`vars.summary` in report formatter)
- Alert LLM summaries (`vars.summary` in alert executor)

**Accepted tradeoff:** Broken LLM Markdown (unmatched `*` or `_`) can still cause Telegram parse errors. This is rare and the alternative (plain text everything) defeats the purpose.

## Testing

### Core utility tests (`core/src/utils/__tests__/escape-markdown.test.ts`)
- Escapes each control character individually
- Escapes strings with multiple special characters
- Passes safe strings through unchanged
- Handles empty string

### Formatter tests (add cases to existing test files)
For each formatter, add a test with data containing `*`, `_`, `` ` ``, `[` and assert the output contains escaped versions (`\*`, `\_`, etc.) while intentional formatting markers remain unescaped.

| Formatter | Test File |
|-----------|-----------|
| `formatRecipe` | `recipe-store.test.ts` |
| `formatSearchResults` | `recipe-store.test.ts` |
| `formatPlanMessage` | `meal-plan-store.test.ts` |
| `formatTonightMessage` | `meal-plan-store.test.ts` |
| `formatGroceryMessage` | `grocery-store.test.ts` |
| `formatPantry` | `pantry-store.test.ts` |
| `formatChildProfile` | `family-profiles.test.ts` |
| `formatGuestProfile` | `guest-profiles.test.ts` |

### App/infrastructure tests
- **Echo:** user input with `*bold*` arrives escaped
- **Notes:** stored note with `_italic_` arrives escaped
- **Reports:** `report.name` with `[link]` is escaped in formatted output
- **Alerts:** `{data}` containing `*` is escaped after template resolution
- **Router/verifier:** existing tests pass (behavioral narrowing, no regressions)

## Verification

1. Run `pnpm test` — all 5510+ tests pass
2. Run `pnpm build` — no type errors
3. Manual Telegram test: send a message through the echo app containing `*test_value*` and verify it renders as literal text, not bold/italic
