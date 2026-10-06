# Persona Regression Suite

A fixture-backed, cached, real-LLM regression harness for the PAS classifier
and parser surfaces. Sits outside the root `pnpm test` so it doesn't run on
every push (REQ-REG-001). Run it intentionally before merging changes that
touch the shadow classifier, the session-control NL classifier, the
PAS-relevance classifier, or the receipt parser.

## Quick start

```sh
# Dry-run: lists selected cases + estimated cost. No env vars required, no LLM call.
pnpm test:regression -- --dry-run

# Real run: composes the production LLMService stack. Requires the same env vars
# as `pnpm dev`: TELEGRAM_BOT_TOKEN, GUI_AUTH_TOKEN, and at least one provider
# API key (ANTHROPIC_API_KEY / GOOGLE_AI_API_KEY / OPENAI_API_KEY / OLLAMA_URL).
# Cache hits short-circuit dispatch — most cases run once and stay cached until
# their coverage files change.
pnpm test:regression

pnpm test:regression -- --help                        # show CLI help
pnpm test:regression -- --bucket=routing              # routing bucket only
pnpm test:regression -- --bucket=receipt              # receipt bucket only (5 fixtures)
pnpm test:regression -- --bucket=recall               # recall bucket only
pnpm test:regression -- --bucket=chatbot              # chatbot bucket only
pnpm test:regression -- --bucket=agent                # agent bucket only (46 outcome-graded tasks)
pnpm test:regression -- --bucket=agent --repeats=3    # trials per agent task (default 3, range 1..10); a task passes only if all k pass
pnpm test:regression -- --bucket=agent --case=agent-grocery-list --no-cache   # select tasks by id (repeatable; --case=<id> or --case <id>)
pnpm test:regression -- --archive-cache               # move the cache to <cacheDir>-archive/<stamp>/ and exit; history preserved
pnpm test:regression -- --rerun food-save-a-recipe    # force one fresh dispatch
pnpm test:regression -- --json                        # line-delimited JSON events (used by GUI subprocess)
```

`--rerun <id>` bypasses the cache for that case but does **not** select it:
the rest of the run still executes. `--case <id>` selects: only the named cases
are dispatched (after the `--bucket` filter), and an unknown id is an error.
Combine them to force one fresh dispatch of one case.

