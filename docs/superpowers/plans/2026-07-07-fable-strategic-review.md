# Fable Strategic Review — Open-Source Readiness & Forward Design (2026-07-07)

**Provenance:** Produced by Claude Fable 5 in a single strategic-review session, grounded in
the repo state as of 2026-07-07 (post GUI UX Redesign; audit roadmap complete). This is the
companion to the audit findings doc (`2026-06-11-ux-review-findings-and-fix-plan.md`): where
the audit asked *"what is broken?"*, this doc asks *"what is missing between the current
system and the stated ambition?"*

**Stated ambition (operator, 2026-07-07):** PAS should become open-source infrastructure that
people build on — a replacement for Hermes-style agent stacks and OpenClaw, but with more
predictable functionality and a security-minded design, where people can share apps they find
useful.

**How to use this doc:** Part 1 is the assessment. Part 2 is the phase summary — each proposed
phase (SR-1..SR-4) is one row, with a pointer to its detailed design section in Part 3. Part 3
sections are *design inputs*, not implementation plans: each still needs a proper planning pass
(`superpowers:writing-plans`, Codex review) before execution. All four phases are tracked as
Proposals in `docs/open-items.md`.

---

## Part 1 — High-Level Assessment

Grounded in: ~91k LOC of source (excluding tests), 614 test files (~10.9k tests), ~1,500
URS requirement references with a traceability matrix, 3 apps (echo, notes, food), nine
completed audit passes, zero CI.

### Ratings

| Dimension | Score | One-line rationale |
|---|---|---|
| **Idea** | 7.5/10 | The gap is real — OpenClaw proved both the demand and the failure mode (unpredictable agents, no plugin trust story). "Predictable, security-minded, safe app sharing" is a genuine differentiator. Held back by: brutal market pace, cold-start problem for the app ecosystem, and "less magic" being harder to market. |
| **Execution** | 8/10 | Solo-project discipline is exceptional: URS + traceability, persona regression suite with budget guards, LLM security boundary with build-failing guards, completed audit roadmap. Deductions are the audit's own findings: no CI, 35 known dep vulns, backups disabled in production, reproduced first-boot crash. |
| **Current state vs. ambition** | 5/10 | Works as personal infrastructure. As "infrastructure strangers build on": zero external users, three apps, no CI, a fresh install that crashes, and no community surface (public pitch, verified quickstart, demo, contribution path). PP-1..PP-7 already target most of the reliability half; the community half is unaddressed. |

### What is strong (keep doing)

- **Traceable requirements discipline** (URS + matrix) — rare even in funded teams; this is
  the backbone of the "predictable functionality" pitch.
- **The LLM security boundary** (single dispatch point, banned imports, guards, cost caps) —
  directly reusable as a marketing-grade differentiator vs. OpenClaw-class systems.
- **The persona regression suite** — budget-guarded, cache-keyed, LLM-judged behavioral
  regression testing. Genuinely novel; see SR-4.
- **Honest self-audit culture** — `app-sharing-vision.md` already has a "What PAS Does NOT
  Enforce" section; the audit reproduced its own first-boot crash. This honesty is itself a
  trust asset for open-sourcing.

### What gates the ambition (the four gaps)

1. **App isolation** — apps run in-process with full Node access; the install-time static
   analyzer stops accidents, not adversaries (SEC-4 already concluded this). The central
   pitch — *safe* app sharing — is not yet backed by the architecture. → **SR-1**
2. **Telegram hard-coupling** — the channel is welded into `CoreServices`, `MessageContext`,
   the router, and every app. Adopters will ask for Discord/Matrix/Signal/web first. → **SR-2**
3. **No publication cut** — nothing in the 28-phase sequence is "make a stranger succeed in
   30 minutes." Reliability fixes (PP-1..PP-7) are necessary but not sufficient. → **SR-3**
4. **The credibility wedge is buried** — the regression harness could stand alone and draw
   people to the main project. → **SR-4**

---

## Part 2 — Proposed Phases (summary)

These are **proposals**, deliberately not inserted into the open-items Phase Sequence — the
operator decides how they interleave with PP-1..PP-7 and the T-track. Suggested ordering
rationale is in "Sequencing" at the end of Part 3.

