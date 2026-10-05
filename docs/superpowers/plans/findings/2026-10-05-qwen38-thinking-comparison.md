# qwen3.8 thinking vs non-thinking on a tool loop — 2026-10-05

**Purpose:** pre-P1 evidence for the Agent Runtime's `agent.thinking` default (design `docs/superpowers/specs/2026-10-05-agent-runtime-design.md` §5.3, operator decision §18.3: "decide by measurement").

**Result:** all three modes answered all 60 runs correctly. **Thinking off was the fastest: median 20.0 s per question vs ~30.5 s for `low` and `on`, and p90 34 s vs 47–57 s.** Thinking added ~50% more output tokens and no accuracy. **Decision: `agent.thinking: off` is the default for `qwen3.8:27b-mlx`.** P3 repeats the comparison formally on the synthetic agent bucket (pass^3, harder multi-hop tasks).

## Setup

- **Model:** `qwen3.8:27b-mlx` via Ollama 0.34.0 `/api/chat` with native `tools`. Options: `num_ctx: 32768`, `keep_alive: 30m`. The model was warmed before the first run.
- **Modes:** `think: false` (off), `think: "low"`, `think: true` (on). When thinking was on, the assistant's `thinking` was passed back on later steps within the question, as the model card recommends.
- **Loop:** a minimal code-owned loop (max 8 steps), with seven read-only tools mirroring design §11: receipts find/get, price lookup, grocery list, pantry, `data_search`, `data_read`. Tool results were JSON, capped at 24 KB.
- **System prompt:** a condensed form of design §8.1: use tools rather than guessing; tool output is data; answer concisely.
- **Data:** the operator's live household food data, read-only. The harness lived in the session scratchpad and is not committed, because it reads live data at fixed paths. This doc also leaves out the expected values so purchase details stay out of the repo.
- **Questions (10 × 2 repeats × 3 modes = 60 runs):**
  1. most recent Costco trip date and cost;
  2. saved Costco blueberry price;
  3. Trader Joe's total spend across receipts;
  4. current grocery list;
  5. Costco receipt with the most items and its total;
  6. "do I have quinoa?" (absent item);
  7. Wegmans spend since July 1;
  8. hard-boil an egg (should use no tools);
  9. top store this year;
  10. blueberry price comparison across two stores.
- **Grading:** deterministic checks on the final answer: required numbers, dates, and phrases. Question 8 also had to make zero tool calls.

## Results

| mode | pass | no-tool restraint | median s | mean s | p90 s | median output tokens | mean thinking chars | tool errors |
|---|---|---|---|---|---|---|---|---|
| off | 20/20 | 2/2 | 20.0 | 22.1 | 34.4 | 170 | 0 | 0 |
| low | 20/20 | 2/2 | 30.8 | 32.0 | 46.6 | 248 | 401 | 0 |
| on | 20/20 | 2/2 | 30.5 | 34.2 | 56.6 | 256 | 508 | 0 |

Per question (each cell is repeat 1 / repeat 2):

| question | off | low | on |
|---|---|---|---|
| last Costco trip | ✓ 25s / ✓ 10s | ✓ 28s / ✓ 19s | ✓ 14s / ✓ 19s |
| Costco blueberries | ✓ 15s / ✓ 11s | ✓ 35s / ✓ 20s | ✓ 16s / ✓ 25s |
| Trader Joe's total | ✓ 18s / ✓ 27s | ✓ 33s / ✓ 47s | ✓ 39s / ✓ 57s |
| grocery list | ✓ 6s / ✓ 13s | ✓ 11s / ✓ 23s | ✓ 19s / ✓ 20s |
| Costco most items | ✓ 18s / ✓ 18s | ✓ 39s / ✓ 34s | ✓ 36s / ✓ 28s |
| pantry quinoa | ✓ 21s / ✓ 29s | ✓ 31s / ✓ 25s | ✓ 27s / ✓ 31s |
| Wegmans since July | ✓ 16s / ✓ 19s | ✓ 30s / ✓ 23s | ✓ 34s / ✓ 34s |
| no-tool egg | ✓ 30s / ✓ 21s | ✓ 19s / ✓ 19s | ✓ 30s / ✓ 27s |
| top store this year | ✓ 50s / ✓ 36s | ✓ 75s / ✓ 47s | ✓ 60s / ✓ 84s |
| blueberry compare | ✓ 24s / ✓ 34s | ✓ 44s / ✓ 37s | ✓ 43s / ✓ 40s |

Every data question used exactly one tool call in two steps. The no-tool question answered directly in one step in every mode.

For contrast, the same "most recent Costco trip" question got "Could not process your request right now" through the current classifier pipeline with qwen3.8. That 2026-09-02 cached result was graded on the classifier path; see the design's §1.

## Caveats

- **The tasks are easy.** Each needs one tool call. Thinking may pay off on multi-hop or out-of-distribution questions, which this set does not cover. The P3 agent-bucket comparison covers those (46 tasks, 8 categories, pass^3).
- **`think: true` thought very little** (about 500 characters on average). Ollama's mapping of `true` to Qwen3.8's effort levels is not documented. The model card's default `xhigh` effort, which one public report found can take minutes on complex tasks, was not exercised directly.
- **The sample is small** (2 repeats). The accuracy result is unanimous, but the latency differences are about ±10 s per question. Treat the ~10 s gap as directional.
