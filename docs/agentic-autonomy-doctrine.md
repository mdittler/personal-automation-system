# Agentic Autonomy Doctrine

**Status:** Adopted 2026-07-07 (operator decision, AG-1). Binding on all future agentic
work. Full analysis behind every statement here:
`docs/superpowers/plans/2026-07-07-agentic-harness-deep-dive.md`.

PAS's differentiator against light-harness agent systems (OpenClaw-class resident agents,
research harnesses like hermes-agent) is **predictability — defined as the absence of
variance the user didn't ask for**, not the absence of capability. Agentic behavior is
allowed in PAS under the following doctrine.

## The doctrine

1. **Autonomy is purchased per-session, never resident.** Agentic loops run only inside an
   explicitly entered, individually budgeted session (user-initiated command, accepted
   escalation offer, or operator-defined cron proposal-agent). There is no always-on,
   self-initiating agent.
2. **The loop is code-owned.** The model chooses *actions*; infrastructure owns
   *continuation* — step counting, per-step cost reservation, timeout, cancellation, and
   the kill switch. The model can never decide to keep going past the envelope.
   (Substrate: T1 owned loop wrapper.)
3. **Autonomy is tier-gated.** The capability ladder: **fast tier** — classification and
   extraction inside structure, never loops; **standard tier** — single mediated tool
   calls; **reasoning/frontier tier** — bounded multi-step sessions and routine authoring.
   Below the configured floor, PAS refuses with an explanation, not a degraded attempt.
   Rationale: structure is what makes cheap/local models effective (measured: local Gemma
   89.6% on structured routing vs. token-repetition collapse on open-ended judging —
   regression suite, Chunk C evidence); autonomy without capability is the failure mode,
   not the feature.
4. **Tools are mediated, always.** Agent sessions draw from the same ToolRegistry as the
   structured path, filtered by ToolPolicy and per-tool agent metadata (risk class,
   `agentAllowed`, confirmation requirement — AG-3 fields on the T2a schema). No
   agent-only tools; **no shell, ever** (consistent with the banned-imports posture).
   Mutating and external-effect tools require user confirmation rendering the *arguments*,
   not just the tool name.
5. **Everything is traced and visible.** Every step lands in the tool trace (T2c NDJSON);
   every session renders as a plain-language timeline in the GUI (what ran, what it
   touched, what it cost, what was confirmed or denied). Budget exhaustion and step-cap
   stops are first-class outcomes reported to the user, not errors.
6. **Agency is spent once; structure is kept.** The preferred end-state for any recurring
   agentic task is distillation into a reviewed, human-readable *routine* (markdown+YAML,
   linear steps + guards, typed slots) that executes deterministically or on the fast tier
   (AG-5). Routines enter service only through a human review queue — PAS accumulates
   *reviewed* capabilities, never self-modifying behavior (upholds the hermes adoption
   review's rejection of self-improving loops).
7. **Outcomes are tested, not paths.** Agentic behavior is regression-tested by asserting
   final data state and budget/step compliance under the persona-regression machinery —
   never by asserting the tool-call sequence.

## Standing decision: no resident light-harness agent (AG-8)

An OpenClaw-style resident agent — broad tools (shell/filesystem/browser), always-on,
self-initiating, self-extending — will **not** be built into PAS core. It contradicts the
predictability pitch, maximizes prompt-injection blast radius, and makes local-first
economics fictional. This decision is not to be relitigated casually; the full reasoning
is in the deep-dive doc, Part 4 Option 3.

Revisit only if **all three** hold: (1) SR-1 Tier C per-app process isolation has shipped,
(2) a concrete user population is asking for it, and (3) the operator explicitly accepts
the repositioning. Even then it would be a separate, clearly-labeled app under Tier C
isolation — never a platform feature.

## Sequencing pointers

AG-1 (this doc) and AG-3 (tool-schema metadata) ride **T2a planning**. AG-2 (bounded agent
sessions) gates on **T3 shadow evidence**. AG-5 (routines) gates on **AG-2 plus ≥1 month
of real session traces**. See `docs/open-items.md` (Confirmed Phases) and
`docs/implementation-phases.md` (Planned Phases — Strategic Review & Agentic Autonomy).
