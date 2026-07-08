# SR-4 — Regression Harness Seam (CaseRunner + CacheKeyContributor) — Design

**Date:** 2026-07-08
**Status:** Proposed (design pass — Codex-reviewed high effort + Fable-revised 2026-07-08;
no code in this phase). The Codex review (verdict "sound to build on with fixes") found 3
Major + 1 Minor, all resolved: (M1) the `ModelHandle` composition assertion was prose-only
— the profile now registers `modelHandles` so the desync check is a typed contract (§6,
stub `HarnessProfile.modelHandles`); (M2) opening the `bucket` union opens the harness but
not the GUI/read path — added §7.1 making the profile-provided valid-bucket set an explicit
cross-cutting migration step threaded through CLI / spawn-allowlist / discovery / manifest /
POST / UI; (M3) the stub omitted wire types the design changes — added proposed `RunSummary`
(+ `gateOutcomes`), `ManifestCaseResult` (+ `sourceId`), `RunManifest`; (Minor) the
standalone-typecheck command now documents the load-bearing `--lib es2020`. Also tightened
§5's no-newline salt invariant to apply to every contribution value.
**Design/interface-stub only — implementation is a future PAS phase (after SR-3, lowest
urgency; the seam is designed now because three consumers share it and retrofitting it
after any one of them ships means building it twice).**
**Author:** Fable 5 (strategic-design pass)
**Source analyses:** `docs/superpowers/plans/2026-07-07-fable-strategic-review.md` §SR-4
(issues `EXT-1..EXT-3`, open questions), the SR-4 entries in `docs/open-items.md`
(Confirmed Phases, line 83) and `docs/implementation-phases.md` ("SR-4 — Regression
Harness Extraction", line 3908), the "Regression Suite v2 — generic per-app test
discovery" proposal (`docs/open-items.md:340`), and AG-7 in
`docs/superpowers/plans/2026-07-07-agentic-harness-deep-dive.md:340-346` +
`docs/implementation-phases.md` AG-2 scope item 4.
**Companion interface stub:** `docs/superpowers/specs/regression-harness.interface.ts`
(a labeled PROPOSAL — declarations only, verified standalone with
`tsc --strict --noEmit --lib es2020` and `biome check` clean; never compiled into core or
the regression workspace).
**Companion designs (coherence):** `2026-07-07-sr-1-app-isolation-trust-model.md` (trust
tiers — §8 here gates app-provided runners on it) and
`2026-07-08-sr-2-channel-adapter-seam.md` (the two-surface discipline this design
reuses: consumers program against a profile, implementors fill a minimal contract).

> **Epistemic markers.** Every claim below is tagged. **[grounded]** = read directly
> from the current code (file path cited; regression-workspace paths are relative to
> `regression/src/`, core paths to `core/src/`). **[inference]** = a design conclusion
> drawn from grounded facts; not yet verified against a running build. **[decision]** =
> an opinionated call this design makes for the implementing phases to accept, amend, or
> reject. Nothing here is wired into production; the interface stub is a **proposal**.

---

## 1. Problem and the three consumers

The persona-regression suite's valuable core — budgeted, cached, model-swappable,
LLM-judged behavioral regression — is not separable from its PAS-specific runners
**[grounded — strategic review §SR-4 EXT-1..EXT-3]**:

- The orchestrator hard-codes a four-way bucket dispatch (`runner/index.ts:219-327`:
  `if bucket === 'routing' … else if 'recall' … else if 'chatbot' … else if 'receipt'`),
  and `RunSuiteOptions` carries one bespoke dependency field per bucket — `classifiers`,
  `recallAdapter`, `chatbotEnvFactory`, `judgeLlm`, `receiptLlm`
  (`runner/index.ts:65-95`) **[grounded, EXT-1]**. Adding a bucket means editing the
  orchestrator, the options type, the deps factories, and `VALID_BUCKETS`
  (`core/types/regression.ts:208-213` — a closed union baked into the case schema).
- Cache-key salts are a hardcoded per-bucket switch: `bucketCacheSalt` returns the
  receipt bucket's `today:<date>:tz:<tz>` and `undefined` for everything else
  (`shared/cache-key.ts:33-41`) **[grounded, EXT-2]**. A new consumer with new salt
  needs (`agent` tool-schema versions, an app's config digest) must edit the shared
  switch — the fork point EXT-2 names.
- Three consumers need the same seam, confirmed as one design job
  (`docs/open-items.md:83`: "design the seam once for all three") **[grounded]**:
  1. **SR-4 standalone extraction** — the core as a workspace package with zero
     `@core/*` imports, PAS buckets as the first adapter.
  2. **Regression Suite v2 — generic per-app test discovery**
     (`docs/open-items.md:340`) — apps declare regression cases; the same machinery
     discovers and runs them. Same abstraction "viewed from the inside" (strategic
     review §SR-4) **[grounded]**.
  3. **AG-7's `agent` bucket** (deep-dive:340-346) — seed a temp data tree, run a task
     at fixed budget, assert **final file state + budget/step compliance, never the
     tool-call sequence**. A different runner *shape* (world-mutation outcomes, not
     classifier verdicts) that must fit without a second runner abstraction (§7).

**Scope of this pass.** Design + interface stub only. No code moves, no package split,
no worktree. The implementing phase (post-SR-3) executes §10's migration with the
existing suite as the byte-identical verifier — the same acceptance discipline as SR-2.

---

## 2. What is already seam-shaped — and what is not (code-grounded)

The extraction is cheaper than it looks because the responsibility split inside
`runSuite` is already clean **[grounded]**:

**Orchestrator-owned (generic today, stays harness-core):** case loading with
duplicate-id fail-loud + deterministic id sort (`runner/case-loader.ts:26-67`);
up-front parallel cache-key computation with a shared `hashCache` memo
(`runner/index.ts:148-162`); parallel cache pre-reads with validated, tamper-rejecting
deserialization (`runner/cache.ts`, `looksLikeRunResult`); hard-abort `RunBudget`
pre-charge with synthesized `budget-exceeded` results carrying one `error` oracle
verdict per input so accuracy gates count skipped inputs (`runner/index.ts:202-216,
573-597`); dry-run synthesis; sequential dispatch; `onResult` streaming; manifest write
(`runner/index.ts:347-369`).

**Runner-owned (bucket-specific today, stays behind the seam):** the per-input loop,
per-case budget enforcement with pre-charge (`case-runners/routing-runner.ts:91-100`),
adapter dispatch, oracle invocation, verdict aggregation (error > fail > pass), and
metering via CostTracker deltas (`runner/dispatch.ts:70-95`).

**The three places the seam does NOT yet exist [grounded]:**

1. The bucket fork + per-bucket options fields (§1).
2. The run-budget pre-charge uses the *routing* runner's `ESTIMATE_TOKENS` for **every**
   bucket — `opts.estimateUsd(ESTIMATE_TOKENS) * max(1, inputs.length)`
   (`runner/index.ts:202`, constant from `case-runners/routing-runner.ts:58`) — even
   though the chatbot runner internally estimates `{4000, 400}` per input
   (`case-runners/chatbot-runner.ts:87`). The gate arithmetic is a hidden
   one-size-fits-all.
3. The chatbot bucket's run-scoped environment is special-cased in the orchestrator:
   lazy factory, failure latched for the rest of the run without retry (Codex I3),
   disposal in `finally` (`runner/index.ts:176-281, 334-338`).

Two structural invariants the seam must carry forward as **contracts**, because
consumers silently depend on them **[grounded]**:

- **Sequential dispatch.** CostTracker token/cost deltas are only correct when no two
  cases run concurrently (`runner/index.ts:19-21`, `runner/dispatch.ts:10-13`). This
  becomes a stated harness guarantee runners may rely on (§3).
- **List-mode key parity.** `runSuite` and `emitCaseList` must compute identical cache
  keys or the GUI's "currently cached?" indicator silently lies
  (`shared/cache-key.ts:29-31`, `runner/index.ts:503-522`, and the existing
  `list-mode-cache-key-parity` test) **[grounded]**.

---

## 3. The `CaseRunner` seam

**[decision]** One runner per bucket, registered in a consumer `HarnessProfile`; the
registry replaces both the four-way fork and the five per-bucket options fields. Full
declarations in the companion stub; the essential contract:

```ts
interface CaseRunner<TCase extends HarnessCase = HarnessCase> {
	readonly bucket: string;
	validateCase(c: HarnessCase): TCase;                                  // parse-don't-validate
	estimateCase(c: TCase, estimateUsd: EstimateFn): number;              // run-budget pre-charge
	setup?(): Promise<void>;                                              // run-scoped env, lazy, latched
	run(c: TCase, ctx: CaseRunContext): Promise<RunResult>;
	dispose?(): Promise<void>;                                            // finally, iff setup ran
}
```

Design rationale, point by point:

- **Dependencies bind at composition, not at run.** Today's per-bucket deps
  (`classifiers`, `recallAdapter`, …) become constructor arguments of the consumer's
  runner instances — the PAS routing runner closes over `buildClassifierAdapters(deps)`
  exactly as `build-deps.ts:153-158` builds it now. The harness core never sees
  `LLMService`, `CoreServices`, or a classifier type. `CaseRunContext` carries only the
  harness-owned per-case facts: `cacheKey`, `caseBudgetUsd`, `inventory`,
  `estimateUsd`, `meter`, `logger` — the exact intersection of today's four
  `XRunnerDeps` shapes minus the bucket-specific adapters
  (`routing-runner.ts:47-55`, `chatbot-runner.ts:54-67`) **[grounded → decision]**.
- **`validateCase` is where bucket-specific schema lives.** `HarnessCase.bucket`
  opens to `string` (registry-validated at load: unknown bucket = load-time error —
  fail-loud replaces today's silent "bucket runner not wired yet — skipping case" arm,
  `runner/index.ts:320-327`, which is a hidden-finding hazard: a typo'd bucket
  silently drops coverage) **[grounded → decision]**. Runner-specific fields
  (routing's `routingTarget`, agent's seed/step-cap) move to runner-declared subtypes
  narrowed by `validateCase`. The existing `validatePersonaCase` core checks (id
  format, coverage paths, budget positivity) stay in the loader.
- **`estimateCase` fixes the pre-charge lie.** Each bucket owns its projected cost:
  routing keeps `ESTIMATE_TOKENS × inputs`, chatbot keeps `{4000,400} × inputs`,
  agent returns the full session budget (the whole reservation, §7). **Migration
  caveat:** for the four PAS buckets the Stage-0 wrappers reproduce today's
  routing-shaped arithmetic first, then correct it as a separate, visible commit —
  otherwise the run-budget gate fires at different case indices and the
  budget-exhaustion tests shift (§11 trap 7) **[decision]**.
- **`setup`/`dispose` generalize the chatbot latch.** The harness calls `setup()`
  lazily before the runner's first dispatched case; a throw latches: every remaining
  case for that bucket synthesizes `verdict: 'error'` with one error oracle-verdict
  per input, no retry within the run — the Codex I3 semantics
  (`runner/index.ts:248-281`) promoted from chatbot-only special case to seam
  contract. `dispose()` runs once in the harness `finally` iff `setup` completed
  (`runner/index.ts:334-338`) **[grounded → decision]**. Per-*case* resources (AG-7's
  temp tree) are the runner's own `try/finally` inside `run` — the harness does not
  model them.
- **The harness owns everything around `run`; the runner owns everything inside it.**
  Stated as a non-overlap rule (stub comment): runners MUST NOT read or write the
  cache, re-check the run budget, or synthesize dry-run results; the harness MUST NOT
  interpret `actuals`, choose oracles, or apply per-case budgets. This split is what
  makes AG-7 fit without a second abstraction (§7): nothing harness-side knows what an
  "actual" means.
- **Sequential dispatch is a stated harness guarantee** (per §2). If a future runner
  wants internal concurrency it must bring its own metering; CostTracker-delta runners
  get the invariant for free.

**What deliberately does NOT cross the seam [decision]:** oracles. The structural and
rubric oracles are harness-*library* code runners may call
(`oracles/structural.ts`, `oracles/rubric.ts`), but the seam's only oracle-shaped
surface is `OracleVerdict[]` on `RunResult`. The transcription oracle imports
`@food/services/receipt-parser` (`oracles/transcription.ts:1-2`) **[grounded]** — it is
consumer code and stays with the PAS receipt runner. Making oracles a registration
surface would add a second seam with one hypothetical consumer; a runner that needs a
custom oracle just calls a function.

---

## 4. Case schema and wire-format freeze

**[decision]** Three type families, three treatments:

1. **`HarnessCase`** (was `PersonaCase`): `bucket` opens to `string`; `oracle` opens to
   `string` (today `'structural' | 'rubric' | 'judge'`, `core/types/regression.ts:9` —
   the chatbot runner already enforces `oracle === 'rubric'` itself,
   `chatbot-runner.ts:70-72`, so interpretation is runner-owned) **[grounded]**;
   everything else keeps its exact name and type. Existing case *files* are untouched
   (§11 trap 4).
2. **`RunResult`** (cache files, `--json` NDJSON, manifest rows) is a **frozen wire
   format** with two deliberate, compatible generalizations:
   - `modelIds` widens from `TierModelSnapshot {fast, standard, reasoning}` to
     `Record<string, string | null>`. PAS's profile declares exactly those three slots
     (§5), so every existing cache file round-trips unchanged. The strict read-side
     validation (`looksLikeRunResult` requires `fast`/`standard` strings,
     `core/types/regression.ts:280`) becomes profile-parameterized: required slots are
     declared by the profile, and PAS declares `fast`+`standard` required — existing
     reads stay exactly as strict **[grounded → decision]**.
   - `OracleVerdict.label` widens from the closed `'structural' | 'transcription'`
     union (`core/types/regression.ts:29-33`) to `string`, so AG-7 can label
     `'final-state'` / `'budget-compliance'` verdicts without editing the harness.
     Safe: `looksLikeRunResult` never validates label values **[grounded]**.
   - `evaluatedTier` widens to `string` at the harness layer; the legacy-decode rule
     (missing → `'unknown'`, `core/types/regression.ts:303-309`) is unchanged.
3. **`RunSummary`** is *also* wire (the GUI consumes the `{type:'summary'}` NDJSON
   line, `runner/index.ts:465-470`) but is PAS-flavored: `routingAccuracy` /
   `routingInputsEvaluated` are REQ-REG-011 fields (`core/types/regression.ts:182`)
   **[grounded]**. Decision: the summary gains an additive `gateOutcomes` array (one
   entry per registered `SuiteGate`, §8) and **keeps** the routing fields, populated by
   the PAS gate, until the GUI reader migrates — additive-only, never remove-and-alias
   (§12 Q2).
4. **`RunManifest` / `ManifestCaseResult`** (`core/types/regression.ts:143,160`) are the
   persisted manifest wire shapes the leaderboard store reads. `ManifestCaseResult.bucket`
   opens to string (§7.1 valid set) and gains an optional `sourceId` for per-app
   attribution (§8); `RunManifest.modelIds` generalizes with `RunResult`;
   `bucketsRequested` opens to string. All additive/compatible.

**Codex M3 correction — the stub now types the exact compatibility surface.** Because
this section changes wire shapes GUI/manifest readers consume, the companion stub
declares proposed `RunSummary` (with `gateOutcomes?`), `ManifestCaseResult` (with
`sourceId?`), and `RunManifest` alongside `RunResult`/`GateOutcome`/`SuiteGate` —
previously only the latter were present, leaving the changed shapes untyped. A reviewer
(and the implementing phase) can now see the precise additive delta against the live
types rather than inferring it from prose.

---

## 5. `CacheKeyContributor` — composable salts over a frozen base recipe

**[grounded — the current recipe]** `computeCacheKey` (`shared/cache-key.ts:66-97`)
hashes, in order with `\0` separators: the case-file content hash (git blob for
tracked-and-clean, SHA-256 fallback otherwise — `shared/git-hash.ts`), sorted
`path:hash` coverage entries, the model string
`fast=…,standard=…,reasoning=…(?? 'none')`, and — only when defined — a
`salt:<extraSalt>` block whose absent-vs-empty distinction is deliberately preserved
(`cache-key.ts:88-95`). The only salt producer is the hardcoded `bucketCacheSalt`
switch (receipt: `today:<YYYY-MM-DD>:tz:<tz>`).

**[decision]** The seam:

```ts
interface CacheKeyContributor {
	readonly id: string;         // unique; deterministic sort key
	readonly namespace: string;  // every produced value MUST start `${namespace}:`
	contribute(c: HarnessCase, env: CacheKeyEnv): string | undefined;
}
```

with a **composition law** chosen so both existing key populations stay byte-identical:

- **0 contributions → no salt block.** Today's routing/recall/chatbot keys, unchanged.
- **1 contribution → legacy `salt:<value>` block.** The receipt salt becomes the first
  contributor (`id: 'receipt-date'`, `namespace: 'today'`, value
  `today:<date>:tz:<tz>` — the exact current string), so every receipt key is
  byte-identical too. **This single-value compat carve-out is the price of not
  invalidating the cache history**; REQ-REG-010 retains history forever
  (`runner/cache.ts:4-5`) and invalidation means re-dispatching every case at real LLM
  cost **[grounded → decision]**.
- **≥2 contributions → `salt:` + values sorted by contributor id, `\n`-joined.**
  Injectivity discipline: every value begins with its registered unique namespace
  (validated at composition), so two contributors can never collide by concatenation
  ambiguity. Sorting by id — not registration order — removes a registration-order
  drift trap **[decision]**.
- **The no-newline invariant is validated on EVERY produced value, not only the
  multi-contributor join path [decision — Codex ALSO].** A value containing `\n` (the
  join separator) is rejected even in the single-contribution receipt case. Rationale:
  a smuggled newline that is harmless while one contributor is registered would be
  *retroactively reinterpreted* as a value boundary the moment a second contributor is
  added — a latent key-collision trap. Validating unconditionally makes the
  single→multi transition safe, and pairs with the byte-identical receipt value
  (`today:<date>:tz:<tz>` contains no newline, so today's keys are unaffected).
- **`contribute` is synchronous and per-run deterministic** **[decision]**. Both
  `runSuite` and list mode call the same pipeline (the parity invariant, §2); a
  contributor needing IO (e.g. AG-7's tool-schema digest) computes at
  profile-composition time and closes over the result (§12 Q4).

**The model string generalizes via `ModelInventory` [decision]:** `{ slots:
readonly string[]; models: Record<string, string | null> }`, serialized as
`slots.map(s => `${s}=${models[s] ?? 'none'}`).join(',')`. PAS declares
`slots: ['fast', 'standard', 'reasoning']` — the *declared* order, **not** sorted
(sorted would be `fast, reasoning, standard` and would silently rewrite every key)
— reproducing today's modelStr byte-for-byte (`cache-key.ts:80`) **[grounded]**. A
standalone consumer declares whatever slots it has (possibly one). This is the EXT-2
fix: tier snapshots stop being a core notion baked into the recipe and become PAS's
profile inventory.

**What stays out of contributor hands [decision]:** the base recipe (case hash,
coverage, inventory, separator layout) is frozen and NOT contributor-replaceable.
Contributors add material; they cannot reorder, remove, or re-serialize the base. A
consumer that needs a fundamentally different recipe is asking for a different cache,
not a contribution.

---

## 6. THE hard question, answered: the judge-model override extracts cleanly — the machinery never crosses the seam

**[grounded — the full override chain, end to end]**

1. `--judge-model` parses into `CliOptions.judgeModel`; `buildTierOverrideFromCli`
   folds it with `--model-matrix` (judge wins the `standard` slot,
   `runner/args.ts:298-312`).
2. `buildProductionDeps({tierOverride})` consumes it in **three** places
   (`runner/build-deps.ts`): (a) it rewrites `config.llm.tiers` *before* composing
   the LLM service so `llm.complete({tier:'standard'})` really resolves to the
   override (`build-deps.ts:104-117`); (b) `composeLLMService` constructs a
   `ModelSelector`, calls `applyTransientOverride` after `load()` and before
   `reconcile()` (`build-deps.ts:41-45, 253-268`); (c) `resolveTierModelIds` builds a
   *second* selector to produce the `modelIds` snapshot that feeds every cache key and
   the manifest (`build-deps.ts:416-441`).
3. `ModelSelector`'s transient-override machinery is a fail-loud freeze: `load()`
   refuses to let persisted YAML clobber a frozen tier
   (`core/services/llm/model-selector.ts:97-128`), and `reconcile()` **throws** —
   rather than silently reverting — when a frozen tier's provider is unregistered
   (`throwIfFrozen`, `model-selector.ts:290-296`).
4. The rubric oracle itself knows none of this. Its deps are
   `{ llm: Pick<LLMService, 'complete'>; standardModelId: string; costMeter; logger }`
   (`oracles/rubric.ts:34-48`); it calls `complete(prompt, { tier: 'standard',
   maxTokens: 400, temperature: 0, responseFormat: 'json' })` (`rubric.ts:93-102`) and
   stamps `meter.model = deps.standardModelId` (`rubric.ts:112`). The orchestrator
   wires `judgeModelId: opts.modelIds.standard` (`runner/index.ts:296`), and the
   manifest convention is "`modelIds.standard` IS the judge when
   `judgeOverrideApplied`" (`core/types/regression.ts:160-175`).

**[decision — the answer]** **Yes, it extracts cleanly. Every piece of ModelSelector
machinery — transient overrides, the load-freeze, the reconcile-throw, the
config-tiers rewrite — already lives in `build-deps.ts`/`model-selector.ts`, which are
consumer-side by construction. Nothing in the would-be package touches ModelSelector.**
What actually leaks today is smaller and different from what the open question feared:
three *PAS vocabulary items* sit inside harness-core code —

1. the `tier: 'standard'` literal inside `runRubricOracle` (`rubric.ts:94`),
2. the `standardModelId` dep name and the orchestrator's
   `judgeModelId = modelIds.standard` wiring (`runner/index.ts:296`),
3. the judge-wins-`standard` CLI precedence + `judgeOverrideApplied` manifest
   convention (`args.ts:307-309`, `regression.ts:165-171`).

The extraction replaces all three with one seam type, **`ModelHandle`**
(`{ id, slot, complete(req) }`, stub §Model handles): the rubric oracle's deps become
`{ judge: ModelHandle; meter; logger }`; PAS's profile binds
`complete: (req) => llm.complete(req.prompt, { tier: 'standard', ...req })` and
`slot: 'standard'`, `id: modelIds.standard`. The judge *protocol* (maxTokens 400,
temperature 0, JSON response format, the 0–5 rubric prompt, the untrusted-judge
error-not-fail discipline) is judge-generic and **stays in the oracle**; only tier
routing moves out **[decision]**.

Two seam invariants make the consumer-side machinery's guarantees survive extraction
**[decision]**:

- **Consumer obligation (stated contract):** the `ModelHandle` presented to the
  harness must *already reflect* any operator override, and profile composition must
  fail loudly if the override cannot be honored. PAS satisfies this today via
  `throwIfFrozen` — the obligation names the property, not the mechanism, so a
  standalone consumer with no ModelSelector can satisfy it however it likes.
- **Harness assertion — a typed contract, not just prose.** The handles are a
  first-class profile field: `HarnessProfile.modelHandles: readonly ModelHandle[]`
  (stub). At composition the harness iterates it and checks, for every handle,
  `handle.id === inventory.models[handle.slot]`, refusing to run on mismatch.
  **Registering the handles on the profile — rather than leaving them closed over
  inside runners where the harness can't see them — is what makes the check
  representable at all**; the *same* handle instances the consumer wires into its
  runners are the ones registered, so what the harness asserts is what dispatches
  (Codex M1 correction). This closes a real, currently-latent desync class:
  `applyJudgeModelOverride` rewrites `modelIds` **without touching any live LLM
  service** (`build-deps.ts:474-482`) — sound today only because it is applied
  exclusively on the dry-run/list paths that never dispatch (`runner/cli-main.ts:78-83`),
  and note this is the *opposite* wiring from the live production path, which applies the
  override to `config.llm.tiers` **before** composing the service so dispatch and cache
  key agree (`build-deps.ts:104-117`) **[grounded]**. A consumer replicating the
  dry-run shortcut on a dispatching path would mint cache keys for a model it isn't
  calling; the assertion makes that class impossible instead of documented-away
  **[grounded → decision]**.

One residue is acknowledged and deliberately kept: **a judge swap invalidates every
bucket's cache**, because the full inventory string is mixed into every key
(`cache-key.ts:80-87`) — routing cases re-run when only the judge changed. That is
today's grounded behavior, it errs on the safe side, and slot-scoping keys per runner
would rewrite every existing key (full history invalidation). Keep it; revisit as §12
Q10 **[grounded → decision]**.

**One extraction rider [grounded]:** the rubric oracle's prompt fencing imports PAS
production protections — `buildMemoryContextBlock` (zero-width/bidi stripping,
backtick-run collapse, role-tag escaping; Codex I7) and `tryParseJsonStripFences`
(`rubric.ts:24-26`). These are leaf utilities with no further core coupling; they move
*with* the oracle (§9). Dropping the fencing to sever the import would reopen a closed
hostile-reply escape — the boundary cut must carry the protections along.

---

## 7. AG-7's `agent` bucket on the same seam — different assertions, same runner shape

### 7.1 Opening the bucket union is necessary but NOT sufficient — thread the registry through the read path

**[grounded — Codex M2]** §3 opens `HarnessCase.bucket` from a closed union to a
registry-validated string, which lets the *harness* run an `agent` bucket. But the
closed union `'routing' | 'receipt' | 'chatbot' | 'recall'` (and its runtime guard
`isValidBucket` / `VALID_BUCKETS`, `core/types/regression.ts:208-217`) is re-asserted at
**five** independent GUI/read-path sites that would still reject `agent`, making an AG-7
case runnable in the harness yet undiscoverable, unspawnable, and dropped by the
leaderboard **[grounded — repo grep, 2026-07-08]**:

| Site | What it rejects | Grounded in |
|---|---|---|
| GUI case discovery | `ListedCase.bucket` closed union + `validateEntry`'s `isValidBucket` guard | `core/src/gui/services/regression/case-discovery.ts:37,97` |
| Subprocess spawn allowlist | `--bucket=<v>` where `v ∉ VALID_BUCKETS` throws | `core/src/gui/services/regression/subprocess.ts:30` |
| Run-history / leaderboard store | `BUCKETS = new Set(VALID_BUCKETS)`; a manifest row whose `bucket ∉ BUCKETS` fails `isValidCaseResult` and the run is skipped | `core/src/gui/services/regression/run-history-store.ts:26,222` |
| POST run-trigger validation | `if (body.bucket && !isValidBucket(body.bucket)) → 400` | `core/src/gui/routes/regression.ts:500` |
| CLI `--bucket` parsing | `RunSuiteOptions.bucketFilter` closed union | `runner/index.ts:97`, `runner/args.ts` |

**[decision] The profile's registered runner `bucket`s ARE the valid-bucket set, and
that set must be threaded through every one of these sites as an explicit,
cross-cutting migration step** (companion stub: `HarnessProfile.runners` doc). Concretely
the implementing phase replaces each hardcoded union / `VALID_BUCKETS` reference with the
profile-derived set: the GUI is handed (or spawns the CLI to emit) the active profile's
bucket list; `ListedCase.bucket` widens to string validated against it; the spawn
allowlist, the history-store `BUCKETS`, the POST guard, and the CLI filter all read the
same source; UI bucket labels/estimators fall back to the raw id for unknown buckets
rather than dropping them. **This threading gates Stage 3 (AG-7) — the `agent` runner is
not usable end-to-end until it lands** — and it is called out again in the migration
plan (§10) and the trap checklist (§11, trap 17). Note the split is safe to stage: the
harness-core widening (Stage 0/1) can ship with PAS's four buckets while the read-path
threading lands with (or just before) the first non-PAS bucket, since with only the four
PAS buckets registered the derived set equals today's hardcoded union byte-for-byte.

### 7.2 The runner itself — different assertions, same shape

**[grounded — what AG-7 requires]** "Seed a temp data tree, run a task at a fixed
budget, assert on final file state (multiset/structural oracles already exist) +
budget/step compliance; **never assert the tool-call sequence**"
(deep-dive:340-346; `docs/implementation-phases.md` AG-2 scope item 4: "model-matrix
coverage is what makes the AG-4 ladder enforceable").

**[decision] No second runner abstraction — because `RunResult` is already
outcome-shaped, not classifier-shaped.** `actuals` is `unknown[]`, `oracleVerdicts` is
a labeled list, and nothing harness-side interprets either (§3). The agent runner is
an ordinary `CaseRunner<AgentCase>`:

- **`AgentCase`** (validated by `validateCase`): extends `HarnessCase` with
  `seedFixture` (repo-relative fixture dir/JSON, **required to also appear in
  `coverage`** so a fixture edit invalidates the key), `maxSteps`, and per-input
  `{ payload: taskPrompt, expected: finalStateExpectation }`.
- **`run`:** per input — create a temp data tree (per-case resource, runner's own
  `try/finally`), seed it from the fixture, run one bounded agent session (the AG-2
  engine, consumer-side dependency bound at composition) with the session budget set
  to `ctx.caseBudgetUsd` and the step cap to `maxSteps`; snapshot the final tree into
  a **canonical JSON** (sorted relative paths; parsed YAML/JSON content where the
  expectation asserts structure, content hash otherwise) and push it as the input's
  `actual`; then run the existing structural/multiset oracles over the snapshot
  (`multisetRows` gives duplicate-preserving row equality with per-field tolerance,
  `oracles/structural.ts:48-53` **[grounded]** — exactly the final-state shape AG-7
  names) labeled `'final-state'`, plus one synthesized `'budget-compliance'` verdict:
  pass iff `sessionCostUsd ≤ budgetUsd AND steps ≤ maxSteps`.
- **Verdict semantics — the one place agent differs on purpose [decision]:** a session
  that blows its budget/step cap is a **`fail`** (budget compliance is the property
  under test), NOT `budget-exceeded`. The wire vocabulary reserves
  `budget-exceeded` for the harness's own abort-before-dispatch synthesis
  (`runner/index.ts:573-597` — "skipped without dispatch") **[grounded]**; conflating
  the two would make "the agent is profligate" indistinguishable from "the suite ran
  out of money." The AG-2 session engine's own budget reservation enforces the stop;
  the runner reports the outcome.
- **`estimateCase` returns the full session budget** — an agent session legitimately
  spends up to its cap, so the run-budget gate must reserve all of it up front, unlike
  token-shaped classifier estimates **[decision]**.
- **`evaluatedTier: 'mixed'`** — the reserved value for "runners that genuinely span
  tiers in a single case" (`core/types/regression.ts:99-101`) finally gets its
  consumer: agent sessions run on the reasoning floor but may drop to fast for
  sub-classifications **[grounded → decision]**.
- **Cache-key inputs:** coverage carries the agent-loop sources + tool implementations
  + seed fixture; one `CacheKeyContributor` (`namespace: 'agent-tools'`) contributes a
  digest of the AG-3 tool-schema metadata so a tool-contract change invalidates agent
  cases without a source-path enumeration race **[decision]** (digest computed at
  composition time — §5's sync rule).
- **What the runner deliberately withholds:** the tool trace is never exposed to
  oracles or persisted into `actuals`. The seam makes the doctrine ("evaluate
  outcomes, not paths"; the hermes review's rejection of trajectory-replay infra,
  deep-dive:345-346) structurally enforceable: an expectation cannot reference what
  the result does not contain **[decision]**.

The fit is the design's proof of generality: the agent runner uses `setup`/`dispose`
not at all (per-case trees), uses the same budget context, the same oracles, the same
result shape — and required exactly two *harness-core* type changes, both already made
for other reasons (§4: open `label`, open `bucket`). The one additional cost is not a
harness change at all but the read-path bucket-registry threading (§7.1) — a
cross-cutting migration through the GUI/CLI validation sites, which is why AG-7 gates on
it (§10 Stage 3).

---

## 8. Consumer 2 — per-app discovery, attribution, and gates

**[grounded]** The loader walks ONE root (`casesDir`, `runner/case-loader.ts:26`),
supports two file formats (`*.case.ts` default export; `index.ts` `buildCases()`),
fails loud on duplicate ids, sorts by id for deterministic dispatch. The v2 proposal
(`docs/open-items.md:340`) needs: per-app case declaration, discovery, per-app
budget/cost attribution, oracle reuse, cache-key coverage paths.

**[decision]** The seam's answer is deliberately thin:

- **`CaseSource { id, casesDir }[]`** on the profile. Discovery = the existing walk
  per source; `LoadedCase` gains `sourceId`. Duplicate ids fail loud **globally**
  (across sources — two apps claiming `receipt-basic` is an error, not a shadowing
  rule), and the global id sort preserves deterministic dispatch order regardless of
  source enumeration order **[decision]**. PAS's profile builds sources from the
  in-repo cases root plus, in the v2 phase, one per installed app (manifest-declared
  `regression/` dir — the discovery mechanics belong to that phase's plan, not this
  seam).
- **Attribution, not sub-budgets:** manifest rows gain optional `sourceId`, so
  per-app cost roll-ups are a read-side query. Per-source `RunBudget` sub-ceilings are
  NOT designed here — a real policy question for the v2 phase (§12 Q6) and nothing in
  the seam blocks adding them (the pre-charge gate already has the case in hand).
- **Apps contribute CASES into registered buckets — not runners — in v2**
  **[decision]**. An app-provided *runner* is arbitrary code executing with the
  harness's process privileges; under SR-1's trust model that is a Tier-A-trust grant
  and must not ride in silently via a cases directory. Gate app-provided runners on
  SR-1's manifest/capability vocabulary (coherence: SR-1 §2) — most app needs
  (food's `FOOD_PERSONAS`) are satisfied by contributing cases to the existing
  routing/chatbot buckets, which is exactly what the food shim does today
  (`cases/routing/food-personas/index.ts`) **[grounded]**.
- **`SuiteGate` extracts REQ-REG-011.** The exit-code gate (routing accuracy < 0.95 →
  exit 1, `runner/index.ts:481-491`) and its threshold — currently duplicated in
  `markdown-report.ts` and `core/types/regression.ts:250` with a comment explaining
  the duplication **[grounded]** — become the PAS profile's first registered gate,
  single-sourced. The harness runs all gates after the loop; any failing gate → exit 1;
  gate outcomes land additively in the summary (§4). Dry-run skips gates (today's
  behavior, `runner/index.ts:482`).

---

## 9. Package boundary — the zero-`@core` cut, grounded import by import

**[grounded — the complete `@core`/`@food` import inventory of `regression/src`
(non-test), 2026-07-08 grep]** and the disposition of each **[decision]**:

| File | Imports | Disposition |
|---|---|---|
| `shared/types.ts`, `shared/cache-key.ts`, `runner/case-loader.ts`, `case-runners/*` (types), `runner/manifest-writer.ts`, `runner/markdown-report.ts` | `@core/types/regression` | **Inverts.** Wire types move INTO the harness package (§4); `@core/types/regression.ts` becomes a re-export shim (deleted at cleanup). Today's comment says types live in core "to avoid a core → regression import cycle from the GUI" (`regression.ts:2-4`) — after extraction the GUI imports harness types directly: `core → harness` is acyclic because the harness imports nothing from core. |
| `runner/index.ts` | `@core/services/context/request-context` | **Moves consumer-side.** The `requestContext.run(...)` wrapper around chatbot `routeMessage` (`index.ts:290-293`) is PAS runtime plumbing; it belongs inside the PAS chatbot runner's bound env, not the orchestrator. |
| `oracles/rubric.ts` | `@core/services/prompt-assembly/memory-context`, `@core/utils/json-strip-fences`, `@core/types/llm` | **Utilities move with the oracle** (§6 rider — fencing protections must travel); the `LLMService` type dependency dissolves into `ModelHandle`. |
| `oracles/structural.ts` | `@core/utils/temporal` (`isCalendarStrict`) | **Leaf util — moves** (calendar-strict date validation is harness-generic). |
| `runner/atomic-write.ts` | re-exports `@core/utils/atomic-write` | **Leaf util — moves** (atomic JSON write is harness-generic). |
| `runner/args.ts` | `@core/services/regression/model-spec`, `@core/types/llm` | **Splits.** Generic flags (`--bucket --dry-run --rerun --json --list --no-cache --run-id --manifest-dir`) → harness CLI core; `--model-matrix`/`--judge-model` parsing + `buildTierOverrideFromCli` → PAS profile CLI extension (they are ModelSelector vocabulary). The peek-then-build pattern in `cli-main.ts` already isolates this **[grounded]**. Extension mechanism: §12 Q3. |
| `runner/build-deps.ts`, `runner/dispatch.ts`, `runner/chatbot-environment.ts`, `case-runners/receipt-runner.ts` (`@food/*`), `oracles/transcription.ts` (`@food/*`), `cases/**` | deep core/app coupling | **Consumer-side by design.** These ARE the PAS adapter — the first `HarnessProfile`. They stay in the `regression/` workspace (or a `regression-pas/` sibling), importing both the harness package and `@core`/`@food` freely. |

**Boundary enforcement [decision]:** "enforced like the LLM boundary" (the confirmed
phase entry) — PAS's LLM boundary is a static banned-imports check (apps must not
import provider SDKs; `.claude/skills/pas-llm-architecture`) **[grounded]**. The
harness analog: a test in the harness package that walks its own sources and fails on
any `@core/`, `@food/`, or relative-path escape import. Cheap, loud, in-suite.

**Package, not repo [grounded → decision]:** per the strategic review, extraction is a
pnpm workspace package first (working name `@pas/regression-harness`; public branding
is a repo-split-time decision, §12 Q1). Repo split only when an external consumer
exists.

---

## 10. Migration — four stages, suite-green at every boundary

**Stage 0 — seam in place, nothing moves.** Inside `regression/src`: introduce the
`CaseRunner` registry and wrap the four existing runners; replace the bucket fork with
registry dispatch; replace `bucketCacheSalt` with the contributor pipeline (receipt
contributor = the exact current string); generalize the chatbot env special-case into
the `setup` latch; keep `RunSuiteOptions`'s per-bucket fields as a deprecated shim that
builds the registry internally (the GUI subprocess consumes the CLI, which is
unchanged). **Verifier:** the full existing suite, plus a **golden-key
characterization test**: compute cache keys for every loaded case via the old
`computeCacheKey`+`bucketCacheSalt` path and the new pipeline and assert byte
equality (the list-mode parity test pattern, extended) **[decision]**.

**Stage 1 — the package split.** Move orchestrator, cache, budgets, loader, CLI core,
structural+rubric oracles, wire types, and the §9 leaf utilities into the harness
package; add the banned-imports test; `@core/types/regression` becomes a re-export
shim; the PAS profile (build-deps, dispatch, chatbot-env, receipt+transcription,
cases, PAS CLI flags) stays behind as the first consumer. **Verifier:** suite +
golden-key test unchanged; `data/system/regression-cache` is NOT touched — same keys,
same files, history intact.

**Stage 2 — v2 discovery rides the seam** (`CaseSource[]` + `sourceId` attribution +
`SuiteGate` extraction of REQ-REG-011). Scheduled with the v2 proposal's own trigger
("a second app beyond food needs model-behavior regression coverage",
`docs/open-items.md:340`) **[grounded]**.

**Stage 2b — read-path bucket-registry threading (§7.1).** Replace the five hardcoded
`VALID_BUCKETS`/closed-union sites (GUI discovery, spawn allowlist, history store, POST
validation, CLI filter) with the profile-provided bucket set, and make UI labels/
estimators fall back to the raw bucket id for unknown buckets. This can land with Stage 2
or as its own small slice, but it **must precede Stage 3** — with only PAS's four buckets
registered the derived set equals today's union byte-for-byte, so it is a no-op behavior
change until a fifth bucket exists. **Verifier:** existing GUI/discovery tests unchanged;
a new test registers a synthetic fifth bucket and asserts it survives discovery → spawn →
manifest → leaderboard.

**Stage 3 — AG-7's agent runner** ships inside AG-2's phase (per
`implementation-phases.md`: "bucket design in AG-2's plan") as a consumer of the
already-stable seam — which is the entire point of designing it now: AG-2 must not
need to renegotiate the runner contract. **Gated on Stage 2b** — the `agent` bucket is
not usable through the GUI/leaderboard until the read path is threaded (§7.1)
**[grounded → decision]**.

Stages 0–1 are the SR-4 implementing phase; 2 and 3 belong to their own phases and
consume the seam. If AG-2 arrives *before* SR-4's implementing phase (plausible —
AG-2 gates on T3, SR-4 gates on SR-3), the agent runner implements this `CaseRunner`
contract against the Stage-0 in-place registry, and Stage 1 moves it later with the
others — the seam is designed to survive either ordering **[decision]**.

---

## 11. Byte-identical traps (implementing-phase checklist)

The acceptance criterion for Stages 0–1 is byte-identical behavior with the existing
suite + golden-key test as verifiers. Places a well-meaning refactor would silently
change bytes **[grounded inventory]**:

1. **Cache-key recipe freeze** — `\0` separators, component order, absent-vs-empty
   salt distinction (`cache-key.ts:88-95`), and the single-contribution legacy
   `salt:<value>` form (§5). Any deviation invalidates the entire REQ-REG-010 history.
2. **Inventory slot order is declared, not sorted** — `fast, standard, reasoning`
   (`cache-key.ts:80`); alphabetical sorting rewrites every key.
3. **List-mode ↔ run key parity** — both paths through the SAME contributor pipeline
   (today both call `bucketCacheSalt`, `index.ts:152, 511`).
4. **Do not touch case files.** The case-file *content* hash is a key component; a
   formatter pass over `cases/**` invalidates everything. Coverage-path *strings* are
   mixed in (`${p}:${hash}`, `cache-key.ts:78`) — renaming a coverage path invalidates
   even with identical content. Moving a case file without content change is
   key-preserving (only its hash is mixed, not its path) but keep `routingTarget` and
   friends byte-identical anyway.
5. **Sequential dispatch** — CostTracker deltas (`index.ts:19-21`); no "parallelize
   the loop" cleanup, ever, without a metering redesign.
6. **Setup-latch semantics** — lazy, latched-no-retry, per-input error verdicts,
   dispose-in-finally (Codex I3, `index.ts:176-281, 334-338`) — generalized but
   behaviorally identical for chatbot.
7. **Run-budget pre-charge arithmetic** — Stage-0 wrappers reproduce
   `estimateUsd(ESTIMATE_TOKENS) × max(1, inputs)` for all four buckets (`index.ts:202`);
   correcting per-bucket estimates is a separate, visible change (§3).
8. **Budget-exceeded synthesis** — one `error` oracle verdict per input so REQ-REG-011
   counts skipped inputs (`index.ts:585-591`).
9. **REQ-REG-011 gate** — exit-code semantics, dry-run skip, below-floor → null →
   exit 0 with warning (`index.ts:481-491`); threshold single-sourced when the gate
   extracts (currently duplicated, `regression.ts:245-250`).
10. **NDJSON stdout purity** — logs to stderr, `DOTENV_CONFIG_QUIET`, and the
    drain-before-exit idiom (`cli-main.ts:36-37, 91-96`).
11. **`looksLikeRunResult` strictness** — PAS reads must stay exactly as strict after
    `modelIds` generalizes (profile-declared required slots, §4); the GUI cache-reader
    shares this validator (`regression.ts:256-265`).
12. **Rubric fencing travels with the oracle** — `buildMemoryContextBlock` sanitization
    + `tryParseJsonStripFences` (Codex I7; §6 rider). Also the judge protocol constants:
    maxTokens 400 (Gemma-26b envelope-closing headroom, `rubric.ts:95-99`), temperature
    0, JSON format, pass threshold 4, error-not-fail for out-of-range/NaN judges.
13. **`judgeOverrideApplied` manifest convention** — "`modelIds.standard` IS the
    judge"; no separate `judgeModelId` field appears (`regression.ts:165-171`).
14. **`evaluatedTier` legacy decode** — missing → `'unknown'`, excluded from per-tier
    leaderboards (`regression.ts:94-102, 303-309`).
15. **Duplicate-id fail-loud + global id sort** — preserved across multi-source
    discovery (`case-loader.ts:57-66`); enumeration order of sources must not affect
    dispatch order.
16. **Unknown bucket becomes fail-loud** (§3) — this is a deliberate, desirable
    behavior CHANGE from today's skip-with-log (`index.ts:320-327`); flag it in the
    implementing phase's notes rather than discovering it as a surprise test failure.
17. **Read-path bucket-registry threading is a SEPARATE change from opening the union**
    (§7.1, Stage 2b) — the five GUI/CLI validation sites (`case-discovery.ts:37,97`,
    `subprocess.ts:30`, `run-history-store.ts:26,222`, `routes/regression.ts:500`, the
    CLI `bucketFilter`) still reject unknown buckets after `HarnessCase.bucket` opens.
    Byte-identical while only the four PAS buckets are registered (derived set == today's
    union); the risk surfaces only when a fifth bucket exists, so the verifier is a
    synthetic-fifth-bucket end-to-end test, not the existing suite.

---

## 12. Open questions for the implementing phase

1. **Package naming/branding.** Internal `@pas/regression-harness` now; the public
   name is a repo-split-time decision (strategic review §SR-4 OQ2). Decide only when
   an external consumer exists.
2. **`RunSummary` evolution.** Additive `gateOutcomes` next to the legacy routing
   fields (§4) — audit the GUI's summary consumers for unknown-field tolerance before
   landing, and decide when (if ever) the legacy fields retire.
3. **CLI flag extension mechanism.** §9 splits generic vs PAS flags; decide whether
   consumer flags are a formal `HarnessProfile.cliExtensions` surface or stay the
   current peek-then-build pattern in the consumer's `cli-main`. (Default: peek —
   it works today and adds no machinery.)
4. **Sync-only `contribute`.** Is composition-time precomputation sufficient for the
   AG-7 tool-schema digest, or does a future contributor genuinely need per-case
   async IO? (Design default: sync; parity + determinism outweigh flexibility.)
5. **GUI read-path imports.** Do `cache-reader`/leaderboard import harness types
   directly (core → harness dep) or via the core re-export shim indefinitely? Decide
   with core's dependency policy; either is acyclic.
6. **Per-app budget sub-ceilings** (v2 phase): attribution-only reporting (§8) vs.
   enforced per-source `RunBudget` slices — a cost-policy question for the v2 planning
   pass, not the seam.
7. **Agent-case cacheability.** Agent sessions are less deterministic than single
   classifier calls; caching remains epistemically equivalent to the chatbot bucket
   (same code+model+seed → cached verdict), but decide in AG-2's plan whether
   `CaseRunner` grows a `cacheable?: boolean` (or per-case flag) for runners that want
   fresh dispatch semantics by default.
8. **App-provided runners** stay excluded until SR-1's trust vocabulary can express
   "this app may execute code in the harness process" (§8). Revisit trigger: an app
   need that cases-into-existing-buckets genuinely cannot express.
9. **URS registration.** Proposed area `REQ-HARNESS-*` (per the confirmed phase
   entry): the seam contracts (§3's ownership split, setup-latch, sequential
   dispatch), the cache-key composition law + parity (§5), the `ModelHandle`
   composition assertion + consumer obligation (§6), the agent-bucket
   outcome-not-path rule (§7), and the §11 checklist as testable requirements.
10. **Slot-scoped cache keys.** Today a judge swap invalidates all buckets (§6). A
    runner-declared "slots I read" set could scope keys — at the cost of rewriting
    every existing key. Defer until cache-invalidation cost is a measured pain, and
    if ever done, do it as an explicit one-time-invalidation phase.

---

## 13. Deferred-work note

Per CLAUDE.md's deferred-work rule, the work this design *specifies but does not
implement* — Stage 0 (in-place registry + contributor pipeline + golden-key test) and
Stage 1 (package split + banned-imports boundary + type-home inversion) as the SR-4
implementing phase; Stage 2 (per-app `CaseSource` discovery + `SuiteGate` extraction,
rides the "Regression Suite v2" proposal); Stage 3 (the `agent` runner, rides AG-2's
phase per its confirmed scope); and open questions Q1–Q10 — is tracked under the
existing SR-4 entries in `docs/open-items.md` (Confirmed Phases) and
`docs/implementation-phases.md` ("SR-4 — Regression Harness Extraction"), plus the
"Regression Suite v2" proposal entry and the AG-2 confirmed-phase entry for their
respective stages. This design adds no *new* deferred item beyond those entries; it
answers the open question they carried (the judge-model-override extraction, §6) and
fixes the seam so all three consumers build against it once.
