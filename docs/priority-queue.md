# Priority Queue — "do the next phase"

**This file is the top of all pending work in PAS.** Its items outrank everything in the Master Execution Order of `docs/open-items.md` (Tracks A–D). Work the queue top to bottom; when it is empty, return to the Master Execution Order.

Set 2026-10-05 by operator decision: Agent Runtime design approved, plus fixes found while designing it. Design: `docs/superpowers/specs/2026-10-05-agent-runtime-design.md`.

---

## When the operator says "do the next phase"

**How to work: follow `docs/review-protocol.md`**, adopted 2026-10-05 from the Code Orchestrator project. It covers roles and models, cross-vendor review with Codex `gpt-6.1-sol` and Grok 4.7, the finding ledger, stop rules, votes, and execution rules.

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

1. **Plan.**
   - If the row says *Plan: needs writing*, invoke the `writing-plans` skill and write `docs/superpowers/plans/YYYY-MM-DD-agent-runtime-pN-<slug>.md`.
   - Base it on the design sections the row names, plus every *Carried items* bullet for the row.
   - Include the required sections from protocol §2: Deliverables, test-first tasks, a live smoke, the Plan review log, the Review findings acceptance checklist, and Implementation notes from review.
   - Include the documentation footprint: URS entries and traceability rows, a `docs/implementation-phases.md` section, `docs/open-items.md` updates, and this file's row.
2. **Plan review.**
   - Run cross-vendor rounds (protocol §3) until the stop rules are met (§5).
   - Every finding, critical or not, gets a home (§4).
   - If the plan was reviewed before this protocol existed (Q3's P0 plan), run **one confirming cross-vendor round with Grok included** before execution, and backfill the acceptance checklist and implementation notes.
3. **Operator checkpoint.**
   - Give a ≤10-line summary: what ships, the review outcome, and any operator-disposition findings.
   - Wait for "go" unless the operator already said to execute without asking.
4. **Execute.** Follow protocol §7: fresh Sonnet subagents, test-first, mechanical and closure proof, the acceptance checklist ticked with observed evidence, and implementation notes handled.
5. **Code review.** Run cross-vendor rounds on the phase SHA in a detached worktree. The brief includes the Deliverables, the acceptance checklist, and the implementation notes. Continue until no finding is left undispositioned.
6. **Verify and close.**
   - Run `pnpm lint && pnpm test && pnpm --filter @pas/regression test && pnpm --filter @pas/regression typecheck` and save `suite-<sha>.txt`.
   - Re-check that HEAD equals the tested SHA.
   - Complete the documentation footprint.
   - Ask before merging, unless pre-authorised. Then merge `--no-ff`, delete the branch, and reconcile this file.

## Workflow — fixes (rows marked Fix)

Follow protocol §8:
- write a failing test first, using `systematic-debugging` for root cause;
- make the minimal fix and get closure proof;
- run cross-vendor code review rounds;
- add a URS fix entry and close the `docs/open-items.md` item;
- verify and close as for phases.

## Queue

Rows are in execution order. **Depends on** names rows that must be `Done` first.

| # | Item | Type | Status | Plan / source | Depends on |
|---|---|---|---|---|---|
| Q1 | Admin-gate the three model-journal GUI routes | Fix (security) | Not started | `docs/open-items.md` → Unfinished Corrections, "Model journal crosses household boundaries" (item 2) | — |
| Q2 | Food data fixes: Trader Joe's store-name re-quoting; "most recent receipt" sorts by scan time; recent-interaction paths in the old layout | Fix | Not started | `docs/open-items.md` → Unfinished Corrections, "Food data bugs (found 2026-10-05)" | — |
| Q3 | **Agent Runtime P0** — benchmark hygiene, agent bucket, baseline | Phase | **Plan ready** (Codex reviewed it over 5 rounds; it still needs one confirming cross-vendor round with Grok — see Workflow step 2) | `docs/superpowers/plans/2026-10-05-agent-runtime-p0-benchmark.md` | Q2 (so the baseline doesn't penalise known data bugs) |
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

**Q6 · P3**
- Formal thinking comparison (off / low / on) on the agent bucket, scored as pass^3. The pre-P1 evidence is in `docs/superpowers/plans/findings/2026-10-05-qwen38-thinking-comparison.md`; revisit the default if thinking wins.
- Migration inventory: every Food `handleMessage` branch, command continuation, and typed-reply callback maps to a tool, a pending-input flow, or *dropped (operator-approved)*. It gates Q7.

**Q7 · P4**
- Agent-bucket tasks for `api` and `alert` origins. They need `MessageContext.origin`.
- Retire the `chatbot` bucket, and the `routing` food-shadow and `recall` cases. Retire their URS entries; don't delete them.
- Remove the model-journal prompt injection. This closes item 1 of the open-items entry "Model journal crosses household boundaries".
- Mark legacy memory as unapproved and add the GUI memory review (design §9.2 integrity ledger).

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
| 2026-10-05 | Review & execution protocol adopted from Code Orchestrator: cross-vendor review with Codex `gpt-6.1-sol` + Grok 4.7, finding ledger, deliverables contract, mechanical proof, votes (`docs/review-protocol.md`). Q3 needs one confirming round with Grok. |
| 2026-10-05 | Queue created. Design approved after 6 Codex rounds. P0 plan written and reviewed over 5 Codex rounds. Thinking comparison run; thinking defaults to off. Q1–Q2 were spun out as separate sessions; check whether they landed (step 2). |
