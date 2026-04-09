# Phase H11.w — Smart Nutrition Logging (Design Spec)

**Status:** Approved design. 2026-04-09. Ready for implementation planning.
**Phase label:** H11.w (lands before H11.y).
**Related plan:** `~/.claude/plans/food-smart-nutrition-logging.md` (original self-contained spec; this doc is the approved, decisions-resolved version.)

## 1. Problem

The current `/nutrition log` subcommand (`apps/food/src/handlers/nutrition.ts:164-225`) requires users to type `/nutrition log <label> <cal> <protein> <carbs> <fat> [fiber]`. Nobody memorizes calorie counts, so the feature is effectively dead. User feedback captured in `memory/feedback_llm_derives_what_it_can.md`: *"Nobody is going to have a clue how many calories anything is. It won't be a used feature if someone has to know before."*

The system already has everything it needs to estimate macros automatically — recipes carry LLM-derived per-serving macros (`recipe-parser.ts:25-107`), auto-log on "Cooked!" works (`macro-tracker.ts:318-335`), and the ingredient normalizer (H11.z) can match free text to canonical ingredients. The gap is the user-facing logging path.

## 2. Goal

Replace the numeric form with three intelligent logging paths plus natural-language routing so users only ever supply portion + free text / preference, never macros.

## 3. Scope — five feature blocks

### Block 1 — Recipe-reference log
Fuzzy-match `/nutrition log <text> <portion>` against the recipe store. On unique match, scale cached per-serving macros by portion and write a `MealMacroEntry`. No new LLM call.

- Inputs: `/nutrition log lasagna half`, `/nutrition log yesterday's curry 1`.
- Ambiguous match → inline Telegram buttons with candidates + "none of these" escape (falls through to Block 3).
- Portion parser accepts: number (`0.5`, `1.5`), fraction (`1/2`, `2/3`), keyword (`half`, `all`, `a small bite`).

### Block 2 — Quick-meal templates
New user-scoped type `QuickMealTemplate` stored at `data/users/<uid>/food/quick-meals.yaml`.

```ts
interface QuickMealTemplate {
  id: string;                  // slugified label, SAFE_SEGMENT-validated
  userId: string;
  label: string;               // 'Chipotle chicken bowl w/ guac'
  kind: 'home' | 'restaurant' | 'other';
  ingredients: string[];       // free text, one per line, normalized via ingredient-normalizer
  notes?: string;
  estimatedMacros: MacroData;  // LLM-computed at save time
  confidence: number;          // 0.0-1.0 from LLM
  llmModel: string;            // audit trail
  usdaCrossCheck?: {           // optional USDA FDC sanity-check result
    calories: number;
    matchedIngredients: number;
    totalIngredients: number;
  };
  usageCount: number;          // drives quick-pick sort
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

**Flows:**
- `/nutrition meals add` — guided: label → kind (buttons) → ingredients (free text) → optional notes → one fast-tier LLM call → optional USDA cross-check → confirm → save.
- `/nutrition meals list` — grouped by kind, sorted by `usageCount`.
- `/nutrition meals edit <label>` / `remove <label>` — CRUD; remove archives to `## Archive` section.
- `/nutrition log` **with no args** — Telegram button grid of top-5 most-used templates + "Something else…" escape. Tap → second row prompts portion (`½`, `1`, `1½`, `2`, `Custom`).

### Block 3 — Ad-hoc LLM estimator
One fast-tier LLM call with Zod-validated JSON output for meals outside the recipe book and not saved as quick-meals.

- `/nutrition log "a burger of unknown size, some potato salad, one beer"` →
  ```json
  { "calories": 820, "protein": 35, "carbs": 60, "fat": 45, "fiber": 6,
    "confidence": 0.4, "reasoning": "sizes unspecified; averaged typical portions" }
  ```
