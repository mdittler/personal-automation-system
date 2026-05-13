# Chunk C Local-Model Verification — Findings

**Date:** 2026-05-12 (executed after Codex correction pass — C1 + C2)
**Branch:** `regression/chunk-c`
**Plan ref:** `docs/superpowers/plans/2026-05-11-persona-regression-chunk-c.md` Task 14
**Models exercised:** `ollama/gemma4:e4b` (fast tier) against the live PAS LLM framework after the C1 fix (config.llm.tiers mutated before composeLLMService — real model swap, not just metadata).

---

## ⚠️ Correction (2026-05-12, post-Codex review)

Codex reviewed this doc against the on-disk regression cache and found three defects that this addendum corrects in-place rather than rewriting the body:

1. **Judge model was NOT Gemma 26b.** The Step 14.3 command line ran with `--judge-model=ollama/gemma4:26b`, but every cached chatbot result shows `modelIds.standard: "claude-sonnet-4-6"`. Root cause: `ModelSelector.load()` (core/src/services/llm/model-selector.ts:88-104) read `data/system/model-selection.yaml` AFTER the constructor and unconditionally overwrote the override-injected default tier. The persisted file had `standard: claude-sonnet-4-6`, so every "Gemma judge" call actually dispatched to Claude. The C1 fix mutated `config.llm.tiers` BEFORE `composeLLMService` but did not anticipate that `load()` would then mutate the ModelSelector AFTER the constructor. Fixed in `regression/chunk-c` correction phase Batch 0 via `ModelSelector.applyTransientOverride()` called after `load()` and before `reconcile()`. Same shape of bug affected `--model-matrix`; `fast` only "worked" because the persisted YAML happened to match (`gemma4:e4b`).

2. **Missing 5th chatbot failure: `chatbot-costco-21-items`.** Step 14.3 lists 5 failures in the summary table (line 148) but only documents 4 by name (lines 161-169). Cached result for `chatbot-costco-21-items` shows verdict=`fail`, judge reason "judge score 2: response only mentions 2 of the required 5+ Costco items." This is a real food-app handler defect (reply enumerated updated/new items rather than all 21 items the user explicitly asked for) and is distinct from the rubric-judge-misclassification defect that affects the other 4 failures.

3. **Ollama provider lacked `format: 'json'` plumbing.** `LLMCompletionOptions` had no `responseFormat` field, and `OllamaProvider.complete()` never passed `format: 'json'` to the Ollama SDK. This is why Gemma returned empty strings for the food-shadow classifier (all 27 cases) and 3 of 5 recall failures. Fixed in correction phase Batch 1 (4 providers gain JSON-mode plumbing) and Batch 2 (food-shadow + recall classifiers opt in and add empty-output retry-once).

The body of this doc below is preserved as the historical record of the run; the corrections above amend it where it conflicts with the cache.

---

## Pre-conditions (verified)

- `ollama serve` healthy at `http://localhost:11434` (3 models available: `gemma4:e4b`, `gemma4:26b`, `gemma4:31b`)
- `.env` exports `OLLAMA_URL=http://localhost:11434` and `OLLAMA_MODEL=gemma4:e4b`
- `ANTHROPIC_API_KEY` set
- C1 fix landed (`9cb579a`): tier override propagates to `LLMServiceImpl` (regression-guard test verifies `getModelForTier` returns the override model)
- C2 fix landed (`01c8c9f`): chatbot fixtures no longer declare `expectedHandler` — handler diagnostic path stays dormant until Router instrumentation lands

---

## Step 14.1 — Routing bucket (real Gemma fast tier)

**Command:**
```bash
pnpm test:regression -- --bucket=routing --model-matrix=ollama/gemma4:e4b --json
```

