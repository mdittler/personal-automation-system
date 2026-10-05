# Priority Queue — "do the next phase"

**This file is the top of all pending work in PAS.** Its items outrank everything in the Master Execution Order of `docs/open-items.md` (Tracks A–D). Work the queue top to bottom; when it is empty, return to the Master Execution Order.

Set 2026-10-05 by operator decision: Agent Runtime design approved, plus fixes found while designing it. Design: `docs/superpowers/specs/2026-10-05-agent-runtime-design.md`.

---

## When the operator says "do the next phase"

1. **Sync and orient.**
   - Start from an up-to-date `main` (in an app-made worktree, use the host's sync tool).
   - Read this file.
   - Pick the **first row whose Status is not `Done`**. If the operator names an item, do that one instead.
2. **Check it isn't already done.**
   - Some fixes were spun out as separate sessions on 2026-10-05.
   - Search `git log --oneline main` and `docs/open-items.md` for the item.
   - If it already landed, mark it `Done` here with the commit, and go back to step 1.
3. **Announce the item in one line** (e.g. "Next: Q3 — Agent Runtime P0, plan ready"). Then run the workflow for its type below.
4. **Finish.**
   - Update this file: set Status to `Done (YYYY-MM-DD, <commit or PR>)` and add any new work you discovered as rows (see "Adding work").
   - Commit.
   - Report what the next item is.

## Workflow — phases (P0–P5)

This is the workflow every Agent Runtime phase follows. It combines the project's standing practice with the operator's 2026-10-05 instructions.

1. **Plan.**
   - If the row says *Plan: needs writing*, invoke the `writing-plans` skill.
   - Write `docs/superpowers/plans/YYYY-MM-DD-agent-runtime-pN-<slug>.md` from the design section the row names.
   - The plan includes the full documentation footprint: URS entries and traceability rows, a `docs/implementation-phases.md` section, `docs/open-items.md` updates, and this file's row update.
   - It also includes every *Carried items* entry on the row.
2. **Plan review loop.**
   - Run the Codex plan review (template A below) with `gpt-6.1-sol` at high reasoning, read-only.
   - Fix **critical issues only.** Don't iterate on nits or on things naturally decided during implementation.
   - Verify each finding against the code before accepting it. Rejections need a written rationale.
   - Record every round in a "Plan review log" table at the end of the plan.
   - Stop when a round reports none, or when findings have narrowed to implementation-level detail. Say which in the log.
3. **Operator checkpoint.**
   - Give a ≤10-line summary: what the phase delivers, the review outcome, and any open decision.
   - Wait for "go" unless the operator already said to execute without asking.
4. **Execute.**
   - Work on a fresh branch from `main`.
   - Run subagent-driven: a fresh subagent per task, test-first (the `test-driven-development` skill).
   - Roll through all tasks without pausing.
   - At every commit: zero failing tests, and `pnpm lint` reports zero errors.
   - On a bug, use the `systematic-debugging` skill.
5. **End-of-phase code review.**
   - Run one Codex review of the phase diff (template B), critical-only, with the same loop and rules as step 2.
   - Use the `receiving-code-review` and `defect-severity` skills to triage.
   - Apply fixes, with a change table in the phase's `docs/implementation-phases.md` section.
6. **Docs and close.**
   - Complete the documentation footprint.
   - Run the full verification: `pnpm lint && pnpm test && pnpm --filter @pas/regression test && pnpm --filter @pas/regression typecheck`.
   - Update this file. Ask the operator before merging to `main` unless they pre-authorised it.

## Workflow — fixes (rows marked Fix)

- No separate plan doc.
- Write a failing test first (`test-driven-development`); use `systematic-debugging` for root cause.
- Keep the fix minimal, then run one Codex review of the diff (template B, critical-only).
- Add a URS fix entry (`pas-urs-workflow` skill) and close the item in `docs/open-items.md`.
- Use the same verification and close steps as phases.

## Queue

Rows are in execution order. **Depends on** names rows that must be `Done` first.

| # | Item | Type | Status | Plan / source | Depends on |
|---|---|---|---|---|---|
| Q1 | Admin-gate the three model-journal GUI routes | Fix (security) | Not started | `docs/open-items.md` → Unfinished Corrections, "Model journal crosses household boundaries" (item 2) | — |
| Q2 | Food data fixes: Trader Joe's store-name re-quoting; "most recent receipt" sorts by scan time; recent-interaction paths in the old layout | Fix | Not started | `docs/open-items.md` → Unfinished Corrections, "Food data bugs (found 2026-10-05)" | — |
| Q3 | **Agent Runtime P0** — benchmark hygiene, agent bucket, baseline | Phase | **Plan ready** (Codex-reviewed 5 rounds) | `docs/superpowers/plans/2026-10-05-agent-runtime-p0-benchmark.md` | Q2 (so the baseline doesn't penalise known data bugs) |
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

## Review prompt templates

Run from the repo root:

```bash
codex exec -m gpt-6.1-sol -c model_reasoning_effort='"high"' -s read-only -o <review-out.md> - < <prompt.md>
```

Run it in the background. A round takes about 5–10 minutes.

**A — plan review (round 1):**

> Review the IMPLEMENTATION PLAN `<plan path>` in the current working directory (read-only sandbox; do not modify files). It implements phase `<PN>` of the approved design `docs/superpowers/specs/2026-10-05-agent-runtime-design.md` (`<sections>`). The design and phase scope are decided — do not argue them. Verify the plan against the actual code it modifies. Report ONLY critical issues. CRITICAL means at least one of: (a) a step cannot work against the real code (wrong API/signature/path, a test that cannot pass or cannot fail as claimed, an intermediate commit that breaks build/tests, a command that does not do what it says); (b) the plan leaves failing tests or lint errors unaccounted for; (c) a requirement of the phase's design sections neither implemented nor explicitly assigned to a later phase; (d) the change would produce misleading results or a security hole (cross-household data, unconfirmed exfiltration/destructive action, injection path the stated controls miss). Do NOT report details an engineer resolves while coding, naming/wording, style, minor test-strength opinions, or things the plan already flags. For each finding: ID, task/step, problem with file:line evidence, concrete failure, smallest fix. Up to 3 one-line non-critical notes. Final line: "No critical issues" or "N critical issues".

For later rounds, add: *"Rounds 1–N found critical issues; the plan's review log lists them and their fixes. (1) Verify each round-N row is resolved — one line each. (2) Find NEW critical issues, especially any introduced by the round-N fixes."*

**B — code review (end of phase, or a fix):** template A with three changes:
- the object is the diff `git diff main...HEAD`;
- (a) becomes *"the code does not do what the plan/design requires, or a test does not exercise what it claims"*;
- (b) becomes *"failing tests, lint errors, or typecheck errors"*.

## Status history

| Date | Change |
|---|---|
| 2026-10-05 | Queue created. Design approved after 6 Codex rounds. P0 plan written and reviewed over 5 Codex rounds. Thinking comparison run; thinking defaults to off. Q1–Q2 were spun out as separate sessions; check whether they landed (step 2). |