| Phase | Name | What it delivers | Detail | Status |
|---|---|---|---|---|
| **SR-1** | App isolation & shared-app trust model | A decided, documented, and enforced trust model for third-party apps: capability-scoped service injection (tier A), runtime import enforcement (tier B), process isolation decision (tier C). Expands the existing SEC-4 "container isolation" proposal. | [Part 3 §SR-1](#sr-1--app-isolation--shared-app-trust-model) | Proposed |
| **SR-2** | Channel abstraction seam | A `ChannelAdapter` interface + normalized message context so Telegram becomes the reference implementation rather than the substrate. No second channel built — just the seam. | [Part 3 §SR-2](#sr-2--channel-abstraction-seam) | Proposed |
| **SR-3** | Open-source publication cut | Everything between "PP phases done" and "public repo": history/secret audit, license, README pitch + verified quickstart, demo, SECURITY.md, contribution guide, CoreServices API stability statement, CI badge. | [Part 3 §SR-3](#sr-3--open-source-publication-cut) | Proposed |
| **SR-4** | Regression harness extraction | The persona regression core (case schema, budgets, oracles, cache, CLI) as a standalone package with an adapter interface; PAS cases stay in-repo as the first consumer. | [Part 3 §SR-4](#sr-4--regression-harness-extraction) | Proposed |

**Companion investigation:** the agentic-harness question ("should PAS have a
Hermes/OpenClaw-style light-harness mode?") is analyzed end-to-end in
`2026-07-07-agentic-harness-deep-dive.md` (same date, same provenance) — verdict:
graduated autonomy on the T-track substrate, recommendations AG-1..AG-8, with a
time-sensitive slice (AG-1 doctrine + AG-3 tool-schema metadata) that rides on T2a
planning. Tracked as the "AG" Proposals entry in `docs/open-items.md`.

---

## Part 3 — Detailed Designs

> Issue IDs: `ISO-*` (SR-1), `CHA-*` (SR-2), `PUB-*` (SR-3), `EXT-*` (SR-4).
> Each section: current state (code-grounded) → issues → recommendations → open questions.

---

### SR-1 — App isolation & shared-app trust model

**Relationship to existing work:** `docs/app-sharing-vision.md` (trust model, "What PAS Does
NOT Enforce", deferred signing/registry/container-isolation) and the SEC-4 re-scoped
"Container isolation" proposal in `docs/open-items.md` ("before `install-app` is publicized…
the static analyzer stops accidents, not adversaries. …do not invest in strengthening the
regex analyzer"). This section turns that one-line proposal into a design space.

#### Current state (code-grounded)

- Apps are ESM modules loaded **in-process** and handed a `CoreServices` object
  (`core/src/types/app-module.ts:120`). Service injection is manifest-filtered (undeclared
  services are `undefined`) — a good capability pattern, but advisory only: the app shares
  the process, so nothing stops it importing anything or reaching `globalThis`.
- Install-time enforcement is `static-analyzer.ts`: a regex scan for 7 banned module
  specifiers (LLM SDKs + `child_process`). It does **not** and **cannot** cover:
  `node:fs` (full filesystem, bypassing DataStore scoping entirely), `node:net`/`node:http`,
  the global `fetch` (needs no import at all), `process.env` (all secrets in the environment),
  or dynamic specifiers (`import('node:' + 'fs')`).
- `TelegramService` (`core/src/types/telegram.ts:150`) takes an arbitrary `userId` on every
  method — any installed app can message **any registered user**, not just the one it is
  serving. Same class of issue likely applies to other injected services (scheduler, eventBus,
  audio) — an inventory is part of this phase.
- DataStore scoping (`scoped-store.ts`, `paths.ts` traversal rejection) is real and good —
  but only for apps that *choose* to go through it.

#### Issues

- **ISO-1 (architectural):** The trust model is "installing an app = trusting it like an npm
  dependency," but the pitch is "share apps safely." These are currently the same thing with
  different marketing. Either the architecture must move toward the pitch, or the pitch must
  be softened to match the architecture — silently keeping both is the one wrong answer.
- **ISO-2:** Static analysis is the only technical gate and is trivially bypassable by an
  adversarial author (dynamic import, `fetch`, `process.env`). SEC-4 already accepted this;
  SEC-3's install-time warning is the current mitigation.
- **ISO-3:** Injected services are not scoped to the interaction. `telegram.send(anyUserId)`,
  cross-user messaging, no per-app rate limit on outbound sends (LLMGuard covers LLM only).
- **ISO-4:** Secrets: `SecretsService` mediates *declared* secrets, but `process.env` exposes
  everything (bot token, API keys) to any in-process app.
- **ISO-5:** No app-facing network policy. Manifests declare `external_apis` for secret
  injection, but nothing constrains where an app can actually connect.

#### Recommendations (three tiers — deliberately independent)

- **Tier A — capability scoping (cheap, high value, no isolation claim):**
  Narrow the injected service surfaces so the *declared* API matches least privilege:
  a reply-scoped messenger (bound to the triggering user/context) as the default, with
  `telegram:any-user` as an explicit manifest capability; per-app outbound send rate limits
  (mirror LLMGuard); an inventory pass over every `CoreServices` member asking "what can a
  hostile caller do with this?". This hardens honest apps and makes the manifest a truthful
  permission prompt — even though it is not a sandbox.
- **Tier B — runtime import enforcement (moderate):**
  Replace the regex analyzer's *enforcement* role (it stays as an install-time UX hint) with
  an ESM loader hook (`module.register()`) that resolves every import at runtime against the
  app's manifest capabilities — dynamic specifiers included. Combine with startup-time
  `process.env` scrubbing into a closure (secrets held by core, env cleared before app load).
  This defeats the *lazy* adversary and all accidents; a determined one can still escape
  (prototype pollution, `Function` constructor), and the docs must say so.
- **Tier C — process isolation (the real answer, big):**
  One worker/child process per app (or per trust tier), CoreServices as an RPC boundary,
  Node 22 permission model (`--permission`) constraining fs in the child. This is the SEC-4
  end-state. Decision needed on *when it gates what*: recommended stance — Tier C is required
  before a public registry ships (SR-3 can ship with Tiers A+B plus honest docs), because the
  registry is the moment PAS starts *recommending* third-party code.
- **Documentation (do first, costs a day):** Write `docs/APP_TRUST_MODEL.md` stating exactly
  what is and isn't enforced at each tier, promoted from `app-sharing-vision.md`'s honest
  section. Ship it in SR-3 regardless of how much of B/C has landed.

#### Open questions

1. Worker-thread vs. child-process for Tier C (worker: cheaper, shared memory risks;
   child: stronger, serialization cost for photo buffers).
2. Does Tier B's loader hook conflict with the single-process app-loading path in
   `bootstrap.ts`, and with tsx/dev-mode loading?
3. How do Tier A capability names interact with the T2a `capabilities.tools[]` manifest work?
   (Same manifest surface — should be co-designed, which argues for SR-1 design *before* T2a.)

---

### SR-2 — Channel abstraction seam

#### Current state (code-grounded)

- `CoreServices.telegram: TelegramService` — the channel is a first-class named dependency of
  every app (`app-module.ts:122`).
- `MessageContext` (`core/src/types/telegram.ts:81`) carries Telegram-native `chatId: number`
  and `messageId: number`; `sessionKey` is already documented as "user+channel combination",
  so the concept of multiple channels exists in the data model but nowhere else.
- Telegram semantics are load-bearing deep in core: `BufferingTelegramProxy` flush rules
  keyed to `sendPhoto`/`sendWithButtons`/`sendOptions`, the 4000-char auto-split, Markdown
  escaping conventions, inline-keyboard callback routing (`app:<appId>:` prefixes).

#### Issues

- **CHA-1:** Every app's public API surface (`handleMessage(ctx)`, `handleCallbackQuery`)
  names Telegram types. A Discord/Matrix/web-chat contributor today must fork core, not add
  an adapter — the single most likely first ask from adopters is architecturally expensive.
- **CHA-2:** Rich-message capabilities (buttons, options, photo, edit) are Telegram-shaped.
  Other channels have different capability sets (no inline keyboards on SMS; threads on
  Discord); nothing expresses capability negotiation.
- **CHA-3:** The 4000-char split and Markdown dialect are Telegram constants baked into shared
  send paths — wrong for every other channel.
- **CHA-4 (timing):** T5 (per-app intent→tool migration, open-items #12–17) will touch every
  app's handler signatures anyway. Introducing the channel seam *after* T5 means touching all
  apps twice.

#### Recommendations

- **Build the seam, not a second channel.** Deliverables: a `ChannelAdapter` interface
  (send/sendRich/edit + a capability descriptor: `supportsButtons`, `maxMessageLength`,
  `markup: 'telegram-md' | 'plain' | …`), a channel-neutral `InboundMessage` context with a
  `channel: { id, native }` escape hatch, and `TelegramChannelAdapter` as the only
  implementation — behavior byte-identical, verified by the existing test suite.
- **Keep `MessageContext` as a compatibility alias** during migration; apps migrate
  per-app (natural to fold into each T5.x slice, which already touches every app).
- **Move the constants** (4000-char split, Markdown escaping) behind the adapter's capability
  descriptor so `BufferingTelegramProxy` becomes a channel-generic buffering proxy with a
  Telegram policy object.
- **Explicit non-goals:** no second channel implementation, no GUI-chat channel, no change to
  GUI auth's use of Telegram user ids (that is an identity question, not a channel question —
  note it as a future item, don't solve it here).

#### Open questions

1. Sequencing vs. the T-track: recommended — land the interface before T5.notes (#12) so each
   T5 slice migrates its app once; alternatively fold into T6b cleanup (#19) if T5 starts first.
2. Does `sendOptions`' promise-returning "wait for user tap" pattern generalize, or does the
   adapter need an async-interaction capability flag?

---

### SR-3 — Open-source publication cut

**Relationship to existing work:** PP-1..PP-7 (audit remediation) cover reliability
(INST-1 first-boot crash, SEC-1..5, DEP-1/2 vulns + CI, BKP-1 backups). SR-3 is everything
*after* those that stands between a clean private repo and a public one a stranger succeeds
with. DOC-1..10 (app-developer docs / open-source readiness findings) partially overlap —
SR-3 planning should absorb their unimplemented remainder rather than duplicate them.

#### Issues

- **PUB-1 (blocking):** Repo history has never been audited for publication: secrets ever
  committed, personal data (real household/food/health data in fixtures or docs? the audit
  found a "Raleigh, NC" default), private URLs. Publishing makes history permanent.
- **PUB-2 (blocking):** No license. This decision shapes everything (app ecosystem licensing
  too — can shared apps be proprietary?).
- **PUB-3:** No public-facing README pitch, no verified-by-a-stranger quickstart, no demo
  GIF/video. First impressions are one-shot for infrastructure projects.
- **PUB-4:** No SECURITY.md / disclosure policy — ironic for a security-minded pitch, and
  cheap to fix.
- **PUB-5:** No CoreServices API stability statement. App authors need to know what's frozen;
  `app-sharing-vision.md` has an API-versioning section that was never promoted to a public
  contract. (Interacts with SR-1 Tier A, which *changes* service surfaces — do the freeze
  after Tier A.)
- **PUB-6:** No contribution path: CONTRIBUTING.md, issue templates, "good first app" guide.
  `docs/CREATING_AN_APP.md` exists and is the seed.
- **PUB-7:** Internal docs hygiene: `docs/superpowers/plans/*` contains operator-personal
  context and internal codenames ("Hermes" must not appear as a product name publicly, per
  existing convention). Decide: publish, prune, or `.gitignore`-and-split.
- **PUB-8:** CI is a *publication* requirement, not just a reliability one (badge + PR gate
  for external contributors). DEP-2 covers creating it; SR-3 requires it green and public.

#### Recommendations

- Treat SR-3 as a **checklist phase** gated on PP-1..PP-7: history audit (`gitleaks` +
  manual fixture review; if history is dirty, decide squash-republish vs. rewrite), license
  decision, README + quickstart *verified on a machine that has never run PAS* (the
  gui-verify-harness pattern, applied to install), SECURITY.md, CONTRIBUTING.md, API stability
  doc, demo recording, `docs/APP_TRUST_MODEL.md` from SR-1.
- **The quickstart is the product.** Recommend the INST-1 fix be verified by a scripted
  fresh-install test that CI runs — turning "stranger succeeds in 30 minutes" into a
  regression-tested property rather than a hope.
- Keep the two audiences separate in docs: *operators* (run a household) vs. *app developers*
  (build on CoreServices). The repo currently interleaves them.

#### Open questions

1. License (operator decision; affects app-ecosystem economics).
2. Publish strategy for history: keep full history (authentic, risky) vs. squash-republish
   (clean, loses provenance).
3. Is the public artifact this repo, or a split (core public, operator data/plans private)?

---

### SR-4 — Regression harness extraction

#### Current state (code-grounded)

- `regression/` is a separate pnpm workspace: PersonaCase schema + validator, budget guards
  (CaseBudget/RunBudget with hard-abort), git-blob + tier-snapshot cache keys, structural +
  multiset + rubric oracles, CostTracker token-delta metering, CLI
  (`--bucket --dry-run --rerun --json --list --model-matrix --judge-model`), admin GUI page.
- Coupling to PAS: buckets are hard-wired to production classifiers (`routing`, `receipt`,
  `chatbot`, `recall`); env factories build PAS `CoreServices` mocks; cache salt derives from
  PAS config tiers. The "generic per-app test discovery" proposal in `docs/open-items.md`
  already identifies the missing abstraction from the *inside* (apps registering cases);
  SR-4 is the same abstraction viewed from the *outside* (other projects registering cases).

#### Issues

- **EXT-1:** The valuable core (budgeted, cached, model-swappable, LLM-judged behavioral
  regression) is not separable today from the PAS-specific runners — no seam exists.
- **EXT-2:** Cache keys embed PAS notions (config tier snapshots) that a standalone consumer
  wouldn't have.
- **EXT-3:** No standalone story: name, package boundary, docs, example consumer.

#### Recommendations

- **Design one seam, serve both consumers.** A `CaseRunner` adapter interface (given a loaded
  case + model handle, produce an output for oracles) + a `CacheKeyContributor` interface
  (consumers add their own salt inputs, PAS contributes tier snapshots). This is the same
  work the "generic per-app test discovery" proposal needs — do it once.
- **Extract as a package, not a repo, first.** Move the core into a workspace package with
  zero `@core/*` imports (enforced the same way the LLM boundary is); PAS buckets become the
  first adapter. Only split to its own repo when an external consumer exists.
- **Positioning:** this is the credibility wedge — "the test harness that catches model-swap
  regressions in conversational apps" is a blog-post-sized story that draws attention to PAS.
  Low urgency, high optionality; do not schedule before SR-3.

#### Open questions

1. Does the rubric oracle's judge-model handling (transient override machinery) extract
   cleanly, or is it entangled with PAS ModelSelector?
2. Naming/branding (matters only at repo-split time).

---

## Sequencing (recommendation, not a decision)

1. **SR-1 design decision first** (even if only Tier A + the trust-model doc ship soon):
   it shapes the T2a manifest surface and the SR-3 public API freeze. Cheap to decide, costly
   to retrofit.
2. **SR-2 interface before T5.notes** (open-items #12) so each T5 app slice migrates once.
3. **SR-3 after PP-1..PP-7**, absorbing DOC-1..10 remainder; requires SR-1's trust-model doc.
4. **SR-4 anytime after SR-3**, opportunistically co-scheduled with the existing
   "generic per-app test discovery" proposal since they share the seam.

Proposed URS areas (assigned at each phase's planning pass, not now): `REQ-ISO-*`,
`REQ-CHANNEL-*`, `REQ-PUB-*`, `REQ-HARNESS-*`.

---

## Tracking

**Update 2026-07-07 (same day): all four phases confirmed by the operator**, together with
the companion deep-dive's AG recommendations. Current tracking state:

- SR-1..SR-4 + AG: `docs/open-items.md` → **Confirmed Phases** (moved from Proposals);
  insertion points noted after the Phase Sequence table (SR-1 before #6, SR-2 before #12,
  AG-2 after #9, SR-3 after PP-1..PP-7, SR-4 after SR-3).
- Planned-phase prose: `docs/implementation-phases.md` → "Planned Phases — Strategic Review
  & Agentic Autonomy (2026-07-07)".
- AG-1 shipped: `docs/agentic-autonomy-doctrine.md` (includes the AG-8 standing decision).
- SR-1 supersedes/expands the "Container isolation" line (stays, cross-referenced).
- Per project convention, each confirmed phase still gets a planning pass with
  `superpowers:writing-plans` + Codex review before implementation.