**Summary (from the `{type:'summary'}` line):**
| Metric | Value |
|---|---|
| Total cases dispatched | 36 |
| Pass | 4 |
| Fail | 5 |
| **Error** | **27** |
| Budget-exceeded | 0 |
| Routing accuracy (food-shadow only) | **0.00%** (REQ-REG-011 gate failed → exit 1) |
| Food-shadow inputs evaluated | 106 |
| Total cost | $0 (ollama is free) |
| Total duration | 363 s |

**Breakdown by routingTarget:**

| Target | Pass | Fail | Error |
|---|---|---|---|
| `food-shadow` (27 cases, 106 inputs) | 0 | 0 | 27 |
| `pas` (6 cases) | 2 | 4 | 0 |
| `session-control` (3 cases) | 2 | 1 | 0 |

**Per-case findings:**

- **`food-shadow` (all 27 cases):** Gemma 4 e4b returns an **empty string** for every food-shadow classification call. The structural oracle correctly emits `verdict: 'error'` with details `JSON parse failed: Unexpected end of JSON input`. This is the same model-compat issue Codex flagged in the baseline: the food-shadow prompt assumes a model that emits JSON natively for short prompts. Gemma 4 e4b instead returns an empty completion when the prompt arrives without explicit `format: json` constraints.
  - **Classification:** prompt-tightening opportunity. The food-shadow classifier should add explicit "Respond with ONLY valid JSON, no preamble, no markdown" instructions and/or use `format: json` if the provider supports it.
  - **Follow-up:** open-items.md entry "Food-shadow prompt hardening for local models".

- **`pas-data-query-negative` → FAIL:** Gemma classified a non-query as a query. PAS classifier prompt is permissive enough that Gemma reads "what's the weather like" as a data query.

- **`pas-data-query-positive` → FAIL:** Inverse — Gemma classified an explicit data query as non-query. Prompt tightness issue.

- **`pas-pas-related-negative` → PASS.** Off-topic detection works.

- **`pas-pas-related-positive` → FAIL:** Gemma missed PAS-related cues that Claude catches.

- **`pas-settings-negative` → PASS.** Correctly rejects.

- **`pas-settings-positive` → FAIL:** Gemma missed settings cues.

- **`session-control-continue` → FAIL:** Gemma classifies "yeah keep going" / "continue" inconsistently.

- **`session-control-nl-new-session` → PASS.** New-session NL phrasings recognised.

- **`session-control-prefilter-commands` → PASS.** Prefilter cases zero-meter (no LLM call); pre-existing.

**Classification of failures:**

| Failure | Type | Action |
|---|---|---|
| All 27 food-shadow cases (empty raw) | Prompt-tightening | Add explicit JSON-only instruction; trial Ollama `format: json` mode. |
| `pas-data-query-{negative,positive}` | Prompt-tightening | Improve PAS classifier prompt to be model-agnostic. |
| `pas-pas-related-positive` | Prompt-tightening | Same. |
| `pas-settings-positive` | Prompt-tightening | Same. |
| `session-control-continue` | Model-compat | Document; Gemma 4 e4b is not strong on subtle continuation cues. |

**Framework validation:** the harness correctly surfaced every empty-raw response, every schema mismatch, and the REQ-REG-011 gate fired (exit 1) at 0% routing accuracy. **The framework works as designed; the model has real prompt-compatibility gaps.** This is exactly the feedback loop Chunk C was built to provide.

---

## Step 14.2 — Recall bucket (real Gemma fast tier)

**Command:**
```bash
pnpm test:regression -- --bucket=recall --model-matrix=ollama/gemma4:e4b --json
```

**Summary:**
| Metric | Value |
|---|---|
| Total cases dispatched | 25 |
| Pass | 20 |
| Fail | 5 |
| Error | 0 |
| Budget-exceeded | 0 |
| Total cost | $0 |
| Total duration | 46 s |

**Per-case findings — fails:**