- Stored with `estimationKind: 'llm-ad-hoc'` and the `confidence` field.
- **Low-confidence handling:** entries with `confidence < 0.5` still count toward daily totals but are flagged with `*` in `/nutrition today` and adherence reports, with a legend line `* = low-confidence estimate`.
- User input runs through `sanitizeInput()` + backtick neutralization before interpolation into the LLM prompt (mirror the H11.x hosting notes treatment).
- LLM output Zod-validated before write; on malformed output, fall back to asking the user for rough numbers (do not silently drop).
- **Ad-hoc dedup tracker:** a small in-store history (last 30 days of ad-hoc log free-text entries, per user) enables "logged this twice, save as quick-meal?" auto-prompt. Similarity check uses canonical-ingredient overlap or a cheap fast-tier LLM call; exact rule decided at implementation time.

### Block 4 — Natural-language routing
The food app classifier (`apps/food/src/index.ts`) is extended so conversational inputs resolve without subcommands.

- New classifier intents: `log_meal_reference`, `log_meal_adhoc`, `quick_meal_create`.
- One classifier call resolves match type (recipe vs quick-meal vs ad-hoc) AND extracts portion + label/free-text so the handler needs no second LLM round.
- Classifier prompt includes the calling user's recipe titles + quick-meal labels as context so "lasagna" and "my usual Chipotle bowl" resolve to IDs.
- Sample inputs:
  - "I had half of the lasagna I made last night" → `log_meal_reference` → recipe match, 0.5 servings
  - "my usual chipotle bowl" → `log_meal_reference` → quick-meal match, 1 serving
  - "some BBQ food, burger and salad" → `log_meal_adhoc`

### Block 5 — USDA FoodData Central cross-reference
**MFP is dropped.** No scraping, no credential handling. USDA FDC only.

- USDA FDC public API (`https://fdc.nal.usda.gov/api-guide.html`) used at **quick-meal creation time** to cross-check the LLM's estimate.
- Per ingredient: query FDC, grab first reasonable match, sum calories across ingredients.
- User is shown both values at confirmation: `"LLM estimate: 850 cal / USDA sum: 780 cal — which feels right?"` with buttons `[Use LLM] [Use USDA] [Average] [Edit manually]`.
- USDA API key read from `config/pas.yaml` (`food.usda_fdc_api_key`) or `USDA_FDC_API_KEY` env var. Server-side only. Never sent to LLM.
- **Graceful degradation:** if USDA is unreachable or returns no match, the quick-meal save path still succeeds using the LLM estimate alone; `usdaCrossCheck` field is simply omitted.
- USDA is **not** used for Block 3 ad-hoc logs (free text is too unstructured to decompose into ingredient queries reliably).

## 4. Non-goals

- No pantry deduction from logged meals. "I ate this" ≠ "this came out of the pantry."
- No automated weight or calorie-goal recommendations. User sets targets via the H11.x GUI flow.
- No barcode scanning or nutrition-label OCR.
- No meal-photo recognition. Vision infra (H8) is not used here.
- No MyFitnessPal integration of any kind.
- No cross-user / household sharing of quick-meals. Per-user only. Sharing can be added later if requested.

## 5. Data model changes

1. **New type** `QuickMealTemplate` — see Block 2.
2. **Extended** `MealMacroEntry` (`apps/food/src/types.ts:415-425`) with optional fields (back-compat):
   - `estimationKind?: 'recipe' | 'quick-meal' | 'llm-ad-hoc' | 'manual'`
   - `confidence?: number`
   - `sourceId?: string` — recipe id, quick-meal id, or undefined for ad-hoc/manual
3. **New file path:** `data/users/<uid>/food/quick-meals.yaml` — list-type data with frontmatter + `## Active` / `## Archive` sections.
4. **New file path:** `data/users/<uid>/food/ad-hoc-history.yaml` — small rolling log (last 30 days) for the dedup tracker. Trimmed on write.
5. `MonthlyMacroLog` and `DailyMacroEntry` structures unchanged.

## 6. Manifest changes (`apps/food/manifest.yaml`)

- New subcommands: `nutrition meals add`, `nutrition meals list`, `nutrition meals edit`, `nutrition meals remove`.
- `/nutrition log` accepts: no-args (button grid), `<recipe-or-quick-meal-label> <portion>`, `<free-text>` (ad-hoc), and retains the legacy numeric form as a hidden escape hatch for backward-compat tests.
- New intents for NL routing: `log_meal_reference`, `log_meal_adhoc`, `quick_meal_create`.
- New user_config keys: none required (USDA key is system-level).
- New system config: `food.usda_fdc_api_key` in `config/pas.yaml`.

