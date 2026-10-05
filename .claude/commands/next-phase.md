---
description: Start the next item in docs/priority-queue.md (the top of all pending PAS work) and run its workflow
---

Do the next phase.

1. Read `docs/priority-queue.md` and `docs/review-protocol.md` in full — it is the top of all pending work and outranks the Master Execution Order in `docs/open-items.md`.
2. Follow its "When the operator says 'do the next phase'" protocol exactly: sync from `main`, take the first row whose Status is not `Done` (or the item named here: $ARGUMENTS), confirm it has not already landed, announce it in one line, then run the workflow for its type (phase or fix).
3. For a phase, use the protocol's roles (Code Orchestrator):
   - a Fable subagent plans (with the `writing-plans` skill and the required sections) unless the row says the plan is ready;
   - Codex `gpt-6.1-sol` at medium reviews the plan, and Fable revises (≤3 iterations), with every finding dispositioned;
   - operator gate;
   - Sonnet subagents execute test-first with mechanical/closure proof, ticking the acceptance checklist;
   - Codex `gpt-6-luna` at medium reviews the code, and Grok `grok-4.7-high` revises (≤5 iterations);
   - Sonnet simplify, then a confirming Luna review;
   - verify, operator gate, merge, update the queue row.
   List the model roster at the start; report cost and wall-clock time at the end.
4. Before finishing, update the row's Status, add any newly discovered work as rows or carried items (and to `docs/open-items.md`), commit, and tell the operator what the next item is.