1. **`recall-true-yesterday`** — expected `{shouldRecall:true, timeAnchor:{type:'absolute',on:'2026-05-10'}}`. **Actual:** `{shouldRecall:false, timeAnchor:null, reason:'parse-failed'}`. Gemma failed to emit valid JSON for "what did we talk about yesterday?" and the safe default kicked in. Same prompt-compatibility class as the food-shadow issue.

2. **`recall-true-last-friday`** — expected `{shouldRecall:true, timeAnchor:{type:'absolute',on:'2026-05-08'}}`. **Actual:** also `parse-failed` → safe default.

3. **`recall-true-pronoun-decision`** ("can you remind me what we decided?") — expected `{shouldRecall:true}`. **Actual:** `parse-failed`.

4. **`recall-true-pronoun-leak`** ("what did we say about the leak earlier?") — expected `timeAnchor:null`. **Actual:** `{shouldRecall:true, query:'leak', timeAnchor:{type:'window',after:'2026-05-01',before:'2026-05-11'}}`. Gemma added a "this month" window when production schema expects `null`. Matches Codex's baseline finding exactly.

5. **`recall-true-last-time-decided`** ("what did we decide last time…") — expected `timeAnchor:null`. **Actual:** `{type:'window',after:'2026-05-04',before:'2026-05-11'}`. Same over-anchoring class as #4.

