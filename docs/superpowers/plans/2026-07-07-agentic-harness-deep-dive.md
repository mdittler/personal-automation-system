# Agentic Harness Deep Dive — Should PAS Have a Light-Harness Mode? (2026-07-07)

**Provenance:** Produced by Claude Fable 5 as a strategic investigation, companion to
`2026-07-07-fable-strategic-review.md`. **No code was written.** This is a design-space
analysis + recommendations document, written so that a future session (Opus-class model)
can run the planning pass (`superpowers:writing-plans` + Codex review) for any
recommendation the operator confirms, without needing this conversation.

**Operator's question (paraphrased):** Hermes-agent and OpenClaw have a *lighter harness* —
less structure around the model — which gives them greater flexibility. Deep-dive how PAS
could include something like that, and recommend how to handle it — or whether it's a good
idea at all. Constraint to weigh: PAS's structure is what lets *lower-quality, cheaper
(local) models accomplish more*; that benefit must be preserved.

**Reading order for a future implementer:** Part 0 (definitions) → Part 2 (what PAS already
has/planned — do not redesign what the T-track already covers) → Part 4 (the options ladder)
→ Part 6 (recommendations AG-1..AG-8). Parts 1, 3, 5 are the supporting analysis.

**Epistemic status markers used below:**
- *[verified]* — checked against this repo during the investigation session.
- *[training-knowledge]* — characterization of hermes-agent/OpenClaw from model knowledge
  (cutoff Jan 2026). **Re-verify against current upstream before citing in public docs or
  basing security decisions on it.**
- *[judgment]* — a discretionary call; the operator or a future reviewer may overrule.

---

## Part 0 — Definitions: what "harness weight" actually means

"Light vs. heavy harness" conflates several independent axes. Decisions get better when
they're separated:

