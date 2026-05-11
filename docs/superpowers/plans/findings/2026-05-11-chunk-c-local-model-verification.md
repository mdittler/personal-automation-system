# Chunk C Local-Model Verification — Findings Template

**Date:** 2026-05-11 (template seeded; operator fills in run results)
**Branch:** `regression/chunk-c`
**Plan ref:** `docs/superpowers/plans/2026-05-11-persona-regression-chunk-c.md` Task 14
**Codex baseline finding (pre-run):** `food-shadow` classifier returned empty raw response for "How much are blueberries at Costco?" under `gemma4:e4b`; recall classifier over-anchored "what did we say about the leak earlier?" with a date window when production schema expects `timeAnchor: null`.

---

## Prerequisites

- `ollama serve` running locally
- `gemma4:e4b` pulled (`ollama pull gemma4:e4b`)
- Optional: `gemma4:26b`, `gemma4:31b` for the standard-tier judge
- `OLLAMA_URL` configured in `config/pas.yaml` (or a sandboxed copy)
- `ANTHROPIC_API_KEY` set if using a Claude judge

## Known framework-level limitations (apply to all runs)

1. **`captureHandler` is a placeholder** (`build-deps.ts:144`): returns `null` for every dispatch. Chatbot cases with `expectedHandler` (all 10 of them per Task 10) will trip the runner's "routing diagnostic captured no handler" branch and emit `verdict: 'error'` regardless of reply quality. **Until this is wired, the chatbot bucket cannot produce meaningful findings.** First Task-14 follow-up: instrument the Router to record the last-invoked handler id and wire it into `captureHandler`.
2. **`endActiveSession` is a no-op** (`build-deps.ts:145`): chatbot cases dispatch without ending the prior session. With the current 10 chatbot cases this is OK in isolation (one runtime, fresh state) but introduces order-dependent behavior. Second Task-14 follow-up: wire to `chatSessions.endActive(...)`.
3. **`tokenCounts` are 0** across all runs — `LLMService.complete()` returns only the response string, dropping the `usage` object. Cost via `CostTracker` delta is authoritative; token-per-call breakdown requires a separate fix (see `docs/open-items.md` "LLMService.complete usage plumbing").

## Step 14.1 — Routing bucket smoke (Gemma fast tier)

```bash
pnpm test:regression --bucket=routing \
  --model-matrix=ollama/gemma4:e4b \
  --json > /tmp/regression-routing-gemma-e4b.ndjson
```

Expected pre-run signal (per Codex baseline): food-shadow returns empty raw for several inputs; structural oracle reports `verdict: 'fail'` (schema mismatch on empty); REQ-REG-011 accuracy gate likely below 0.95.

**Operator run output (fill in):**
- Total cases dispatched: ___
- Passing cases: ___
- Failing cases (schema fail): ___
- Erroring cases (LLM infrastructure): ___
- Routing accuracy: ___% (≥0.95 → exit 0; below → exit 1)
- Total cost: $___
- Total duration: ___ ms

**Specific failures to investigate:**
- [ ] List failing case IDs with the failing input phrasing.
- [ ] Note empty-raw-response cases separately (model-compatibility, not regression).

**Follow-up actions filed:**
- (Add to `docs/open-items.md` Confirmed Phases if a systematic prompt fix is needed.)

## Step 14.2 — Recall bucket smoke (Gemma fast tier)

```bash
pnpm test:regression --bucket=recall \
  --model-matrix=ollama/gemma4:e4b \
  --json > /tmp/regression-recall-gemma-e4b.ndjson
```

Expected pre-run signal: `recall-true-pronoun-leak` fails because Gemma over-anchored a non-temporal phrase with a window (Codex baseline finding). Pre-filter cases (`recall-false-greeting`, `recall-false-thanks`) should zero-meter.

**Operator run output (fill in):**
- Total cases dispatched: 25
- Passing: ___
- Failing: ___
- Erroring: ___
- Total cost: $___

