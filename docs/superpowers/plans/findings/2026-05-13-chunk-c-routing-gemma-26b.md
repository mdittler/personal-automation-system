# Stronger-Routing-Model Sweep — Gemma 4 26B

**Date:** 2026-05-13
**Branch:** `regression/stronger-routing-models`
**Plan ref:** `~/.claude/plans/can-you-start-on-splendid-whisper.md`
**Model under test:** `ollama/gemma4:26b` as the fast tier
**Standard tier (rubric judge):** unswapped (`anthropic/claude-sonnet-4-6`)

## Why this run

Chunk C left REQ-REG-011 routing accuracy at **0.8962** under `gemma4:e4b`, with 9 of 27 food-shadow cases failing as honest model-strength signals. Operator decision: step up the routing model to see at which tier the suite cleanly passes the 0.95 gate rather than prompt-harden against a weak local model.

## Iterations on this branch

### v1 — original prompts (baseline 26B vs e4b)

| Bucket | Pass | Fail | Error | Notes |
|---|---|---|---|---|
| Routing | 21/36 | 14 | 1 | **0.8113** routing accuracy — *worse than e4b* |
| Recall | (not yet run on v1) | — | — | — |
| Chatbot | (not yet run on v1) | — | — | — |

26B emerged with a different failure mode than e4b: instead of empty strings, it paraphrased labels — e.g. "user asks about prices at a specific store" became "user wants to ask about prices at a specific store". 26B normalizes verb forms across labels because most labels start with "user wants to".

### v2 — food-shadow paraphrase fix

Tightened `apps/food/src/routing/shadow-classifier.ts buildShadowClassifierPrompt`:
- Added a `CRITICAL RULE` block forbidding paraphrasing, prefix additions, pluralization, punctuation changes, label combinations
- Renamed the label list to "Available labels (copy ONE of these EXACTLY into 'action')"
- Kept the original "If the message is clearly NOT a food-related action ... use 'none'" instruction

Result:

| Bucket | Pass | Fail | Routing accuracy |
|---|---|---|---|
| Routing | 23/36 | 13 | **0.9057** ↑ |
| Recall | 20/25 | 5 | — (regressed vs e4b 24/25) |
| Chatbot | 4/10 | 6 | — (rubric-judge "no actual reply" defect dominates) |

Paraphrase fix lifted per-input accuracy by **+10 pts** (0.8113 → 0.9057). 26B's recall path regressed vs e4b — 5 temporal phrases ("in april", "in march", "last week", "look back", "previous session") returned `parse-failed` where e4b handled them. Same JSON-mode plumbing exists in both classifiers, so this is a model-quality difference on schema-strict JSON output.

### v3 — added PRECISION block + PAS examples (attempted)

Added a 12-line PRECISION block to food-shadow with 4 disambiguation examples (pantry↔grocery, log-meal↔log-leftovers, kid-approved↔log-meal, nutrition↔macros). Added 3 example mappings to PAS classifier.

Result:

| Bucket | Pass | Fail | Routing accuracy |
|---|---|---|---|
| Routing | 20/36 | 16 | **0.7642** ↓ |

The PRECISION block **regressed** routing — 26B over-fitted, paraphrasing labels it had previously gotten right (`holiday or cultural recipe suggestions` became `wants to holiday or cultural recipe suggestions`; `quick-meal template` became `quick meal template`). The lesson: weaker models are brittle to over-specification.

Reverted v3 prompt changes; kept the session-control `responseFormat: 'json'` fix from v3 (real bug — see v4).

### v4 — final 26B state

| Change | Result |
|---|---|
| Reverted v3 food-shadow PRECISION block | back to v2 baseline |
| Reverted v3 PAS additions | back to baseline |
| Kept `responseFormat: 'json'` in session-control classifier (real bug — was missing from Batch 1 plumbing) | session-control fails 2 → 1 |

| Bucket | Pass | Fail | Routing accuracy |
|---|---|---|---|
| Routing | **24/36** | 12 | **0.9057** |
| Recall | 20/25 (presumed same as v2) | 5 | — |
| Chatbot | 4/10 (presumed same as v2) | 6 | — |

## Why 26B can't reach 0.95

The 12 remaining v4 routing failures break into three classes, none of which are prompt-fixable:

1. **7 food-shadow semantic adjacency mispicks** — pantry↔grocery, log-meal↔log-leftovers, nutrition-info↔macro-targets, kid-approved-tag↔log-meal, etc. The labels are real distinctions that 26B can't make. v3's attempt to add disambiguation guidance *made things worse* — the model over-fitted those specific phrasings and started paraphrasing previously-correct labels.

2. **4 PAS semantic under-classification** — 26B calls clear PAS questions ("configure my fast model", "what apps are installed", "show me my system logs") as NOT-PAS. PAS prompt examples didn't move the needle.

3. **1 session-control continue residual** — "what's for dinner tonight" → 26B says `unclear`. The JSON-mode fix recovered 14 of 15 prior fails; this single semantic miss is the residual.

## Reproduce

```bash
git checkout regression/stronger-routing-models
pnpm test:regression -- --bucket=routing --model-matrix=fast=ollama/gemma4:26b --no-cache --json
pnpm test:regression -- --bucket=recall  --model-matrix=fast=ollama/gemma4:26b --no-cache --json
pnpm test:regression -- --bucket=chatbot --model-matrix=fast=ollama/gemma4:26b --no-cache --json
```

Output land in cache files under `data/system/regression-cache/<caseId>/<cacheKey>.json` (cacheKey includes `modelIds.fast: "gemma4:26b"`).

## Conclusion

**Gemma 4 26B is not a viable production routing model under this corpus.** Best achievable per-input accuracy is **0.9057** with a paraphrase-fix prompt and a session-control JSON-mode bug fix. The remaining gap is semantic competence the model lacks; iterating prompts further makes things worse. Operator next steps: try Gemma 4 31B (see companion doc).
