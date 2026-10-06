# Agent Runtime P1 — live chat smoke (2026-10-06)

## Setup

- Script SHA: `00c2edad8db8258c07f83fe5831e3e3e1c3e2ed7` (branch `claude/q4-agent-runtime-p1`, `scripts/llm-chat-smoke.ts`); `pnpm build` exit 0.
- Ollama `0.34.0` (`curl -s localhost:11434/api/version` → `{"version":"0.34.0"}`); models: `qwen3.8:27b-mlx`, `muse-glimmer:30b-mlx`, `gemma4:e4b`, `gemma4:31b`, `gemma4:26b`.
- Config: operator's `config/pas.yaml` and `.env` via temporary symlinks (removed afterwards, targets untouched). `agent:` unset, so defaults applied: `agent.model = ollama/qwen3.8:27b-mlx`, `agent.thinking = off`.
- Both runs under `set -o pipefail` with a trailing `smoke exit=$?` line (P2-9; spot check `(exit 1) | tee /dev/null; echo $?` → `1` in zsh and bash).
- Evidence files: `~/Projects/pas-q4-review-evidence/smoke-local-00c2eda.txt`, `smoke-anthropic-00c2eda.txt`.

## Run 1 — local steps (`pnpm llm-chat-smoke`)

```
> personal-automation-system@0.1.0 llm-chat-smoke /Users/mdittler/Projects/personal-automation-system/.claude/worktrees/infallible-chaum-723390
> tsx scripts/llm-chat-smoke.ts
[dotenv] injecting env (12) from .env
agent.model = ollama/qwen3.8:27b-mlx (ollama); agent.thinking = off; providers = anthropic, ollama, ollama-v1-smoke
STEP 1 ollama capabilities: PASS — supportsTools=true supportsVision=true
STEP 2 ollama tool round-trip: PASS — 5760 ms; step1 usage={"inputTokens":359,"outputTokens":28} step2 usage={"inputTokens":433,"outputTokens":25}; thinking=absent; answer="Your most recent Costco trip on September 9, 2026, totaled $113.42."
{"level":40,"time":1791283896998,"pid":38314,"hostname":"Matthews-Mac-mini.local","service":"provider-ollama","attempt":1,"maxRetries":2,"delayMs":500,"error":"model 'does-not-exist:1b' not found","msg":"Retrying after failure"}
{"level":40,"time":1791283897510,"pid":38314,"hostname":"Matthews-Mac-mini.local","service":"provider-ollama","attempt":2,"maxRetries":2,"delayMs":1000,"error":"model 'does-not-exist:1b' not found","msg":"Retrying after failure"}
STEP 3 negative: unreachable model: PASS — 1536 ms (limit 5000); model 'does-not-exist:1b' not found
STEP 4 negative: pre-aborted signal: PASS — AbortError: This operation was aborted
STEP 5 in-flight abort: PASS — AbortError after 304 ms; message=This operation was aborted
STEP 6 tools refused on non-tool model: SKIP — gemma4:e4b reports tools; nothing to refuse
STEP 7 anthropic tool round-trip: SKIP — pass --anthropic to run (claude-haiku-4-5-20251001, ≈ $0.003, cap $0.01)
STEP 8 openai-compatible (ollama /v1) tool round-trip: PASS — answer="Your most recent Costco trip on September 9, 2026 cost $113.42."; usage1={"inputTokens":357,"outputTokens":63} usage2={"inputTokens":431,"outputTokens":70}; spend=$0.0000 (cap $0)
STEP 9 llama.cpp tool round-trip: SKIP — pass --llama-cpp <url> (llama-server must run with --jinja)
SMOKE PASS
smoke exit=0
```