| Axis | Light end | Heavy end | PAS today *[verified]* |
|---|---|---|---|
| **A. Control flow** | Model-driven loop: model decides next action, when to stop | Code-driven: deterministic router dispatches to handlers; LLM is a component inside them | Heavy (Router + IntentClassifier + per-app handlers; chatbot is the *fallback*) |
| **B. Tool breadth** | Shell, filesystem, browser, arbitrary HTTP | Narrow, purpose-built, mediated APIs | Heavy (no tools at all yet; pseudo-tools like `<config-set>` are parsed from text; T2 will add a mediated ToolRegistry) |
| **C. Autonomy horizon** | Long-running, resident, self-initiating | One request → one response; proactive work only via operator-defined cron | Heavy (cron + alerts only; every proactive path is operator-configured) |
| **D. Self-modification** | Agent writes its own skills/memory/prompts | Immutable behavior between deploys; humans review changes | Heavy (hermes review explicitly rejected self-improving loops — "What PAS Should Not Adopt" #3) |
| **E. Model dependence** | Requires frontier-class models; degrades badly below that | Cheap/local models do most of the work inside structure | Heavy by design (fast/standard/reasoning tiers; local Ollama/llama.cpp are first-class and free) |

**Hermes-agent** *[training-knowledge]*: model-driven loop (`run_agent.py`), broad tools,
many platform adapters, memory framework with a self-improvement framing, built for agent
research (trajectory recording/replay). Light on A–D, frontier-leaning on E.

**OpenClaw** *[training-knowledge]*: resident personal agent with shell/browser/messaging
reach, viral precisely because A–C are light ("it can just do things"), and repeatedly
criticized on security grounds for the same reason — the prompt-injection blast radius of
a light harness with broad tools is the whole attack surface at once. Its practical floor
is frontier-model capability and frontier-model spend.

**The key reframe for everything below:** the choice is not a point on a single
light↔heavy dial. PAS can be — and should be — *heavy on the boundary, light inside it*:
deterministic budgets, tool mediation, and confirmation gates (heavy B, D), wrapped around
a model-driven loop (light A) whose autonomy horizon is explicitly purchased per-session
(metered C), on tiers that can afford it (managed E).

---

## Part 1 — The economics: why structure is the cheap-model amplifier

This is the operator's stated constraint, and the repo contains *measured* evidence for it
*[verified]*, from the persona regression suite (open-items Chunk C entries, findings doc
`2026-05-11-chunk-c-local-model-verification.md`):

- **Structured tasks, local model:** Gemma (local, $0/token) scored **32/36 = 89.6%** on
  routing classification — narrow JSON-schema outputs, few-shot prompts, deterministic
  oracle. Zero parse failures after prompt hardening.
- **Open-ended tasks, local model:** the same model family as a free-form rubric *judge*
  degenerated into token-repetition loops (chatbot bucket 3/10 pass, 7 error), and even
  frontier Sonnet mis-graded fenced content in the same open-ended role.
- The tier system (fast/standard/reasoning, `ModelSelector`), `LLMGuard` cost caps, and
  `isLocalProvider` free-inference accounting all exist to exploit exactly this asymmetry.

Generalization *[judgment, but strongly evidence-backed]*: **structure is a capability
transfer mechanism.** A schema, a decomposed pipeline, a few-shot prompt, a retry-on-parse
guard — each is intelligence moved from inference time (paid per call, needs a big model)
into design time (paid once, authored by a big model or a human). A light harness does the
opposite: it re-derives the plan on every request, which is why it needs frontier models
every time and why its cost has high variance.

Two corollaries that shape the recommendations:

1. **A light-harness mode in PAS must be tier-gated.** Handing the agentic loop to the
   fast tier doesn't give you a cheap agent; it gives you the token-repetition judge with
   tool access. Autonomy level must be a function of model capability (see AG-4).
2. **The highest-leverage design is one where agency is spent once and structure is kept.**
   If a frontier model solves a novel task agentically, the *trajectory* is a design-time
   artifact: it can be distilled into a deterministic routine that cheap tiers (or no LLM
   at all) execute thereafter. Agency as authoring mode, structure as execution mode.
   This is Option 2 below and the centerpiece recommendation (AG-5).

---

## Part 2 — What PAS already has pointed at this (do not redesign)

A future implementer must position any agentic work relative to three existing bodies of
design *[verified]*:

1. **The T-track** (open-items Phase Sequence #4–19) already commits PAS to:
   `completeWithTools` + an **owned loop wrapper** with **per-step cost reservation** (T1),
   ToolRegistry + ToolPolicy + manifest `capabilities.tools[]` (T2a),
   PendingToolConfirmationStore + confirm/deny callbacks (T2b),
   tool-trace NDJSON + tool-result fencing + PII redaction (T2c),
   shadow mode with sample-rate + cost cap + kill switch (T3),
   pseudo-tool migration (T4), per-app intent→tool migration (T5.x),
   chatbot-primary flip + classifier deletion (T6).
   **This is already a move from heavy-A toward light-A** — the LLM becomes the primary
   dispatcher — but with the loop owned by code, not the model. Everything in this doc
   layers on the T2 substrate; nothing here replaces it.
2. **The agentic-loops proposal** (`2026-04-15-llm-enhancement-opportunities.md`,
   "Agentic AI Opportunities"): six *periodic, non-interactive, proposal-producing* agents
   (Routing-Learning, Data Steward, Receipt/OCR QA, Household Planning, Ops, App
   Onboarding). Note their common shape: they run on cron, read logs/data, and produce
   **proposals for human review** — light-A inside a heavy-C/heavy-D envelope. Already
   dependency-gated on T2. This doc classifies them as Option 1.5 and keeps them as-is.
3. **The hermes adoption review** (`docs/hermes-agent-adoption-review.md`, "What PAS
   Should Not Adopt") — three rejections directly constrain agentic design, with this
   doc's stance on each *[judgment]*:
   - *#3 Self-improving agent / skill-creation loops* — **affirm**, with one carve-out:
     Option 2's routine distillation is *not* self-improvement in the rejected sense,
     because promotion to executable status goes through a human review queue — which is
     exactly the alternative the review itself recommends ("review queues, admin digests,
     and suggested promotions").
   - *#5 Batch runner / trajectory infrastructure* — **affirm for research-style replay;
     revisit narrowly**: an agent session needs a *trace* for auditability and for
     distillation input. That is the T2c tool-trace NDJSON, not new infrastructure.
   - *#8 Memory as a general LLM-visible tool early* — **affirm**; agent-mode tool
     allowlists (AG-3) must respect it. Memory stays behind audited services until the
     retrieval quality + security evidence exists.

---

## Part 3 — What a light harness would actually buy PAS, and what it would cost

### Buys

- **The long tail.** Structured routing covers engineered intents. Real households produce
  unbounded novel requests ("figure out which pantry items expire while we're on vacation
  and adjust the grocery list") that no per-intent engineering will ever enumerate. This is
  the single strongest argument *for* — it is OpenClaw's entire value proposition.
- **Cross-app composition.** Today, workflows spanning apps exist only where an operator
  pre-wired them (alerts → actions, EventBus). An agent with tools from multiple apps
  composes them on demand.
- **Development velocity for app authors.** In a tools-first world, an app ships tools +
  descriptions instead of handlers + classifier examples; the T5 migration already heads
  here. A bounded agent loop multiplies the value of every tool an app ships — good for
  the app-ecosystem pitch.
- **Authoring leverage** (unique to Option 2): non-technical users could create new
  automations by *demonstrating* them conversationally once, instead of learning the
  report/alert wizards. The wizards remain the transparent, editable representation.

### Costs

- **Predictability — the brand.** PAS's differentiator is "more predictable than
  OpenClaw." An unbounded agent loop has variance in outcome, latency, and cost.
  *Resolution [judgment]:* predictability is about **variance the user didn't ask for**.
  An explicitly-entered, budget-capped, confirm-gated agent session that reports what it
  did does not break the brand; a resident agent that acts on its own does.
- **Security.** Prompt-injection blast radius ≈ (tool power) × (autonomy) × (untrusted
  input in context). Agent mode raises the second factor, so the other two must be
  clamped: mediated tools only (never shell — consistent with the banned-imports posture),
  and fenced data (T2c) plus confirmation gates on mutations. Note the interaction with
  SR-1: in-process apps mean a malicious *app-shipped tool description* is itself an
  injection vector — tool registration must be part of the SR-1 capability review.
- **Cost structure.** Frontier-tier loops with unbounded steps invert the local-first
  economics. Mitigation is metering, not hope: per-step cost reservation already planned
  in T1; agent sessions add a per-session budget (AG-3).
- **Evaluatability.** The persona regression suite works because behavior is decomposed
  into schema-checkable steps. Agent trajectories are path-nondeterministic.
  *Resolution:* test **outcomes, not paths** — a new regression bucket asserts on final
  data-file state and budget compliance, not on the tool-call sequence (AG-7). This stays
  inside the existing harness machinery and does not resurrect the rejected trajectory
  infra.
- **Support burden.** "The agent did something weird" is a new class of operator debugging.
  The tool-trace NDJSON (T2c) is the answer, and the GUI activity surface should render it
  (AG-6).

### Verdict on "is it a good idea?"

**Conditionally yes** *[judgment]*: as *graduated autonomy* layered on the T-track substrate
— opt-in, tier-gated, budget-capped, tool-mediated, trace-logged — with routine
distillation (Option 2) as the strategically differentiating piece. **No** to an
OpenClaw-style resident agent (broad tools, self-initiating, always-on) in core, ever; if
the ecosystem someday demands one, it belongs in a clearly-labeled separate app under the
SR-1 Tier-C isolation regime, not in the platform.

The honest competitive positioning this yields: *"OpenClaw gives a frontier model your
whole machine. PAS gives any model — including the free local one — exactly the levers you
chose, and lets a frontier model earn bigger levers one bounded session at a time."*

---

## Part 4 — The options ladder

Ordered by increasing harness lightness. Each option names its model-tier floor, because
that is the operator's stated constraint.

### Option 0 — No agentic mode (T-track only)
Chatbot-primary with single-shot tool calls (the owned loop handles multi-call turns, but
code decides continuation). Tier floor: standard.
*Assessment:* viable, safe, forfeits the long tail and the authoring leverage. This is the
default if nothing below is confirmed — and it is where PAS lands anyway if AG work never
happens. Everything below is additive to it.

### Option 1 — Bounded interactive agent sessions
An explicit escape hatch: user (or an admin-only rollout first) enters agent mode for one
task — via a `/agent <task>` command and/or automatic *offer* ("This looks multi-step —
want me to work through it? [estimated budget]") when structured routing + single-shot
tools can't satisfy a request. Inside the session: model-driven loop over **the same
ToolRegistry tools** the structured path uses (no agent-only tools), ToolPolicy-filtered,
step-capped, per-session budget reserved up front, confirmation gates on mutating tools,
every step in the tool trace, hard kill switch. Ends with a plain-language report of what
was done and what it cost. Tier floor: **reasoning**; refuse (with explanation) on tiers
below the configured floor.
*Assessment:* the safe core of "light inside, heavy boundary." Ships the long tail and
cross-app composition at strictly bounded risk. Reuses T1/T2 almost entirely — the new
surface is session lifecycle + budget envelope + UX.

### Option 1.5 — Background proposal agents (already designed)
The six cron-driven agents from the 2026-04-15 plan. Light-A inside heavy-C/D: they never
mutate, they produce review-queue proposals. Tier floor: standard (their tasks are
read-and-summarize shaped). *Assessment:* keep as designed; they become cheaper to build
once Option 1's session envelope exists (same loop, no interactivity, stricter policy:
read-only toolset).

### Option 2 — Agency as authoring, structure as execution (routine distillation)
The strategic move, and the direct answer to the cheap-model constraint. Pipeline:
1. A frontier-tier agent session (Option 1) accomplishes a novel task; its tool trace is
   the raw trajectory.
2. A **distillation step** (frontier-tier, offline, one-shot) converts the trajectory into
   a *routine*: a declarative artifact — sequence of tool invocations with parameter
   templates, guard conditions, and typed slots for the parts that vary ("date", "which
   list") — stored as markdown+YAML like everything else in PAS, human-readable and
   human-editable.
3. The routine enters a **review queue** (admin GUI); on approval it becomes runnable —
   on a schedule, as an alert action, or by name from chat.
4. Execution of a routine needs **no frontier model**: deterministic steps run with no LLM
   at all; fuzzy slots (classification/extraction) run on the fast tier. Re-running last
   month's "vacation pantry sweep" costs approximately nothing.
*Assessment:* this converts agent spend into durable, auditable automation — compounding
value instead of per-request cost. It is also the honest version of "self-improving": the
system accumulates *reviewed* capabilities, satisfying the hermes review's stance. Risks:
routine representation is a real design problem (expressiveness vs. auditability — start
minimal: linear steps + guards, no loops/branching beyond guard-skip); trajectory→routine
distillation quality needs its own regression bucket; staleness when app tools change
(bind routines to tool schema versions; invalidate on mismatch). Depends on Option 1 +
T2a's tool schemas. Tier floor: frontier for authoring, fast/none for execution — which is
the entire point.

### Option 3 — Resident light-harness agent (OpenClaw mode)
Broad tools (shell/fs/http), always-on, self-initiating, self-extending.
*Assessment:* **recommend against for core, permanently** *[judgment]*. It contradicts the
product pitch, multiplies the SR-1 problem (the platform would be doing what a malicious
app would do), makes local-first economically fictional, and its one real advantage over
Option 1+2 (zero-friction breadth) is exactly the property that produced OpenClaw's
security reputation. If ever revisited: separate app, SR-1 Tier-C isolation, its own
threat model, off by default.

---

## Part 5 — Cross-cutting design notes for the implementer

- **Config surface (sketch, final names at planning time):** `agent.enabled` (default
  false), `agent.tier_floor` (default `reasoning`), `agent.max_steps` (default small,
  e.g. 8), `agent.budget_usd_per_session`, `agent.daily_budget_usd`,
  `agent.tools_denylist` (on top of ToolPolicy), `agent.require_confirmation`
  (default true; per-tool override only via manifest, not user config),
  `routines.enabled`, `routines.review_required` (default true, not overridable).
  All under the existing per-user config + `/settings` machinery; household caps via
  `HouseholdLLMLimiter` extension.
- **Loop ownership stays in code.** Even in agent mode, the loop wrapper (T1) owns
  step counting, budget checkout, timeout, and cancellation. The model chooses *actions*;
  it never owns *continuation*. This one invariant is most of the difference between
  Option 1 and Option 3, and it should be stated in the URS as a hard requirement.
- **Injection posture:** everything entering the agent context that isn't the user's own
  words — file contents, tool results, app-shipped tool descriptions — is fenced (T2c
  convention) and the system prompt states the fence semantics. Mutating tools behind
  PendingToolConfirmationStore. The confirmation prompt must render *arguments*, not just
  the tool name ("write to `households/h1/shared/food/grocery-list.md`: …").
- **Failure UX:** budget exhausted / step cap / tier floor unmet are *first-class,
  plain-language outcomes* ("I got through 6 of the steps and used the $0.40 you
  allowed; here's where I stopped"), not errors. The GUI UX Redesign's plain-language
  standards apply.
- **Telemetry to design in from day one:** per-session cost distribution, step-count
  distribution, confirmation deny rate, task abandonment, and — for Option 2 — routine
  reuse counts (the metric that proves the distillation thesis).
- **What to watch upstream** *[training-knowledge — re-verify]*: hermes-agent's and
  OpenClaw's harness designs evolve quickly; before the planning pass, spend an hour
  re-reading their current tool-mediation and permission stories. If OpenClaw has since
  grown real permission boundaries, the competitive framing in Part 3 needs updating even
  though the architecture recommendation likely stands.

---

## Part 6 — Recommendations (AG-1..AG-8)

Each is independently confirmable. "Planning inputs" = what the future planning session
must produce; this doc deliberately does not.

- **AG-1 — Adopt the "graduated autonomy" doctrine and write it down.** One page in
  `docs/` (or folded into `APP_TRUST_MODEL.md` from SR-1): autonomy is purchased
  per-session, gated by model tier, bounded by budget/steps, mediated by ToolPolicy,
  logged by tool trace; the loop is always code-owned. This is a *decision*, not code —
  it should be made before T2a freezes the manifest capability surface, because tool
  definitions need an `agentAllowed`/risk-class field (see AG-3). *Planning inputs:*
  none; this is a docs task once confirmed. **Do first.**
- **AG-2 — Build Option 1 (bounded agent sessions) as a phase after T3.** Not before:
  T3's shadow-mode telemetry (tool-call quality at sample rate, under cost cap) is the
  evidence that the loop substrate behaves. Admin-only first, then per-user opt-in
  (mirrors the T3b pattern). *Planning inputs:* session lifecycle states, budget
  reservation API against CostTracker, `/agent` UX + the "offer to escalate" heuristic,
  URS entries (proposed area `REQ-AGENT-*`), regression bucket (see AG-7).
- **AG-3 — Extend T2a's tool schema with agent-facing metadata now, even if agent mode
  ships much later.** Per-tool: risk class (`read` / `write` / `external-effect`),
  `agentAllowed` flag, confirmation requirement, cost hint. Retrofitting risk classes
  onto dozens of shipped tools later is the expensive path; carrying unused fields is
  cheap. *Planning inputs:* field definitions folded into the T2a plan — this is a
  one-paragraph amendment to that phase, and the main reason this doc should be read
  before T2a planning.
- **AG-4 — Tier-gate autonomy explicitly.** Codify the capability ladder: fast tier =
  classification/extraction inside structure (never loops); standard = single mediated
  tool calls; reasoning/frontier = bounded loops (Option 1) and authoring (Option 2).
  Refusals at the floor are explained to the user, with the config path to change it.
  The regression suite's model-matrix machinery is the enforcement evidence: an autonomy
  level is only as real as the bucket that tests it per-tier. *Planning inputs:* config
  keys, refusal UX, model-matrix additions.
- **AG-5 — Design Option 2 (routine distillation) as the flagship differentiator; plan it
  as its own phase after AG-2 ships and has ≥1 month of real agent-session traces.**
  Traces are the training data for the routine representation design — designing the
  representation before seeing real trajectories is guessing. *Planning inputs:* routine
  file format (markdown+YAML, linear steps + guards, typed slots), distillation prompt +
  its regression bucket, review-queue GUI (reuse wizard patterns), execution engine
  (deterministic steps + fast-tier slots), staleness/versioning against tool schemas,
  URS area (proposed `REQ-ROUTINE-*`).
- **AG-6 — Surface agent activity in the GUI from the first session.** The T2c tool trace
  rendered as a per-session timeline (what ran, what it touched, what it cost, what was
  confirmed/denied), on the Activity surface built by the GUI UX Redesign. Observability
  is the *product form* of the predictability pitch. *Planning inputs:* folded into AG-2's
  plan, not separate.
- **AG-7 — Evaluate outcomes, not paths.** New regression bucket `agent`: seed a temp data
  tree, run a task at a fixed budget, assert on final file state (multiset/structural
  oracles already exist) + budget/step compliance; never assert the tool-call sequence.
  Reuses the persona-regression machinery (budgets, cache, model matrix) — and note the
  existing "generic per-app test discovery" proposal + SR-4 share the seam this needs.
  *Planning inputs:* bucket design in AG-2's plan; keep the hermes review's rejection of
  trajectory-replay infra intact.
- **AG-8 — Do not build Option 3.** Record the decision and the reasoning (Part 4) in the
  doctrine doc from AG-1 so future contributors don't relitigate it casually. Revisit
  trigger: only if SR-1 Tier C isolation ships *and* a concrete user population asks for
  it *and* the operator accepts the positioning change — all three.

### Sequencing relative to existing tracks

```
T1a → T1 → [AG-1 doctrine + AG-3 schema amendment land inside T2a planning]
      T2a → T2b → T2c → T3 ──→ AG-2 (Option 1, admin-only → opt-in) + AG-6 + AG-7
                                   └─ ≥1 month traces ─→ AG-5 (Option 2, routines)
Option 1.5 (background proposal agents): unblocked by T2, independent of AG-2 timing.
SR-1 interaction: tool registration review is part of SR-1 Tier A; AG work inherits it.
```

### Operator decision points (open — this doc deliberately does not decide)

1. **Confirm the doctrine (AG-1) and the AG-3 schema amendment** — these are the only
   time-sensitive pieces (they ride on T2a planning). Everything else can wait.
2. **Frontier dependence acceptance:** Option 1 is honest about needing reasoning-tier
   models per session. Acceptable for a local-first project's positioning? (Option 2 is
   the mitigation — decide whether that answer satisfies.)
3. **Who gets agent mode first** — admin-only indefinitely vs. per-user opt-in on a
   timeline. (Recommendation: admin-only until AG-7's bucket is green across the model
   matrix.)
4. **Whether Option 2 justifies its complexity** before an app ecosystem exists — it is
   the most original piece and also the most speculative. The ≥1-month-of-traces gate in
   AG-5 is designed so this decision is made on evidence, not enthusiasm.

---

## Tracking

**Update 2026-07-07 (same day): AG-1..AG-8 confirmed by the operator.** Current state:

- **AG-1 shipped:** doctrine adopted at `docs/agentic-autonomy-doctrine.md` (includes the
  AG-8 standing decision with its three-condition revisit gate).
- **AG-3:** recorded as a rider on the T2a row in the open-items Phase Sequence (#6) —
  binds when T2a planning happens.
- **AG-2/AG-4/AG-6/AG-7** (one phase) and **AG-5** (follow-on phase): planned-phase prose in
  `docs/implementation-phases.md` → "Planned Phases — Strategic Review & Agentic Autonomy";
  tracking entry in `docs/open-items.md` → Confirmed Phases ("AG — Graduated agentic
  autonomy").
- Companion to `2026-07-07-fable-strategic-review.md` (SR-1..SR-4); this doc owns the
  agentic question end-to-end.
- Per project convention: each phase still gets a `superpowers:writing-plans` pass + Codex
  review before implementation; URS areas (`REQ-AGENT-*`, `REQ-ROUTINE-*`) assigned then.