**Agent heartbeat.** Each agent trial runs in its own worker process and
reports a cost/turn meter after every turn and every 2 s. The CLI relays every
meter live so a 15-minute trial never looks stalled: under `--json` it is an
NDJSON line `{"type":"heartbeat", ...}` on stdout (interleaved with
`case-result` and `summary` lines; the GUI parser tolerates it and it re-arms
the GUI's 10-minute stall watchdog), otherwise a progress line on stderr.
When the CLI receives SIGTERM, SIGINT, or SIGHUP it SIGKILLs live workers,
logs each one's last meter as a `worker-terminated` stderr line, and exits
128+signal. Note that pnpm prints its own two-line banner on stdout before the
CLI output; filter on lines starting with `{` when parsing.

**Note on tokens:** the GUI displays per-case cost (authoritative, via
`CostTracker` delta) but token counts are currently 0. `LLMService.complete()`
returns only the response string; per-call token usage isn't exposed yet.
The Chunk B.2 GUI design surfaces cost prominently and renders tokens as "—".

## Exit codes

| code | meaning |
|------|---------|
| `0`  | REQ-REG-011 routing accuracy gate met, OR fewer than 20 food-shadow inputs evaluable (below floor). |
| `1`  | Routing accuracy < 0.95 across food-shadow inputs (gate failed) OR bad CLI args. |

## URS coverage

- **REQ-REG-001** — workspace excluded from root `pnpm test`.
- **REQ-REG-002** — cache key includes git blob hashes of every coverage file.
- **REQ-REG-003 / 007 / 013 / 015 / 016 / 017** — `/gui/regression` admin page (Chunk B.2).
- **REQ-REG-004** — structural oracle rejects schema-invalid LLM output. Includes the `multiset` operative (duplicate-preserving tuple equality for receipt line items).
- **REQ-REG-005** — rubric oracle (chatbot bucket, standard-tier judge).
- **REQ-REG-006** — fixture integrity (SHA-256) verified at runtime for chatbot env + at test time for receipt fixtures via `receipt-cases.shape.test.ts`.
- **REQ-REG-008** — per-case budget aborts the input loop precisely.
- **REQ-REG-009** — per-run budget hard-aborts remaining cases without dispatching.
- **REQ-REG-010** — run results persisted to `data/system/regression-cache/<id>/<key>.json`; history retained. Cache key includes a bucket-specific salt; see "How the cache works" below.
- **REQ-REG-011** — routing bucket: ≥ 0.95 accuracy across all food-shadow inputs (fail/error/budget-exceeded count against the gate).
- **REQ-REG-012** — chatbot env per-run isolation (temp `data/` dir, disposed in `finally`).
- **REQ-REG-014** — `oracle: 'judge'` is reserved; declaring it throws.
- **REQ-REG-023** — `error` / `budget-exceeded` verdicts are never cached; legacy entries read as misses.
- **REQ-REG-024** — cache key binds the case id and the bucket's harness sources (`BUCKET_HARNESS_PATHS`).
- **REQ-REG-025** — each chatbot case runs in a freshly seeded runtime, disposed afterwards.
- **REQ-REG-026** — the rubric judge sees the seed reference data and is told which block is the reply.
- **REQ-REG-027** — `--archive-cache` archives the cache and leaves it empty.
- **REQ-REG-AGENT-001..004** — agent bucket: outcome oracle, per-trial worker + pass^k, 46 seed-grounded tasks, report/dry-run/`--case`.

## Where things live

| path | purpose |
|------|---------|
| `src/runner/index.ts` | `runSuite()` orchestrator + `runCli()` entrypoint |
| `src/runner/case-loader.ts` | Loads `.case.ts` and `index.ts buildCases()` modules |
| `src/runner/case-runners/` | Per-bucket dispatch: `routing-runner.ts` (B.1), `recall-runner.ts` + `chatbot-runner.ts` (C), `receipt-runner.ts` (A.2, calls real `parseReceiptFromPhoto`) |
| `src/runner/dispatch.ts` | Metered adapters for FoodShadowClassifier / detectSessionControl / classifyPASMessage |
| `src/runner/markdown-report.ts` | REQ-REG-011 accuracy gate + stdout summary |
| `src/runner/budget.ts` | `CaseBudget` + `RunBudget` |
| `src/runner/cache.ts` | `CacheStore` (atomic write, schema-validated read) |
| `src/runner/build-deps.ts` | `buildProductionDeps` (full LLM stack) + `buildDryRunDeps` (no env) + `buildMetadataDeps` (--list mode) |
| `src/oracles/structural.ts` | AJV-based JSON-schema + dot-path assertion engine (incl. `multiset` operative for duplicate-preserving tuple equality) |
| `src/oracles/rubric.ts` | Standard-tier judge LLM with score-≥-4 pass threshold (chatbot bucket only) |
| `src/shared/types.ts` | Re-export of `@core/types/regression` for in-workspace ergonomics |
| `src/shared/cache-key.ts` | `computeCacheKey` + `bucketCacheSalt` (receipt-bucket date+timezone binding) |
| `src/cases/routing/food-personas/index.ts` | Generated FOOD_PERSONAS cases (27 labels × N phrases) |
| `src/cases/routing/session-control/` | 3 strict session-control cases |
| `src/cases/routing/pas/` | 6 PAS classifier cases (positive + negative each output) |
| `src/cases/recall/` | 25 recall classifier cases (13 true / 10 false / 2 observational; pinned `today`) |
| `src/cases/chatbot/` | 10 rubric-graded chatbot cases (migrated from v0 corpus) |
| `src/cases/receipt/` | 5 receipt-parser cases (4 real photos + 1 synthetic expired-90d) |
| `src/cases/agent/` | 46 outcome-graded agent tasks (`index.ts`), task schema (`types.ts`), seed-derived expected values (`seed-facts.ts`) |
| `src/oracles/outcome.ts` | Deterministic outcome oracle for the agent bucket (facts, forbidden phrases, file state, unchanged paths) |
| `src/runner/agent-trial*.ts`, `case-runners/agent-runner.ts` | One worker process per trial, pass^k case runner, infrastructure-first verdicts |
| `fixtures/agent/` | Synthetic household seed (`household/`), injection overlays (`overlays/`), `seed.sha256` integrity manifest |
| `fixtures/receipts/` | Photos + `.expected.json` sidecars + `.sha256` manifests + `.true.md` transcriptions |
| `scripts/generate-agent-seed.py` | Generates the synthetic agent-seed receipts |
| `scripts/generate-expired-receipt.py` | Pillow-based synthetic fixture generator for `expired-90d.jpg` |
| `src/__tests__/` | Unit + integration tests for the runner machinery |

## Adding a new routing case

For a food-shadow label: edit
`apps/food/src/routing/__tests__/shadow-classifier.personas.ts` — the case is
generated automatically. Add a contract-test failure? Edit the `accept[]` and
re-run `pnpm --filter @pas/regression test`.

For session-control or PAS: drop a `.case.ts` file under
`regression/src/cases/routing/<target>/`, exporting a `PersonaCase` as default.

## Adding a new receipt case

1. Add the photo + sidecar to `regression/fixtures/receipts/<name>.{jpg,expected.json,sha256,true.md}`.
   The `.sha256` must record the photo's SHA-256 (run inside the fixtures dir:
   `shasum -a 256 <name>.jpg > <name>.sha256` — keeps the basename canonical).
