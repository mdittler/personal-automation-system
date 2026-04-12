# F9: Telegram Markdown Escaping — Design Spec

## Context

Finding 9 from the codebase security review identifies inconsistent Telegram Markdown escaping across PAS. `TelegramService.send()`, `sendWithButtons()`, and `editMessage()` all set `parse_mode: 'Markdown'` (legacy), which treats `*`, `_`, `` ` ``, and `[` as control characters. When stored data, user input, or LLM-generated content contains these characters, Telegram either rejects the message or renders garbled formatting.

Three separate `escapeMarkdown` implementations exist:
- **Food app** (`apps/food/src/utils/escape-markdown.ts`): escapes `*_`[]()` — correct for legacy Markdown
- **Router** (`core/src/services/router/index.ts:30`): escapes 19+ MarkdownV2 characters — over-escapes for legacy parse mode, producing unnecessary visible backslashes
- **Route-verifier** (`core/src/services/router/route-verifier.ts:58`): identical to router, same mismatch

Most food app formatters and all of chatbot, echo, notes, reports, and alerts send data-bearing messages with zero escaping.

### Double-asterisk bold concern

Many food app formatters use `**${title}**` (double-asterisk). Telegram's legacy Markdown only documents single-asterisk bold (`*bold*`). In practice, Telegram currently renders `**text**` as bold with a leading/trailing literal `*`, which is a pre-existing rendering issue. This spec does NOT fix the `**` vs `*` formatting inconsistency — that is covered by Finding 21 (Markdown syntax normalization). This spec only ensures dynamic data inside those markers is escaped.

## Approach: Hybrid (Escape in Formatters + Shared Utility)

1. Create a shared `escapeMarkdown` in core, exported via `@pas/core` package for app consumption
2. Fix food app formatter functions to escape data interpolations
3. Fix specific unsafe sends in echo, notes, reports, and alerts — escaping at the Telegram delivery boundary only
4. Replace router/verifier inline implementations with the shared utility
5. Leave LLM output (chatbot, report summaries, alert summaries) unescaped — the LLM is a trusted formatter whose intentional Markdown should be preserved

### What does NOT change

- `TelegramService` parse mode stays as `'Markdown'` (legacy)
- Buttons/inline keyboards are unaffected (not Markdown)
- Intentional formatting (`*bold*`, `_italic_`) in server-controlled strings is preserved
- LLM responses continue to use Markdown formatting in chatbot, report summaries, and alert summaries
- `**` vs `*` bold normalization is out of scope (Finding 21)

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

**Package export:** Add `"./utils/escape-markdown": "./dist/utils/escape-markdown.js"` to `core/package.json` exports, following the existing pattern for `./utils/slugify`, `./utils/frontmatter`, etc. This allows all apps (echo, notes, food) to import via `@pas/core/utils/escape-markdown`.

**Food app migration:** `apps/food/src/utils/escape-markdown.ts` becomes a re-export of `@pas/core/utils/escape-markdown`. All existing food app imports continue to work unchanged.

### 2. Food App Formatter Fixes

Each formatter wraps user/stored data fields with `escapeMarkdown()` before interpolation. Intentional Markdown markers (`*`, `**`) remain outside the escape call.

| Formatter | File | Fields to escape |
|-----------|------|-----------------|
| `formatRecipe()` | `recipe-store.ts` | title, cuisine, tags, ingredient quantity/unit/name/notes, instruction steps, prepTime, cookTime, servings |
| `formatSearchResults()` | `recipe-store.ts` | title, relevance |
| `formatPlanMessage()` | `meal-plan-store.ts` | recipeTitle, cuisine, description, location |
| `formatTonightMessage()` | `meal-plan-store.ts` | recipeTitle, description, first instruction step |
| `formatGroceryMessage()` | `grocery-store.ts` | department names, item names, item quantity/unit |
| `formatPantry()` | `pantry-store.ts` | department/category names, item names, quantities |
| `formatChildProfile()` | `family-profiles.ts` | name, allergens, dietary notes, food/allergen names |
| `formatGuestProfile()` | `guest-profiles.ts` | name, restrictions, allergies, notes |

**Scope boundary:** These 8 formatters cover the primary structured-data display paths. Other food app `telegram.send` calls that interpolate dynamic data outside these formatters (e.g. inline handler messages, budget reporter, household, hosting planner, cook-mode) are explicitly deferred to Finding 21, which covers the broader Telegram Markdown normalization. This phase targets the highest-risk formatter functions identified in F9.

### 3. Specific Unsafe Send Fixes

| Source | File | Fix |
|--------|------|-----|
| Echo app | `apps/echo/src/index.ts` lines 21, 37 | Escape user input before send |
| Notes list | `apps/notes/src/index.ts` line 92 | Escape stored note lines |
| Report delivery | `core/src/services/reports/report-formatter.ts` | Escape in `formatForTelegram()` only — NOT in `formatReport()` (see below) |
| Alert telegram action | `core/src/services/alerts/alert-executor.ts` | Escape in `executeTelegramMessage()` only — NOT in `resolveTemplate()` (see below) |

**Report escaping boundary:** `formatReport()` output is reused as `ReportRunResult.markdown` (returned to API/GUI callers) and saved to report history files. `section.content` is explicitly gathered as markdown. Escaping inside `formatReport()` would corrupt saved/API output. Instead, apply escaping inside `formatForTelegram()` — either escape the entire formatted markdown string there, or add a Telegram-specific escape pass on the data fields before truncation.

**Alert escaping boundary:** `resolveTemplate()` is shared across all action types — `telegram_message`, `write_data`, `audio`, and `dispatch_message`. Escaping `vars.data` or `vars.alertName` inside `resolveTemplate()` would leak Telegram backslashes into files, speech synthesis, and synthetic router input. Instead, apply escaping only inside `executeTelegramMessage()`, after calling `resolveTemplate()` but before calling `telegram.send()`. The simplest approach: call `escapeMarkdown()` on the fully resolved text in `executeTelegramMessage()`.

### 4. Router/Verifier Migration

Replace inline `escapeMarkdown` definitions with import from `core/src/utils/escape-markdown.ts`:
- `core/src/services/router/index.ts` line 30 — delete inline function, add import
- `core/src/services/router/route-verifier.ts` line 58 — delete inline function, add import

**Behavioral change:** The router/verifier currently over-escape MarkdownV2 characters (`.`, `!`, `-`, `~`, `>`, `#`, `+`, `=`, `|`, `{`, `}`). After migration, these characters will no longer be escaped. This removes unnecessary visible backslashes from router messages. No existing tests assert MarkdownV2-specific escaping.

### 5. LLM Output Rule

LLM responses are **not escaped** — they intentionally use Markdown for formatting (bold, italic, code blocks, lists). Escaping would strip all formatting from:
- Chatbot fallback and `/ask` responses
- Report LLM summaries (preserved in `formatForTelegram()` — only non-LLM fields are escaped)
- Alert LLM summaries (preserved because escaping happens on the full resolved text in the Telegram action path, where the LLM summary is already interpolated)

**Accepted tradeoff:** Broken LLM Markdown (unmatched `*` or `_`) can still cause Telegram parse errors. This is rare and the alternative (plain text everything) defeats the purpose.

**Note on report/alert LLM summaries:** The `formatForTelegram()` escaping approach escapes the entire string including LLM summaries. This is acceptable because report/alert summaries are short structured text, not rich conversational Markdown like chatbot output. If this proves too aggressive, a future refinement can use a structured format where LLM sections are marked and excluded from escaping.

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
- **Reports:** `formatForTelegram()` output escapes `report.name` with `[link]`, while `formatReport()` output preserves it unescaped
- **Alerts:** `executeTelegramMessage()` escapes resolved text containing `*`, while `resolveTemplate()` output for `write_data`/`audio`/`dispatch_message` remains unescaped
- **Router/verifier:** existing tests pass (behavioral narrowing, no regressions)

### Truncation tests
- **Reports:** `formatForTelegram()` with content containing Markdown control characters near the 4000-char truncation boundary — assert the truncated output is still valid (no half-escaped sequences)
- **Alerts:** `executeTelegramMessage()` with template-resolved text near 4000-char limit containing special characters

## Verification

1. Run `pnpm test` — all 5510+ tests pass
2. Run `pnpm build` — no type errors
3. Manual Telegram test: send a message through the echo app containing `*test_value*` and verify it renders as literal text, not bold/italic