## 7. Architecture — component map

```
/nutrition log <input>
        │
        ▼
  nutrition-handler ────┐
        │               │ (NL path)
        │          food-classifier (extended)
        │               │
   ┌────┴───────────────┼─────────────────┐
   ▼                    ▼                 ▼
recipe-matcher    quick-meals-store   macro-estimator
  (fuzzy +          (CRUD, top-5        (fast-tier LLM,
   disambig          quick-pick,         Zod validation,
   buttons)          SAFE_SEGMENT ids)   sanitizeInput)
   │                    │                 │
   │                    │                 ├──► usda-fdc-client
   │                    │                 │    (quick-meal
   │                    │                 │     cross-check only)
   │                    │                 │
   │                    │                 └──► ad-hoc-history
   │                    │                      (dedup tracker,
   │                    │                       "save as quick-meal?")
   └──────────┬─────────┴─────────────────┘
              ▼
        portion-parser
              │
              ▼
      macro-tracker.logMeal()
      writes MealMacroEntry
      { estimationKind, confidence, sourceId }
```

## 8. Security

- `sanitizeInput()` + backtick neutralization on every user → LLM surface: quick-meal label, ingredients, notes, ad-hoc free text, classifier input.
- LLM JSON output Zod-validated before writing to store or rendering to user. Reject on type mismatch or out-of-range values (e.g. `calories > 10000`, negative macros).
- USDA API key server-side only; never in an LLM prompt.
- Quick-meal ids slugified + `SAFE_SEGMENT`-validated before use as a file key (path traversal guard).
- YAML writes via existing atomic temp-file + rename path (with Windows EPERM retry).
- Ad-hoc dedup history file size-bounded (30 days, trimmed on write) to prevent unbounded growth.

## 9. Testing plan

### URS
- New REQ row: **REQ-MEAL-008** "Smart nutrition logging" — covers all five blocks.

### Unit
- `quick-meals-store.test.ts` — CRUD, slug collision, archive, read-after-write.
- `macro-estimator.test.ts` — LLM JSON parsing, Zod validation, malformed-output rejection, confidence propagation, `sanitizeInput()` applied.
- `recipe-matcher.test.ts` — exact/fuzzy match, ambiguous disambiguation, no-match fallthrough.
- `portion-parser.test.ts` — `half`, `½`, `1/2`, `0.5`, `all`, `a small bite`, invalid → error.
- `usda-fdc-client.test.ts` — mock HTTP, graceful degradation, no-match handling.
- `ad-hoc-history.test.ts` — dedup threshold, 30-day trim, similarity match.
- `nutrition-handler.test.ts` — extended with recipe-ref, quick-meal, ad-hoc dispatch paths.

### Integration
- Create quick-meal → log it → `MealMacroEntry` appears in daily total with correct `sourceId` and `confidence`.
- Recipe-reference log scales `servingsEaten` correctly against cached per-serving macros.
- Ad-hoc log with `confidence: 0.3` → flagged with `*` in `/nutrition today` output, counted in totals.
- Ad-hoc log twice within 30 days with similar text → "save as quick-meal?" prompt fires.
- Quick-meal creation with USDA reachable → user sees both estimates, picks one.
- Quick-meal creation with USDA unreachable → save succeeds, `usdaCrossCheck` field absent.
- Per-user isolation: user A's quick-meals never visible to user B (mirror `nutrition-per-user-config.integration.test.ts`).

### Persona NL tests (new `natural-language-h11w.test.ts`)
- "I had my usual Chipotle bowl" → quick-meal match, log one serving.
- "half of the lasagna from last night" → recipe match, 0.5 serving.
- "a burger of unknown size and some potato salad at a BBQ" → ad-hoc, `confidence < 0.5`, flagged.
- "log my breakfast" with 3 saved breakfast quick-meals → button grid reply.
- "log a burrito bowl" with no matching quick-meal or recipe → prompts "save as quick-meal?" after second occurrence.