2. Add a `.case.ts` file at `regression/src/cases/receipt/<name>.case.ts` with
   the photo + sidecar paths in `coverage[]` so fixture edits invalidate the
   cache (REQ-REG-010).
3. `pnpm --filter @pas/regression test src/__tests__/receipt-cases.shape.test.ts`
   will assert photo SHA-256 ↔ manifest match, sidecar shape, and that every
   `coverage[]` path resolves.

For an `expectRejection: true` sidecar (the parser's `isValidReceiptDate`
rejection branch), include `rejectedDate: 'YYYY-MM-DD'` so the runner asserts
the parser preserved `rawExtractedDate` for audit. The synthetic
`expired-90d.jpg` is the canonical example — regenerate it with
`python3 -m pip install --user Pillow && python3 scripts/generate-expired-receipt.py`.

## Adding an agent task

Edit `src/cases/agent/index.ts` and add one `TaskDef` to the task list.

1. Pick a `category` (single-fact, aggregation, out-of-distribution, write,
   no-tool, multi-turn, photo, injection) and a `set`: `regression` should stay
   near 100%, `capability` starts low and measures progress.
2. Take every expected number, string, or date from `seedFacts` (`F.latest(...)`,
   `F.previous(...)`, ...) rather than typing it, so the ground truth is
   derived from the seed and pinned by `agent-cases.test.ts`. Use explicit
   years in questions so they never depend on "today".
3. Grade outcomes only: `facts` in the reply, `forbidden` phrases, `dataState`
   (files and list items), and `unchanged` paths. Never assert which tools ran.
4. Injection tasks must set `noExternalMessages: true` and list `notes/` and
   `context/` under `unchanged`; the test enforces it. Put attacker content in
   an overlay directory under `fixtures/agent/overlays/`.
5. Keep `budgetUsd` at the bucket default ($0.75) and the id prefixed `agent-`.
6. If you change the task count, update the pinned count in
   `src/__tests__/agent-cases.test.ts`. Run `pnpm --filter @pas/regression test`.

## Changing the agent seed

Edit the YAML/Markdown under `fixtures/agent/household/` (or an overlay), or
`scripts/generate-agent-seed.py` for the receipts, then regenerate the
integrity manifest and update the pin test:

```sh
cd regression/fixtures/agent && find household overlays -type f | LC_ALL=C sort | xargs shasum -a 256 > seed.sha256 && wc -l seed.sha256 && cd -
```

`agent-environment.test.ts` pins the number of files in the manifest (20 at
P0); `agent-cases.test.ts` pins the derived facts against the receipts.
Grocery items must use Food's canonical departments. Any seed change alters
the cache keys of every agent case (the manifest is a harness path), so
re-baseline afterwards.

## How the cache works

The cache key is a SHA-256 over: case-file git blob hash, every `coverage[]`
path's git blob hash, the active tier model IDs, and (for the `receipt` bucket
only) a salt derived from today's date + the configured timezone. Touch any of
those and the cache key changes; the case re-dispatches. The key also binds the case id and the bucket's harness sources
(`BUCKET_HARNESS_PATHS` in `src/shared/cache-key.ts`: runner, oracle, seed
manifest, LLM layer), and the agent bucket's repeat count (REQ-REG-024).
`error` and `budget-exceeded` verdicts are never written, and any such legacy
entry on disk is a miss (REQ-REG-023). Cached entries live at
`data/system/regression-cache/<case-id>/<cache-key>.json` and are never deleted
(REQ-REG-010 — history retained); `--archive-cache` moves them aside to a dated
archive directory instead of deleting them (REQ-REG-027).

The receipt-bucket date salt is what makes the synthetic `expired-90d` fixture
re-exercise after a date rollover: the parser's `isValidReceiptDate` rejection
branch depends on "today", so yesterday's cached "verdict: pass" should not mask
a regression that surfaces on a different "today". Same-day reruns still hit
cache. Routing / recall / chatbot buckets are not salted. The salt
implementation is in `src/shared/cache-key.ts:bucketCacheSalt`; both
`runSuite()` and `--list` mode go through the same helper so the GUI's
`currentCacheKey` indicator agrees with what the next real dispatch will read.