**Specific failures to investigate:**
- [ ] `recall-true-pronoun-leak` — confirm Gemma adds a window when none is expected; consider whether to relax the schema (accept null OR a wide window) or tighten the prompt.
- [ ] Temporal cases (`recall-true-yesterday`, `recall-true-last-friday`, etc.) — do exact dates match what Gemma emits with `today='2026-05-11'`?
- [ ] Observational cases (`recall-observ-it-was-so-good`, `recall-observ-that-was-helpful`) — verdict stays `pass` regardless?

## Step 14.3 — Chatbot bucket smoke (Gemma standard + Claude judge)

**Pre-requisite:** wire `captureHandler` so chatbot cases produce meaningful verdicts (see "Known framework-level limitations" #1 above).

```bash
pnpm test:regression --bucket=chatbot \
  --model-matrix=ollama/gemma4:e4b,ollama/gemma4:26b \
  --judge-model=anthropic/claude-sonnet-4-7 \
  --json > /tmp/regression-chatbot-gemma-claude-judge.ndjson
```

Why a Claude judge: the rubric judge needs reliable JSON. Gemma 26b can do this but flakier — Claude removes that variable so we see real chatbot quality, not judge parser errors.

**Operator run output (fill in):**
- Total cases dispatched: 10
- Passing: ___
- Failing: ___ (rubric score < 4)
- Erroring: ___ (judge parse / handler diagnostic / runtime throw)
- Total cost: $___

**Per-case findings:**
- `chatbot-costco-21-items` — judge score: __, reasoning gap (if any):
- `chatbot-last-costco-trip` — score: __, gap:
- `chatbot-receipt-vs-meal-plan` — score: __, gap:
- `chatbot-receipt-items-and-total` — score: __, gap:
- `chatbot-cheapest-blueberries` — score: __, gap:
- `chatbot-store-spending` — score: __, gap:
- `chatbot-grocery-list-empty` — score: __, gap:
- `chatbot-blueberries-at-costco` — score: __, gap:
- `chatbot-costco-last-items` — score: __, gap:
- `chatbot-new-receipt-items` — score: __, gap:

## Step 14.4 — Chatbot bucket smoke (Gemma judge)

```bash
pnpm test:regression --bucket=chatbot \
  --model-matrix=ollama/gemma4:26b \
  --judge-model=ollama/gemma4:26b \
  --json > /tmp/regression-chatbot-gemma-judge.ndjson
```

Compare to Step 14.3 — judge disagreement count is the calibration signal for the rubric oracle on local judges.

**Judge disagreement table (fill in):**

| Case | Claude verdict | Gemma verdict | Same? |
|---|---|---|---|
| chatbot-costco-21-items | | | |
| chatbot-last-costco-trip | | | |
| ... | | | |

**Disagreement rate:** ___% (over 10 chatbot cases). If >20%, record in `docs/open-items.md` Accepted Risks: "Local Gemma rubric judge cannot be trusted without explicit calibration."

## Step 14.5 — Final summaries + file follow-ups

For each anomaly identified above:
1. Classify as **framework defect** (the regression framework misbehaves) vs **model compatibility issue** (Gemma cannot do this; document and accept) vs **prompt-tightening opportunity** (Gemma could do this with a better classifier/parser prompt).
2. File the relevant follow-up:
   - Framework defects → fix in a follow-up commit before Task 16 final verification.
   - Model compatibility → `docs/open-items.md` Accepted Risks.
   - Prompt tightening → `docs/open-items.md` Confirmed Phases or Proposals.

## Step 14.6 — Sign-off

Once findings are recorded above and follow-ups are filed:
- [ ] Each Step 14.x run completed with output captured.
- [ ] Each anomaly classified.
- [ ] Follow-up entries added to `docs/open-items.md`.
- [ ] Findings doc committed.

```bash
git add docs/superpowers/plans/findings/2026-05-11-chunk-c-local-model-verification.md docs/open-items.md
git commit -m "docs(regression-C.14): local-model verification findings + follow-ups"
```
