# Persona Regression Suite

A fixture-backed, cached, real-LLM regression suite for the PAS classifier and
parser surfaces. Sits outside the root `pnpm test` so it doesn't run on every
push (REQ-REG-001). Run it intentionally before merging changes that touch the
shadow classifier, the session-control NL classifier, the PAS-relevance
classifier, or the receipt parser.

## Quick start

```sh
pnpm test:regression                    # run all buckets, respect cache, exit 0/1 per REQ-REG-011
pnpm test:regression -- --help          # show CLI help
pnpm test:regression -- --dry-run       # print estimated cost without LLM calls
pnpm test:regression -- --bucket=routing
pnpm test:regression -- --rerun food-user-wants-to-save-a-recipe
pnpm test:regression -- --json          # line-delimited JSON events (used by GUI)
```

## Exit codes

| code | meaning |
|------|---------|
| `0`  | REQ-REG-011 routing accuracy gate met, OR fewer than 20 food-shadow inputs evaluable (below floor). |
| `1`  | Routing accuracy < 0.95 across food-shadow inputs (gate failed) OR bad CLI args. |

## URS coverage (Chunk B.1)

- **REQ-REG-001** — workspace excluded from root `pnpm test`.
- **REQ-REG-002** — cache key includes git blob hashes of every coverage file.
- **REQ-REG-004** — structural oracle rejects schema-invalid LLM output.
- **REQ-REG-008** — per-case budget aborts the input loop precisely.
- **REQ-REG-009** — per-run budget hard-aborts remaining cases without dispatching.
- **REQ-REG-010** — run results persisted to `data/system/regression-cache/<id>/<key>.json`; history retained.
- **REQ-REG-011** — routing bucket: ≥ 0.95 accuracy across all food-shadow inputs (fail/error/budget-exceeded count against the gate).
- **REQ-REG-014** — `oracle: 'judge'` is reserved; declaring it throws.

## Where things live

| path | purpose |
|------|---------|
| `src/runner/index.ts` | `runSuite()` orchestrator + `runCli()` entrypoint |
| `src/runner/case-loader.ts` | Loads `.case.ts` and `index.ts buildCases()` modules |
| `src/runner/case-runners/` | Per-bucket dispatch (only `routing-runner.ts` wired in B.1) |
| `src/runner/dispatch.ts` | Metered adapters for FoodShadowClassifier / detectSessionControl / classifyPASMessage |
| `src/runner/markdown-report.ts` | REQ-REG-011 accuracy gate + stdout summary |
| `src/runner/budget.ts` | `CaseBudget` + `RunBudget` |
| `src/runner/cache.ts` | `CacheStore` (atomic write, schema-validated read) |
| `src/runner/build-deps.ts` | Production composition (CLI uses this) |
| `src/oracles/structural.ts` | AJV-based JSON-schema + dot-path assertion engine |
| `src/shared/types.ts` | Re-export of `@core/types/regression` for in-workspace ergonomics |
| `src/cases/routing/food-personas/index.ts` | Generated FOOD_PERSONAS cases (27 labels × N phrases) |
| `src/cases/routing/session-control/` | 3 strict session-control cases |
| `src/cases/routing/pas/` | 6 PAS classifier cases (positive + negative each output) |
| `src/__tests__/` | Unit + integration tests for the runner machinery |

## Adding a new routing case

For a food-shadow label: edit
`apps/food/src/routing/__tests__/shadow-classifier.personas.ts` — the case is
generated automatically. Add a contract-test failure? Edit the `accept[]` and
re-run `pnpm --filter @pas/regression test`.

For session-control or PAS: drop a `.case.ts` file under
`regression/src/cases/routing/<target>/`, exporting a `PersonaCase` as default.

## How the cache works

The cache key is a SHA-256 over: case-file git blob hash, every `coverage[]`
path's git blob hash, and the active tier model IDs. Touch any of those and
the cache key changes; the case re-dispatches. Cached entries live at
`data/system/regression-cache/<case-id>/<cache-key>.json` and are never
deleted (REQ-REG-010 — history retained).