(Two `level:40` retry lines from step 3's provider logger were emitted and are elided from the table; they show the 2-retry schedule, 500 ms + 1000 ms.)

## Run 2 — with the paid step (`pnpm llm-chat-smoke -- --anthropic`)

```
> personal-automation-system@0.1.0 llm-chat-smoke /Users/mdittler/Projects/personal-automation-system/.claude/worktrees/infallible-chaum-723390
> tsx scripts/llm-chat-smoke.ts -- --anthropic
[dotenv] injecting env (12) from .env
agent.model = ollama/qwen3.8:27b-mlx (ollama); agent.thinking = off; providers = anthropic, ollama, ollama-v1-smoke, anthropic-smoke
STEP 1 ollama capabilities: PASS — supportsTools=true supportsVision=true
STEP 2 ollama tool round-trip: PASS — 7113 ms; step1 usage={"inputTokens":359,"outputTokens":28} step2 usage={"inputTokens":433,"outputTokens":26}; thinking=absent; answer="Your most recent Costco trip was $113.42 on 2026-09-09."
STEP 3 negative: unreachable model: PASS — 1533 ms (limit 5000); model 'does-not-exist:1b' not found
STEP 4 negative: pre-aborted signal: PASS — AbortError: This operation was aborted
STEP 5 in-flight abort: PASS — AbortError after 302 ms; message=This operation was aborted
STEP 6 tools refused on non-tool model: SKIP — gemma4:e4b reports tools; nothing to refuse
STEP 7 anthropic tool round-trip: PASS — answer="Your most recent Costco trip on September 9, 2026 cost $113.42."; usage1={"inputTokens":663,"outputTokens":58} usage2={"inputTokens":755,"outputTokens":25}; spend=$0.0018 (cap $0.01)
STEP 8 openai-compatible (ollama /v1) tool round-trip: PASS — answer="Your most recent Costco trip cost $113.42."; usage1={"inputTokens":357,"outputTokens":84} usage2={"inputTokens":431,"outputTokens":62}; spend=$0.0000 (cap $0)
STEP 9 llama.cpp tool round-trip: SKIP — pass --llama-cpp <url> (llama-server must run with --jinja)
SMOKE PASS
smoke exit=0
```

## Per-step results

| Step | Expected | Observed (run 1 / run 2) | Result |
|---|---|---|---|
| 1 capabilities | tools and vision both true | `supportsTools=true supportsVision=true` | PASS / PASS |
| 2 ollama tool round-trip | `lookup_receipt_total({store:"Costco"})`, answer has 113.42, thinking absent | 5760 ms / 7113 ms; `thinking=absent`; answer contains `$113.42` | PASS / PASS |
| 3 unreachable model | "not found" in < 5000 ms | 1536 ms / 1533 ms (limit 5000) | PASS / PASS |
| 4 pre-aborted signal | `AbortError`, no network | `AbortError: This operation was aborted` | PASS / PASS |
| 5 in-flight abort | `AbortError` in < 2000 ms | 304 ms / 302 ms | PASS / PASS |
| 6 tools on non-tool model | `LLMToolsUnsupportedError` or SKIP with reason | `gemma4:e4b reports tools; nothing to refuse` | SKIP / SKIP |
| 7 anthropic round-trip | `claude-haiku-4-5-20251001`, 2 calls, `maxTokens` 64, spend <= $0.01 | not run / usage1 663 in 58 out, usage2 755 in 25 out; `spend=$0.0018 (cap $0.01)` | SKIP / PASS |
| 8 openai-compatible via Ollama `/v1` (llama-cpp type) | both calls answer 113.42; spend $0 | usages printed; `spend=$0.0000 (cap $0)` | PASS / PASS |
| 9 llama.cpp | optional | not requested | SKIP / SKIP |

Both runs: `SMOKE PASS`, `smoke exit=0`.

## Anthropic spend

Measured by `CostTracker` at the corrected $1/$5 rate: `$0.0018`. Hand check from the printed usages: (663 + 755) x 1e-6 + (58 + 25) x 5e-6 = 0.001418 + 0.000415 = 0.001833, consistent with $1/$5 (P2-2). The operator authorized exactly these 2 Haiku calls; no other paid call was made (the paid step ran once, first attempt PASS).

## Guard mechanical proofs

| Guard | Break | Observed | Restored |
|---|---|---|---|
| Exit 2 on non-local `agent.model` | scratch `pas.yaml` with `agent: {model: {provider: anthropic, model: claude-haiku-4-5-20251001}}` (symlink pointed at the scratch copy) | `agent.model anthropic/claude-haiku-4-5-20251001 is served by provider type 'anthropic', not a local one; refusing …`, exit code 2 before any step | symlink re-pointed |
| Step 1 requires vision | `tools && vision` → `tools && !vision` | `STEP 1 … FAIL — supportsTools=true supportsVision=true` | `cp` from backup, diff clean |
| Step 3 `< 5000 ms` | limit → `elapsed < 1` | `STEP 3 … FAIL — 1539 ms (limit 5000); model 'does-not-exist:1b' not found` | same |
| Step 8 / shared spend cap (`roundTrip` `underCap`) | step 8 cap `0` → `-1` (local, costs nothing; step 7 shares the same predicate) | `STEP 8 … FAIL … spend=$0.0000 (cap $-1)` with a correct answer, so only the cap predicate failed | same |

The three mutations ran in one local run: `SMOKE FAIL (3 step(s))`, exit 1, steps 2/4/5 still PASS.

## Cost-fix negative evidence (Task 10 Step 3)

The usage-on-failure path (failed paid calls keep their usage) has no live trigger on free Ollama and is not covered by this smoke; the Task 2/4 unit tests are the evidence.

## Code changes needed by the smoke

None. No step failed for a P1 defect.

## Caveats

Single run per configuration, warm model, one tool, one prompt. Step 6 is SKIP because `gemma4:e4b` reports native tool support on this Ollama, so the refusal path has no live coverage here (unit-tested). Step 8 shows Ollama `/v1` accepts `tools` and the `tool` role for `qwen3.8:27b-mlx` (N6). `pnpm llm-chat-smoke -- --anthropic` forwards a literal `--` into argv, which the script ignores.
