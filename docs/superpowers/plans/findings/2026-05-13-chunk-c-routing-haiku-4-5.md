# Stronger-Routing-Model Sweep — Claude Haiku 4.5

**Date:** 2026-05-13
**Branch:** `regression/stronger-routing-models`
**Plan ref:** `~/.claude/plans/can-you-start-on-splendid-whisper.md`
**Model under test:** `anthropic/claude-haiku-4-5-20251001` as the fast tier
**Standard tier (rubric judge):** unswapped (`anthropic/claude-sonnet-4-6`)
**Prompts:** v3 — same prefilter + classifier prompt state as Gemma 31B v3 run.

## Why this run

After Gemma 4 31B v3 cleared the 0.95 gate at 0.9811 per-input routing accuracy, operator asked for one frontier-model comparison point to see whether a hosted model materially improves the result. (Operator explicitly declined to sweep Sonnet 4.6.)

## Results

| Bucket | Pass | Fail | Error | Routing accuracy | Cost | Duration |
|---|---|---|---|---|---|---|
| Routing | 30/36 | 4 | 2 | **0.9151** ❌ | $0.084 | 112 s |
| Recall | 24/25 | 1 | 0 | — | $0.024 | 25 s |
| Chatbot | 2/10 | 8 | 0 | — | $0.128 | 92 s |

**Haiku 4.5 fails the 0.95 routing accuracy gate (0.9151)** — below Gemma 4 31B's 0.9811 on the same prompts.

## Routing fail breakdown

| Case | Inputs failing | Pattern |
|---|---|---|
| `food-user-wants-holiday-or-cultural-recipe-suggestions` | 4/4 | Haiku routes "what should I cook for Thanksgiving", "Christmas dinner ideas", "Eid recipes", "Lunar New Year dishes" to **`user wants to search for a recipe`** instead of the holiday-specific label. Haiku over-generalizes cultural-context to general recipe search. |
| `food-user-has-a-food-related-question` [3] | 1 | "what goes well with roast chicken?" → `user wants to know what they can make with what they have`. Different mispick than 31B's. |
| `food-user-wants-to-adapt-a-recipe-for-a-child` [0] | 1 | "make the chicken stir fry for Margot" → `user wants to start cooking a recipe`. Same semantic ambiguity as 31B. |
| `food-user-wants-to-log-a-meal-they-cooked` [2] | 1 | "just had some leftover chicken" → `user wants to log leftovers`. Same as 31B — input is genuinely ambiguous. |
| `food-user-wants-to-see-nutrition-information` [0] | 1 | "show me my macros" → `macro-targets`. Same as 31B. |
| `food-user-wants-to-see-nutrition-information` [2] | 1 (error) | "how many calories are in this?" — **unparseable output**. |
| `food-user-wants-holiday-or-cultural-recipe-suggestions` [0] | 1 (error, included in 4/4 above) | "what should I cook for Thanksgiving?" — **unparseable output**. |
| `pas-data-query-negative` [3] | 1 | "what does Hermes do" → `pasRelated:false`. Same as 31B — Hermes is an internal name no model recognizes. |

## Recall + chatbot — same as Gemma 31B

- **Recall**: `recall-true-yesterday` returned `reason: parse-failed`. Same residual as `docs/open-items.md` line 272.
- **Chatbot**: 2/10 pass. Same failure pattern as 31B — dominated by the Claude-judge "no actual reply" defect (open-items.md line 274) and the `chatbot-costco-21-items` food-handler defect (line 285). The 2 passing cases are different inputs than 31B's 2 — judge-quality noise, not signal about routing.

## Why Haiku underperforms 31B here

Two distinct gaps:

1. **Cultural/holiday-specific recipe handling** — Haiku 4.5 collapses cultural specificity into "general recipe search". Gemma 31B treats the labels more literally and correctly picks the holiday/cultural label. This is plausibly a training-data difference; Haiku has seen more general "search for a recipe" patterns and over-anchors on that.
2. **2 unparseable outputs** — Haiku occasionally emits non-JSON despite `responseFormat: 'json'` (it's the Anthropic SDK's `response_format`, not Ollama's `format`). The framework correctly classifies these as `error` verdicts.

Where Haiku and 31B agree (5 cases), the inputs are arguably **fixture quality issues** — see Gemma 31B doc.

## Conclusion

**Claude Haiku 4.5 is not better than Gemma 4 31B on this routing benchmark.** The 0.9151 result fails the 0.95 gate; the holiday/cultural recipe pattern is a recurring miss that prompt-hardening would have to address case-by-case. At $0.236 per full sweep vs free for local Gemma, this is the wrong direction.

Operator declined Sonnet 4.6 sweep. If a frontier-model comparison is wanted later, Sonnet would likely close the holiday-recipe gap (frontier models are stronger at preserving label literal-ness) but the cost differential is meaningful at scale.

## Reproduce

```bash
git checkout regression/stronger-routing-models
pnpm test:regression -- --bucket=routing --model-matrix=fast=anthropic/claude-haiku-4-5-20251001 --no-cache --json
pnpm test:regression -- --bucket=recall  --model-matrix=fast=anthropic/claude-haiku-4-5-20251001 --no-cache --json
pnpm test:regression -- --bucket=chatbot --model-matrix=fast=anthropic/claude-haiku-4-5-20251001 --no-cache --json
```