### Edge cases
- Ambiguous recipe match (two "chicken curry" recipes) → disambiguation buttons.
- LLM returns `confidence: 0` → prompt user to refine or manual-enter.
- Quick-meal with 20+ ingredients → prompt-length boundary test.
- Portion = 0, negative, NaN → field-specific validation error (reuse H11.x pattern).

### Security
- Prompt injection in quick-meal label, ingredients, notes → sanitized.
- Triple-backtick neutralization in notes (mirror H11.x hosting test).
- Zod rejects `calories: "drop table"`, negative values, values > 10000.

### Failure modes
- LLM fast-tier unavailable → "can't estimate right now, please retry or enter manually".
- `quick-meals.yaml` corrupt → clear error, no crash.
- USDA API down or returns no match → LLM-only estimate, save succeeds.

## 10. Files touched

| File | Change |
|------|--------|
| `apps/food/src/types.ts` | Add `QuickMealTemplate`; extend `MealMacroEntry` |
| `apps/food/src/handlers/nutrition.ts` | Rewrite `log` dispatch; add `meals` subcommands |
| `apps/food/src/services/quick-meals-store.ts` | **NEW** — CRUD + YAML serialization |
| `apps/food/src/services/macro-estimator.ts` | **NEW** — LLM wrapper + Zod validation + sanitizeInput |
| `apps/food/src/services/recipe-matcher.ts` | **NEW** — fuzzy match user text → recipe id |
| `apps/food/src/services/portion-parser.ts` | **NEW** — parse portion expressions |
| `apps/food/src/services/usda-fdc-client.ts` | **NEW** — USDA FDC HTTP client + cross-check helper |
| `apps/food/src/services/ad-hoc-history.ts` | **NEW** — rolling dedup tracker |
| `apps/food/src/services/macro-tracker.ts` | Extend `logMeal` to accept quick-meal / ad-hoc sources |
| `apps/food/src/index.ts` | Wire NL classifier intents to new handler paths |
| `apps/food/manifest.yaml` | New intents + subcommands |
| `apps/food/docs/urs.md` | REQ-MEAL-008 row + totals bump |
| `apps/food/docs/implementation-phases.md` | New phase row |
| `config/pas.yaml` | `food.usda_fdc_api_key` config key |
| `CLAUDE.md` | Move H11.w from Deferred → complete on phase close |

## 11. Dependencies and sequencing

- **Blocked by:** nothing. H11.x closed, Phase 30 (requestContext) done, LLM fast-tier + guard stable.
- **Blocks:** H11.y — guided-button flows become far more useful once these three log targets exist.
- **Related prior art:** H11.z ingredient normalizer, H11.x loadTargets overlay + field-specific validation pattern, H8 vision infra (for structured-output pattern reference only).

## 12. Resolved design decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Sequence vs H11.y | **Before H11.y.** |
| 2 | MFP vs USDA | **USDA + LLM only.** No MFP scrape, no credentials. |
| 3 | Low-confidence ad-hoc entries | **Count toward totals + flag with `*` + legend.** |
| 4 | Quick-meal creation prominence | **Auto-prompt after 2nd similar ad-hoc log within 30 days.** Never on first occurrence. |
| 5 | Quick-meal sharing scope | **Strictly per-user.** `data/users/<uid>/food/quick-meals.yaml`. No space sharing. |

## 13. Suggested commit message for phase close

```
feat(food): Phase H11.w — smart nutrition logging

Replaces the unusable numeric /nutrition log with three intelligent
paths: recipe-reference log (scales cached recipe macros by portion),
saved quick-meal templates (user-defined frequent meals with LLM-
estimated macros + USDA FDC cross-check, quick-pick button grid), and
an ad-hoc LLM estimator for meals outside the recipe book. Natural-
language routing lets users say "half of last night's lasagna" or
"my usual Chipotle bowl". Low-confidence ad-hoc entries count toward
totals but are flagged with `*` in daily reports. Ad-hoc text logged
twice within 30 days auto-prompts "save as quick-meal?".

Addresses user feedback: nobody memorizes calorie counts.
```