**Observational cases:**
- `recall-observ-it-was-so-good` — structural oracle reported `fail` (Gemma classified as not-recall when fixture's shape-schema asserted shouldRecall=true), but the runner correctly kept the case verdict at `pass` (observational input). This validates the observational-bypass mechanic from Task 4.
- `recall-observ-that-was-helpful` — observational pass.

**Classification of failures:**

| Failure | Type | Action |
|---|---|---|
| `recall-true-yesterday` parse-failed | Prompt-tightening | Same JSON-emission fix as food-shadow. |
| `recall-true-last-friday` parse-failed | Prompt-tightening | Same. |
| `recall-true-pronoun-decision` parse-failed | Prompt-tightening | Same. |
| `recall-true-pronoun-leak` over-anchoring | Prompt-tightening | Add "do NOT add a window unless the user explicitly mentioned a date/range" guidance to recall-classifier prompt. |
| `recall-true-last-time-decided` over-anchoring | Prompt-tightening | Same. |

**Recall validates the C1 fix:** the `--model-matrix=ollama/gemma4:e4b` override did genuinely route every recall call through Gemma (visible in the `model-selector` log line: `"fast":{"provider":"ollama","model":"gemma4:e4b"}`). Pre-C1 the override would have stayed cosmetic.

---

## Step 14.3 — Chatbot bucket (Gemma e4b + Gemma 26b judge)

**Command:**
```bash
pnpm test:regression -- --bucket=chatbot --model-matrix=ollama/gemma4:e4b --judge-model=ollama/gemma4:26b --json
```

**First-run blocker (discovered + fixed in this pass):** initial 10/10 fails with replies like `"Set up a household first with /household create <name>"`. Root cause: the food app's `requireHousehold` reads its own `household.yaml` from `<dataDir>/households/<hhId>/shared/food/household.yaml` (apps/food/src/utils/household-guard.ts:22) — distinct from the core HouseholdService's `households.yaml`. The seed.json populated receipts + prices but not the food household record. Fixed in `regression/src/runner/chatbot-environment.ts` (added a `household.yaml` write after the food seed files). Re-run results below.

**Summary (after fix):**
| Metric | Value |
|---|---|
| Total cases dispatched | 10 |
| Pass | 5 |
| Fail | 5 |
| Error | 0 |
| Budget-exceeded | 0 |
| Total cost | $0.022 (judge ran on `claude-sonnet-4-6` — see Correction #1 at top of doc; `--judge-model=ollama/gemma4:26b` was silently dropped by `ModelSelector.load()`) |
| Total duration | 312 s |

**Passing cases (judge was claude-sonnet-4-6, not Gemma — see Correction #1):**
- `chatbot-costco-last-items` — full 21-item Costco receipt list, judge score 5
- `chatbot-grocery-list-empty` — empty list with helpful prompt, judge score 5
- `chatbot-last-costco-trip` — date 2026-05-01 + $306.77, judge score 5
- `chatbot-new-receipt-items` — identifies both updated (Spindrift) and new (Blueberries) items, judge score 5
- `chatbot-receipt-items-and-total` — 21 items + total, judge score 5

**Failing cases (5 of 5):**

- `chatbot-blueberries-at-costco` — system replied `"Costco: Blueberries is $7.69 (updated 2026-05-01)."`. Judge scored 2 with reason: "The response contains only a memory-context block with the relevant data (mentioning Costco and $7.69) but does not constitute an actual assistant reply." **Judge (claude-sonnet-4-6) mis-classified the fenced reply as data-only.** Real reply quality is good.

- `chatbot-cheapest-blueberries` — system replied `"Which grocery item should I look up?"`. Genuine routing/intent miss — food's price-lookup heuristics flagged the prompt as too vague and asked a clarifying question instead of doing the comparison. Real failure. Addressed in correction phase Batch 3 (regex broadening for "cheapest X" phrasings).

- `chatbot-receipt-vs-meal-plan` — system replied with the full Costco receipt. Judge said "No actual assistant response was provided to evaluate—only the receipt context was given." **Same judge mis-classification.** Real reply quality is good.

- `chatbot-store-spending` — system replied `"Grocery spending by store: Costco: avg $306.77 per trip across 1 trip (total $306.77, last 2026-05-01) Trader Joes: avg $18.47 per trip across 1 trip (total $18.47, last 2026-04-29)"`. Judge said "no actual reply." **Same judge mis-classification.** Real reply quality is excellent.

- `chatbot-costco-21-items` (added by Correction #2) — user asked for the FULL 21-item Costco receipt list with prices. System replied with only the updated/new items: `"Costco receipt (2026-05-01) price updates: 1 updated, 1 new\n- Spindrift -> Spindrift Sparkling Water: $19.69 (updated)\n- Blueberries: $7.69 (new)\nTotal receipt spend: $306.77"`. Judge scored 2: "response only mentions 2 of the required 5+ Costco items, failing criterion 1." This is a **real food-app handler defect** distinct from the judge-misclassification class above — the handler should have rendered the full line-item table (or at least the requested item count) when the user explicitly asked for all items.

**Classification of failures:**

| Failure | Type | Action |
|---|---|---|
| 3× "judge says no reply" when the reply IS the data dump | Rubric-judge prompt defect for local models | Strengthen rubric oracle's instruction to the judge so it can tell the difference between fenced data presented for evaluation vs missing data. Alternative: switch to a Claude judge by default for the chatbot bucket (Claude doesn't make this mistake). |
| `chatbot-cheapest-blueberries` — clarifying question | Food-app NL intent gap | Real signal: the price-lookup intent regex didn't extract "blueberries" from this phrasing; food deflected to "which item?". Add seed for this phrase form to the food shadow tuning corpus. |

**The chatbot bucket framework works end-to-end** — composeRuntime spins, real household is materialized, food app dispatches, telegram.sent captures replies, judge oracle runs, verdicts land. The remaining failures are surface-level rubric/intent defects that are now visible thanks to the regression suite.

## Step 14.4 — Claude-judge calibration (effectively executed; see Correction #1)

Per Correction #1 at the top of this doc, the judge model for the Step 14.3 run was `claude-sonnet-4-6` — not Gemma 4 26b as the command suggested. So this step's intended calibration goal (Claude-vs-Gemma judge disagreement rate) is effectively the inverse of what was planned: the doc's "Gemma scored these as fails" was actually Claude. The remaining deferred work is the genuine Gemma-judge run, which is now part of the Batch 5 mandatory re-run in the correction phase (post-`applyTransientOverride` fix).

---

## Step 14.5 — Findings + follow-up classification

**Framework defects identified (corrected by Correction #1, #3 at top of doc):**

1. `--judge-model` / `--model-matrix` override is silently dropped by `ModelSelector.load()` when `data/system/model-selection.yaml` has a persisted value for that tier. Affected every chatbot-bucket judge call in Step 14.3 (and would have affected `--model-matrix=fast=` runs except `fast` happened to match the persisted value). Fixed in correction phase Batch 0 (`applyTransientOverride`).
2. Ollama provider lacked `format: 'json'` plumbing through `LLMCompletionOptions`. Caused all 27 food-shadow cases (106 inputs) to return empty raw output and 3 of 5 recall failures. Fixed in correction phase Batches 1+2.

The C1 fix was load-bearing for the food-tier override (`fast` matched the persisted YAML by coincidence), but did NOT extend to `standard` (judge) — that's what Correction #1 closes.

**Model-compatibility gaps (prompt-tightening opportunities):**

1. **Food-shadow classifier prompt needs `format: json` / explicit JSON-only instruction** — Gemma 4 e4b returns empty for ambiguous prompts. Affects all 27 food-shadow cases under Gemma. Priority: high (blocks ≥0.95 REQ-REG-011 gate).
2. **Recall classifier over-anchors temporal phrases** — adds windows for "earlier" / "last time" when the production schema expects `null`. Priority: medium (5/25 recall cases). Add an explicit "anchor only on explicit date/range mentions" guidance.
3. **PAS classifier prompt needs model-agnostic phrasing** — 4/6 PAS cases fail under Gemma. Priority: medium.
4. **Session-control "continue" prompt** — single failure; Gemma 4 e4b limitation. Document as accepted risk for now.

**Accepted risks:**
- Local Gemma 4 e4b cannot reliably substitute for Claude in the production routing pipeline today. The classifier prompts were tuned for frontier-model JSON behavior. The regression suite has now made these gaps visible and reproducible.

---

## Step 14.6 — Follow-ups filed in `docs/open-items.md`

The Proposals section now contains a "Food-shadow prompt hardening for local-model compatibility" entry pointing at this findings doc. See entry added in the same commit as this doc.

The chatbot env `captureHandler`/`endActiveSession` placeholder limitation remains tracked in open-items.md (added during Task 14 template prep).

---

## Step 14.7 — Sign-off

- [x] Routing bucket run executed; results recorded above.
- [x] Recall bucket run executed; results recorded above.
- [x] Chatbot bucket run executed (judge model differs from doc command — `--judge-model=ollama/gemma4:26b` silently dropped; actual judge was `claude-sonnet-4-6`; see Correction #1).
- [x] Each anomaly classified.
- [x] Follow-up entries added to `docs/open-items.md`.
- [x] Findings doc committed.
- [x] Codex review applied as Corrections #1, #2, #3 (2026-05-12).

```bash
git add docs/superpowers/plans/findings/2026-05-11-chunk-c-local-model-verification.md docs/open-items.md
git commit -m "docs(regression-C.C3): local-model verification — routing + recall findings"
```

---

## Post-Correction Fresh-Evidence Re-Run (2026-05-12, Batch 5)

After the Chunk C Correction Phase Batches 0-4 landed (framework + JSON-mode + classifier opt-in + prompt hardening), the three buckets were re-run with `--no-cache` against the same local Gemma stack. Precheck verified: `ollama serve` healthy, `gemma4:e4b` + `gemma4:26b` both available, `ANTHROPIC_API_KEY` set.

### Routing bucket (post-correction)

```bash
pnpm test:regression -- --bucket=routing --model-matrix=ollama/gemma4:e4b --no-cache --json
```

| Metric | Pre-correction | Post-correction |
|---|---|---|
| Pass | 4 | **25** |
| Fail | 5 | 11 |
| **Error** | **27** | **0** |
| Routing accuracy (food-shadow) | 0.00% | **89.62%** |
| Total duration | 363 s | 165 s |

**Food-shadow:** 18/27 pass (was 0/27 pass + 27 error). JSON-mode plumbing verified — every Gemma classification call now returns parseable JSON. Remaining 9 failures are legitimate label-mismatch errors (Gemma picks the wrong label, not the wrong format) — these are model-strength signals, not framework bugs.

**PAS classifier:** 4/6 pass (was 2/6 pass). `pas-pas-related-positive` and `session-control-continue` flipped from FAIL to PASS thanks to the deterministic prefilters (Batch 3) and JSON-mode retry.

**Session-control:** 3/3 pass (was 2/3 pass). `session-control-continue` flipped to PASS via the new few-shot examples + meta-question regex.

REQ-REG-011 at 89.62% is still below the 95% threshold — but that's a Gemma-model-quality gate, not a framework gate. The framework now works correctly; remaining failures are honest model-compatibility signal.

### Recall bucket (post-correction)

```bash
pnpm test:regression -- --bucket=recall --model-matrix=ollama/gemma4:e4b --no-cache --json
```

| Metric | Pre-correction | Post-correction |
|---|---|---|
| Pass | 20 | **24** |
| Fail | 5 | 1 |
| Error | 0 | 0 |
| Total duration | 46 s | 40 s |

Four of the 5 prior failures flipped to PASS via JSON-mode + retry-on-empty (Batch 2) and the vague-temporal few-shots (Batch 3). The remaining failure is **`recall-true-yesterday`**, where the actual still ends in `reason:"parse-failed"`. The Codex post-review (2026-05-12) flagged that the original phrasing of this section mis-attributed the residual to "temporal over-anchoring"; the cache evidence shows it is a genuine parse-failed case. The empty-only retry guard introduced in the post-Batch-2 simplify pass means non-empty unparseable Gemma output now falls straight to safe-default; a follow-up open-item tracks this (see open-items.md).

### Chatbot bucket (post-correction, Gemma 26b judge)

```bash
pnpm test:regression -- --bucket=chatbot --model-matrix=ollama/gemma4:e4b --judge-model=ollama/gemma4:26b --no-cache --json
```

| Metric | Pre-correction (Claude judge per Correction #1) | Post-correction (Gemma 26b judge — real) |
|---|---|---|
| Pass | 5 | 0 |
| Fail | 5 | 0 |
| **Error** | **0** | **10** |
| `modelIds.standard` in cache | `claude-sonnet-4-6` | **`gemma4:26b`** ← Batch 0 fix verified |

**Override fix verified end-to-end.** Every fresh cache file shows `modelIds.standard: "gemma4:26b"` (vs `claude-sonnet-4-6` pre-correction). The `--judge-model=ollama/gemma4:26b` flag now genuinely propagates through to the rubric oracle's judge LLM.

**Codex P1 follow-up (2026-05-12) — rubric JSON-mode added:** the first Batch 5 pass left `regression/src/oracles/rubric.ts` without `responseFormat: 'json'` on its judge call, so all 10 chatbot cases errored with empty Gemma output. The follow-up correction added the option (mirroring Batch 2), reused the shared `tryParseJsonStripFences` helper, and added two regression-guard tests. Re-run result: **3/10 pass, 0 fail, 7 error.** The 7 errors are now a different class of Gemma 26b failure: the model emits the opening `{"score": N,` correctly but then collapses into degenerate token-repetition (whitespace loops, `amount_amount_amount`, etc.), producing unparseable JSON even at `maxTokens: 400`. This is an honest model-quality signal — the framework correctly refuses to grade a misbehaving judge response.

**Important:** the chatbot food-app replies are *mixed*. Cases that prompt for a plain item dump (`chatbot-receipt-items-and-total`: "List the items and total from my most recent Costco receipt." → full 21-item list with subtotal/tax/total) and the routing-guard case (`chatbot-receipt-vs-meal-plan`: full receipt content, no meal-plan deflection) post excellent handler output.

`chatbot-costco-21-items` is NOT resolved (Codex 2026-05-12). The cache for that case (`data/system/regression-cache/chatbot-costco-21-items/edeebd9c…json`) shows the reply is a *diff view* — "1 updated, 1 new" (Spindrift, Blueberries) with the receipt total — not the full 21-item list the rubric requires (`MUST mention at least 5 of [Spindrift, Blueberries, Chicken, Eggs, Strawberries, Avocados, Coffee, Salmon, Yogurt, Olive Oil]`). The prompt's "call out which are new entries" framing routes to a different food handler (`new_receipt_items`-ish) that emphasizes the diff over the full list. The judge `verdict: 'error'` (Gemma 26b token-repetition) masked this handler defect. Tracked as a food/chatbot follow-up in `open-items.md`.

### Acceptance gate scorecard (after Codex P1 follow-up)

| Gate | Required | Actual | Result |
|---|---|---|---|
| (a) chatbot cache `modelIds.standard: "gemma4:26b"` on every fresh file | ✓ | ✓ (10/10) | **PASS** |
| (b) ≥5 of 27 food-shadow cases non-`parse-failed` | ≥5 | 27/27 non-parse-failed (18 pass) | **PASS** |
| (c) Recall bucket has zero `parse-failed` outcomes | 0 | **1 (`recall-true-yesterday`)** | **PARTIAL** — Codex correction; tracked in open-items.md |
| (d) PAS prefilter behavioral: e.g. "change my fast model" passes WITHOUT LLM call | ✓ | Unit-tested in `pas-classifier.test.ts` Batch 3 block | **PASS** |
| (e) Session-control prefilter: "what does /newchat do?" → `continue` with `source:'prefilter'` | ✓ | Unit-tested in `session-control-classifier.test.ts` Batch 3 block; live `session-control-continue` case now PASS | **PASS** |

**Framework gates (a)(b)(d)(e) pass.** Gate (c) is mostly green (24/25 recall pass) with one residual parse-failed case kept open in `docs/open-items.md`. The chatbot bucket shifted from "0/10 errors (rubric JSON-mode missing)" to "3/10 pass, 7 error (Gemma 26b token-repetition loops)" — the framework plumbing is correct; the residual is honest local-model signal.

### Follow-ups surfaced (tracked in `docs/open-items.md`)

1. ~~Rubric oracle JSON-mode plumbing~~ ✓ Fixed in Codex P1 follow-up (rubric.ts now passes `responseFormat: 'json'` and reuses `tryParseJsonStripFences`). 2 new regression-guard tests.
2. **Recall residual parse-failed case (`recall-true-yesterday`)** — 1 of 25 recall cases still ends in `reason:"parse-failed"`. The empty-only retry guard (Codex simplify pass) means non-empty unparseable Gemma output now falls straight to safe-default. Two options for the next iteration: (a) loosen retry to fire on parse-failure too (but then re-trigger the F9 flake the simplify pass was tightening), or (b) tighten `tryParseJsonStripFences` to handle more Gemma quirks (e.g., trailing prose after a valid object). Open-item tracks resolution.
3. **Chatbot bucket — 7/10 Gemma 26b judge errors are token-repetition loops, not framework bugs** — Gemma 26b begins emitting valid JSON (`{"score": N,`) and then degenerates into whitespace/word loops within the explanation field, producing unparseable output even at `maxTokens: 400`. Open-item tracks: try `top_p`/`repeat_penalty` Ollama options, or switch judge to a different local model when the rubric oracle gets a chance to expose those knobs through `LLMCompletionOptions`.
4. **Remaining 9 food-shadow label-mismatch failures under Gemma 4 e4b** — these are honest model-strength signals (not framework bugs). REQ-REG-011 at 89.62% means production flip of shadow classifier still gates on the higher-quality model.
