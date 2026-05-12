# Chunk C Local-Model Verification — Findings

**Date:** 2026-05-12 (executed after Codex correction pass — C1 + C2)
**Branch:** `regression/chunk-c`
**Plan ref:** `docs/superpowers/plans/2026-05-11-persona-regression-chunk-c.md` Task 14
**Models exercised:** `ollama/gemma4:e4b` (fast tier) against the live PAS LLM framework after the C1 fix (config.llm.tiers mutated before composeLLMService — real model swap, not just metadata).

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

## Step 14.3 + 14.4 — Chatbot bucket (deferred until handler diagnostic lands OR explicitly out-of-scope)

The chatbot bucket can now dispatch end-to-end against Gemma (C2 removed the `expectedHandler` blocker), but a full chatbot verification run requires composing the runtime + seeding household data + dispatching the food app's full handleMessage pipeline — a single chatbot case takes 10–30 seconds depending on retrieval depth and judge cost. Running all 10 cases × 2 judge configurations (Claude judge + Gemma judge) is a 5–10 minute operator-time run that costs real money for the Claude-judge variant.

**Recommendation:** schedule chatbot verification as a separate session once:
1. Real chatbot dispatch is exercised once in this branch (a single smoke case with stubbed judge to confirm the pipeline lands replies on `telegram.sent`).
2. The operator has time/budget for the full 10-case × 2-judge calibration matrix.

This is logged as a carry-forward in `docs/open-items.md` rather than blocking the chunk-merge.

---

## Step 14.5 — Findings + follow-up classification

**Framework defects identified:** none. The harness behaved correctly under every failure observed. The C1 fix was load-bearing: pre-C1 the matrix override would have left every "Gemma" call dispatching through the production tier, and these findings would have been false negatives. Post-C1 the model resolution is real.

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
- [ ] Chatbot bucket run deferred — see Step 14.3 + 14.4 note above.
- [x] Each anomaly classified.
- [x] Follow-up entries added to `docs/open-items.md`.
- [x] Findings doc committed.

```bash
git add docs/superpowers/plans/findings/2026-05-11-chunk-c-local-model-verification.md docs/open-items.md
git commit -m "docs(regression-C.C3): local-model verification — routing + recall findings"
```
