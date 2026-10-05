---
description: Start the next item in docs/priority-queue.md (the top of all pending PAS work) and run its workflow
---

Do the next phase.

1. Read `docs/priority-queue.md` in full — it is the top of all pending work and outranks the Master Execution Order in `docs/open-items.md`.
2. Follow its "When the operator says 'do the next phase'" protocol exactly: sync from `main`, take the first row whose Status is not `Done` (or the item named here: $ARGUMENTS), confirm it has not already landed, announce it in one line, then run the workflow for its type (phase or fix).
3. For a phase: plan via the `writing-plans` skill (unless the row says the plan is ready) → Codex critical-only plan review loop (template A) → operator checkpoint → subagent-driven, test-first execution → end-of-phase Codex review (template B) → full documentation footprint → update the queue row.
4. Before finishing, update the row's Status, add any newly discovered work as rows or carried items (and to `docs/open-items.md`), commit, and tell the operator what the next item is.
