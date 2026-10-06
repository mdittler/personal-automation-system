# Priority Queue — "do the next phase"

**This file is the top of all pending work in PAS.** Its items outrank everything in the Master Execution Order of `docs/open-items.md` (Tracks A–D). Work the queue top to bottom; when it is empty, return to the Master Execution Order.

Set 2026-10-05 by operator decision: Agent Runtime design approved, plus fixes found while designing it. Design: `docs/superpowers/specs/2026-10-05-agent-runtime-design.md`.

---

## When the operator says "do the next phase"

**How to work: follow `docs/review-protocol.md`** — Code Orchestrator's roles, adopted 2026-10-05:
- Fable plans and revises.
- Codex `gpt-6.1-sol` (medium) reviews plans.
- Sonnet executes and simplifies.
- Codex `gpt-6-luna` (medium) reviews code.
- Grok `grok-4.7-high` revises code.
- Opus, `gpt-6.1-sol` and Grok vote.

The protocol also covers the finding ledger, loop caps, operator gates, and execution rules.

1. **Sync and orient.**
   - Start from an up-to-date `main` (in an app-made worktree, use the host's sync tool).
   - List the model roster (protocol §1).
   - Read this file and pick the **first row whose Status is not `Done`**. If the operator names an item, do that one. **Do not re-rank the queue.**
2. **Check it isn't already done.** Search `git log --oneline main` and `docs/open-items.md` for the item. If it already landed, mark it `Done` with the commit and go back to step 1.
3. **Announce the item in one line**, then run its workflow below.
4. **Close.**
   - Update the row to `Done (YYYY-MM-DD, <merge commit>)`.
   - Record new work (see "Adding work").
   - Report the next item, the cost, and the wall-clock time.

## Workflow — phases (P0–P5)

Each step follows `docs/review-protocol.md` §2, Code Orchestrator's flow.

1. **Plan.**
   - If the row says *Plan: needs writing*, a **Fable subagent** writes `docs/superpowers/plans/YYYY-MM-DD-agent-runtime-pN-<slug>.md`. It invokes the `writing-plans` skill and works from the design sections the row names plus every *Carried items* bullet for the row.
   - If the phase needs new design, an **Opus** designer subagent goes first.
   - The plan has the protocol's §3 sections: Deliverables, test-first tasks, a live smoke, the Plan review log, the acceptance checklist, and Implementation notes from review.
   - It also covers the documentation footprint: URS entries and traceability rows, a `docs/implementation-phases.md` section, `docs/open-items.md` updates, and this file's row.
2. **Plan review loop** (≤3 iterations).
   - Codex `gpt-6.1-sol` at medium reviews the plan, and Fable revises.
   - Every finding, critical or not, gets a home (§5).
   - If the loop hits the cap, go to the operator: proceed, replan, or abort.
   - For Q3: the P0 plan already went through 5 review rounds, but round 5's fixes and the backfilled sections (Deliverables, acceptance checklist, implementation notes) were never re-reviewed. Run **one confirming plan-review round** before the gate.
3. **Operator gate (after plan revision).**
   - Give a ≤10-line summary: what ships, the review outcome, and any operator-disposition findings.
   - Wait for "go" unless the operator already said to execute without asking.
4. **Execute.**
   - Use fresh **Sonnet** subagents, one per task, test-first.
   - Apply mechanical and closure proof.
   - Tick the acceptance checklist with the evidence you observed, and handle every implementation note (§7).
5. **Code review loop** (≤5 iterations).
   - Codex `gpt-6-luna` at medium reviews the phase SHA in a disposable detached worktree. The brief includes the Deliverables, the acceptance checklist, and the implementation notes.
   - Grok `grok-4.7-high` revises in the phase worktree. The conductor verifies each revision and commits it.
   - Then a **Sonnet simplify** pass, and one confirming full-scope Luna review.
6. **Verify, then operator gate (before merge/push).**
   - Run `pnpm lint && pnpm test && pnpm --filter @pas/regression test && pnpm --filter @pas/regression typecheck` and save `suite-<sha>.txt`.
   - Re-check that HEAD equals the tested SHA.
   - Complete the documentation footprint.
   - On "go", merge `--no-ff`, delete the branch, and reconcile this file.

## Workflow — fixes (rows marked Fix)

Follow protocol §8:
- the Sonnet implementer writes a failing test first, using `systematic-debugging` for root cause;
- make the minimal fix and get closure proof;
- run the Luna review ⇄ Grok revise loop;
- add a URS fix entry and close the `docs/open-items.md` item;
- verify, pass the operator gate, then merge.

## Queue

Rows are in execution order. **Depends on** names rows that must be `Done` first.

| # | Item | Type | Status | Plan / source | Depends on |
|---|---|---|---|---|---|
| Q1 | Admin-gate the three model-journal GUI routes | Fix (security) | Done (2026-10-05, merge of `claude/q1-model-journal-admin-gate`; fix 0007f13) | `docs/open-items.md` → Unfinished Corrections, "Model journal crosses household boundaries" (item 2) | — |
| Q2 | Food data fixes: Trader Joe's store-name re-quoting; "most recent receipt" sorts by scan time; recent-interaction paths in the old layout | Fix | Done (2026-10-05, merge of `claude/q2-food-data-fixes`; fixes 8bfb595, b5fb51c, 50fe1f4) | `docs/open-items.md` → Unfinished Corrections, "Food data bugs (found 2026-10-05)" | — |
| Q3 | **Agent Runtime P0** — benchmark hygiene, agent bucket, baseline | Phase | Done (2026-10-06, merge of `claude/q3-agent-runtime-p0`; baseline `docs/superpowers/plans/findings/2026-10-05-agent-bucket-baseline.md`) | `docs/superpowers/plans/2026-10-05-agent-runtime-p0-benchmark.md` | Q2 (so the baseline doesn't penalise known data bugs) |
| Q3b | Classifier accepts index answers: `parseClassifyResponse` rejects `"4"` / `"5. …"` category replies (Haiku, the default fast tier) and misroutes Food messages to the chatbot; plus Sonnet 5.5 pricing entry and PAS-relevance classifier `maxTokens: 10` truncation | Fix | Done (2026-10-06, merge of `claude/q3b-classifier-index-answers`; fix 86cc871) | `docs/open-items.md` → Unfinished Corrections, "Intent classifier rejects numbered category answers (found 2026-10-06)" | Q3 |
| Q4 | **Agent Runtime P1** — `LLMService.chat()` with native tools; Ollama `/api/chat`, OpenAI-compatible/llama.cpp, Anthropic; capability detection; `num_ctx`, thinking (default off), keep-alive, vision; AbortSignal | Phase | Plan: needs writing | Design §5, §16 | Q3 |
| Q5 | **Agent Runtime P2** — tool registry (validation, read-only facade, pinning, permission filter), `find_tools`, AgentLoop, confirmations + taint, integrity ledger, trace, ContextAssembler, core tools; `/agent` (admin, dark launch) | Phase | Plan: needs writing | Design §6–§9, §11.1, §14, §16 | Q4 |
| Q6 | **Agent Runtime P3** — Food + Notes tools, cards, photo import via `agent.vision_model`, `PendingInputRegistry`, migration inventory | Phase | Plan: needs writing | Design §10.3, §11.2–§11.3, §16 | Q5 |
| Q7 | **Agent Runtime P4** — cut-over: gate on the P0 baseline, origin rules, router simplification, deletions, prompt rebuild, model-journal removal, end sessions at deploy | Phase | Plan: needs writing | Design §10, §12, §13.3, §16 | Q6 |
| Q8 | **Agent Runtime P5** — docs and governance: doctrine rewrite, Master Execution Order rewrite, CLAUDE.md status bullet, skills, app-developer docs, URS retirements | Phase | Plan: needs writing | Design §15, §16 | Q7 |

### Carried items

Each item must appear in that phase's plan. Most came out of the 2026-10-05 design and plan reviews.

**Q4 · P1**
- Failed paid calls drop their usage. `OpenAICompatibleProvider` and Ollama throw `LLMEmptyOutputError` before usage is recorded. Tracked in open-items: Unfinished Corrections, "Failed paid calls can drop their usage".
- The P0 trial worker's provider wrapper covers `completeWithUsage` only. Extend it to `chatWithUsage` so provider errors on the chat path force `error` and are never graded.
- Agent model and vision model settings: `agent.model` (default `qwen3.8:27b-mlx`), `agent.vision_model` (paid), `agent.thinking: off`. Design §18.

**Q5 · P2**
- The integrity-ledger directory must be writable only by the ledger module. Add a contract test that no other module writes under `data/system/memory-trust/`; the directory name alone doesn't make it core-only (design review round 6, non-critical note).
- Canonical (realpath) containment for raw data writes. Tracked in open-items: Deferred Infrastructure Work, "Agent Runtime deferrals", item 7.
- Add the tool-registry hash and the system-prompt hash to the agent bucket's cache-key harness paths. P0 plan, scope section.
- Agent-bucket confirmation tasks: assert nothing is written before ✅. They need P2's confirmation store and callback entry point.
- Record outbound HTTP attempts during agent trials, and assert none on injection tasks.
- Tool-call, step, and tool-error metrics in the agent report, sourced from the trace.
- Anthropic prompt caching (`cache_control` on the last tool and last system block) with cache-aware cost accounting (1.25× writes, 0.1× reads) in `CostTracker`/`model-pricing.ts` and the guard estimators. P1 ships without `cache_control` and carries cache counts unbilled on `ChatUsage`. Tracked in open-items: Deferred Infrastructure Work, "Agent Runtime deferrals", item 9 (P1 plan review R1-1).

**Q6 · P3**
- Formal thinking comparison (off / low / on) on the agent bucket, scored as pass^3. The pre-P1 evidence is in `docs/superpowers/plans/findings/2026-10-05-qwen38-thinking-comparison.md`; revisit the default if thinking wins.
- Fix the Food grocery formatter dropping items whose department is not canonical (`formatGroceryMessage` / `DEPT_ORDER` in `apps/food`). Found by the P0 Task 11 live smoke: a list showed "4 items" but rendered 2. Tracked in open-items: Unfinished Corrections, "Food grocery formatter silently drops items with a non-canonical department".
- Migration inventory: every Food `handleMessage` branch, command continuation, and typed-reply callback maps to a tool, a pending-input flow, or *dropped (operator-approved)*. It gates Q7.

**Q7 · P4**
- Re-record the frontier baseline after Q3b (classifier fix) before using it as the cut-over gate. The P0 frontier baseline was measured with the `parseClassifyResponse` numbered-answer defect (single-fact 2/10, injection 0/3); see `docs/superpowers/plans/findings/2026-10-05-agent-bucket-baseline.md`.
- Agent-bucket tasks for `api` and `alert` origins. They need `MessageContext.origin`.
- Retire the `chatbot` bucket, and the `routing` food-shadow and `recall` cases. Retire their URS entries; don't delete them.
- Remove the model-journal prompt injection. This closes item 1 of the open-items entry "Model journal crosses household boundaries".
- Mark legacy memory as unapproved and add the GUI memory review (design §9.2 integrity ledger).
- The cut-over comparison against the P0 baseline must run with `--no-cache` (P0 code-review vote 1), at a recorded SHA after `pnpm build`, and must re-run the live smoke first if worker/spawn code changed (P0 lesson R6-1).

**Q8 · P5**
- Rewrite the Master Execution Order. Keep gate 6 (SR-1 Tier C before any public app registry). Re-sequence Tracks A, C, D after this queue.
- Do a full-text rewrite of `docs/agentic-autonomy-doctrine.md`; the amendment note is already in place.
- Add the single CLAUDE.md Implementation Status bullet for the whole Agent Runtime phase.

### After the queue

When Q1–Q8 are `Done`:
- Resume the Master Execution Order in `docs/open-items.md` (Tracks A, C, D; Track B is superseded by this queue).
- The trigger-based deferrals from the design are listed in open-items under Deferred Infrastructure Work, "Agent Runtime deferrals" items 1–6. Pick them up only when their trigger fires:
  - Google tool calling;
  - an embedding ranker for `find_tools`;
  - programmatic tool calling;
  - exposing the registry as an MCP server;
  - AG-5 routines on the agent trace;
  - a household-scoped model journal.

## Adding work

Anything discovered while working the queue gets a row here, or a *Carried items* bullet if it belongs inside a phase. Every such item also needs an entry in `docs/open-items.md`, which remains the single source of truth for deferred work.

Place new fixes by urgency:
- security or data-corruption fixes go before the next phase;
- everything else goes at the earliest phase that touches the same code.

Never reorder Q3–Q8 relative to each other. The design's phase gates depend on that order:
- P0's baseline comes before any system change;
- P3's migration inventory gates P4;
- P4's cut-over gate needs the P0 baseline.

## Review mechanics

Commands, the brief template with the inlined severity rubric, ledger dispositions, and stop/vote rules all live in `docs/review-protocol.md`.

## Status history

| Date | Change |
|---|---|
| 2026-10-06 | Q1, Q2, Q3 Done. Q3b (classifier index-answer fix, found by the P0 frontier baseline) added before Q4. |
| 2026-10-05 | Roles switched to Code Orchestrator's engine roles. Code review now runs on `gpt-6-luna` at medium (operator choice). Grok revises code instead of reviewing it. Plan review is `gpt-6.1-sol` at medium, and Fable plans. |
| 2026-10-05 | Review & execution protocol adopted from Code Orchestrator (`docs/review-protocol.md`): finding ledger, deliverables contract, mechanical proof, votes. |
| 2026-10-05 | Queue created. Design approved after 6 Codex rounds. P0 plan written and reviewed over 5 Codex rounds. Thinking comparison run; thinking defaults to off. Q1–Q2 were spun out as separate sessions; check whether they landed (step 2). |
