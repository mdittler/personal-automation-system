# SR-1 — App Isolation & Shared-App Trust Model — Design

**Date:** 2026-07-07
**Status:** Proposed (design pass — the hard gate before T2a; no code in this phase).
Fable-authored + Codex-reviewed (high effort) + Fable-revised 2026-07-07. The Codex review
found 1 Critical (per-tier child pooling isn't app isolation — reworked to per-app principal)
+ 4 Major (tsx-production Tier B reality; the `process.exit()`-in-worker correction; the
requirements.services↔capabilities dual-surface → normative validator; `parameters` required)
+ 1 Minor, all resolved. **Design/schema only — implementation is a future PAS phase.**
**Author:** Fable 5 (strategic-design pass)
**Source analyses:** `docs/superpowers/plans/2026-07-07-fable-strategic-review.md` §SR-1
(issues `ISO-1..ISO-5`, open questions) and
`docs/superpowers/plans/2026-07-07-agentic-harness-deep-dive.md` (AG-3 tool metadata).
**Companion schema proposal:** `docs/superpowers/specs/app-manifest.capabilities.schema.json`.

> **Epistemic markers.** Every claim below is tagged. **[grounded]** = read directly
> from the current code/manifests/schema (file path cited). **[inference]** = a design
> conclusion drawn from grounded facts; not yet verified against a running build.
> **[decision]** = an opinionated call this design makes for the implementing phases to
> accept, amend, or reject. Nothing here is wired into production; the schema is a
> **proposal**, not the live `core/src/schemas/app-manifest.schema.json`.

---

## 1. Problem and the gate this unblocks

PAS's public pitch is "**share apps safely**." Today that is marketing, not architecture
**[grounded — strategic review §SR-1 ISO-1]**:

- Apps are ESM modules loaded **in-process** and handed a `CoreServices` object
  (`core/src/types/app-module.ts:120`, imported at `core/src/services/app-registry/loader.ts:200`
  via `await import(moduleUrl)`). Service injection is manifest-filtered — undeclared
  services come through as `undefined` (`core/src/compose-runtime.ts:819-892`, e.g.
  `telegram: declaredServices.has('telegram') ? contextAwareTelegram : undefined`) — a
  genuine capability pattern, but **advisory only**: the app shares the process, so nothing
  stops it importing `node:fs`, reaching `globalThis`, or reading `process.env`.
- The only install-time technical gate is `static-analyzer.ts`
  (`core/src/services/app-installer/static-analyzer.ts`): a regex scan for **7 banned
  specifiers** (5 LLM SDKs + `child_process` + `node:child_process`). By its own author's
  admission and SEC-4's conclusion it "stops accidents, not adversaries" — it cannot see
  `node:fs`, `node:net`/`node:http`, the global `fetch` (no import needed), `process.env`,
  or a dynamic specifier (`import('node:' + 'fs')`) **[grounded]**.
- `TelegramService` (`core/src/types/telegram.ts:150`) takes an arbitrary `userId` on
  every method (`send(userId, message)`, `sendPhoto`, `sendOptions`, `sendWithButtons`) —
  **any installed app can message any registered user**, not just the one it is serving
  **[grounded, ISO-3]**.

**The gate.** SR-1's design pass is a **hard gate before T2a** (open-items Master Execution
Order gate #1): *"Tier A capability names, T2a `capabilities.tools[]`, and the AG-3 metadata
share one manifest surface — built once or built twice."* T2a (phase #6) introduces
`types/tool.ts`, `manifest.capabilities.tools[]`, the ToolRegistry/ToolPolicy, and
install/load validation; AG-3 rides inside T2a, adding per-tool risk metadata
(`riskClass`, `agentAllowed`, confirmation, cost hint). If SR-1 does not first decide the
**shape of the capability surface**, T2a and AG-3 will each invent their own and the two
will drift. This document exists to make that decision once.

**Scope of this pass.** Design + schema proposal only. No TypeScript, no edits to the live
manifest schema or any app manifest, no worktree. The three enforcement tiers (A/B/C) are
sequenced across later phases; this pass fixes the **manifest vocabulary and the trust
model** so those phases build against a stable contract, and it makes the **worker-vs-child
and loader-hook×tsx** calls the strategic review left open.

---

## 2. The tier capability model (Tier A vocabulary)

**[decision]** Apps declare capabilities as an **explicit, enumerated, additive**
vocabulary in the manifest. A capability is a *named permission the operator sees at
install time and the runtime can enforce*. The design principle is **least privilege with
a truthful prompt**: the default injected surface is the narrowest useful one, and every
widening is a named capability the manifest must request.

### 2.1 Capability namespace

Capabilities are dotted `namespace:qualifier` strings, grouped by the CoreServices member
or resource they widen. **[decision]** The Tier A launch set — grounded in the injected
services that exist today (`core/src/compose-runtime.ts:819-892`) and the concrete ISO-3/
ISO-4/ISO-5 gaps:

| Capability | Widens / grants | Default without it | Grounded in |
|---|---|---|---|
| *(reply-scoped messaging)* | Reply-scoped messenger bound to the triggering user/context | **The implicit baseline — NOT a declared capability.** Any app injected the messenger (i.e. declaring `telegram` in `requirements.services[]`) can reply to the triggering user. There is no `messaging:reply` token to declare. | ISO-3; `contextAwareTelegram` already wraps sends |
| `messaging:any-user` | `telegram.send(anyUserId)` to arbitrary registered users | Sends restricted to the interaction's user | ISO-3; `telegram.ts:150` arbitrary `userId` |
| `messaging:proactive` | Send outside a live interaction (cron/event-driven) | No unsolicited sends | ISO-3; schedules + `app-outbound-bridge` |
| `data:user` | Read/write the app's own per-user scope | No filesystem/data access | `data-store` service, `scoped-store.ts` |
| `data:shared` | Read/write the app's shared-space scope | No shared access | `DataStore.forSpace` |
| `net:fetch` | Outbound HTTP to declared hosts only (see `net.allow[]`) | No network egress (Tier B/C enforced) | ISO-5 "no network policy" |
| `secrets:<id>` | Access one declared external-API secret by id | No secret access; `process.env` scrubbed | ISO-4; `SecretsService`, `external_apis[]` |
| `schedule:register` | Register cron/one-off jobs | No scheduler access | `scheduler` service |
| `events:emit` / `events:subscribe` | Inter-app pub/sub | No event bus access | `event-bus` service |
| `audio:play` | TTS / speaker cast | No audio | `audio` service |

**[decision] The relationship to `requirements.services[]` is NORMATIVE, not "layer and
migrate later."** The existing enum (`app-manifest.schema.json:160-183`) is what *actually*
gates service injection today — `composeRuntime` reads only `requirements.services`
(`compose-runtime.ts:753` builds `declaredServices`; `:825`
`telegram: declaredServices.has('telegram') ? … : undefined`). If the capability vocabulary
were merely "layered over" the enum, a manifest could drift into an inconsistent state —
`messaging:any-user` declared with no `telegram` service (a capability that can never fire),
or `telegram` injected with no messaging capability at all (a service with no declared
purpose). The Codex review flagged this as the exact dual-permission-surface trap SR-1
exists to avoid, and it is right.

Two acceptable resolutions; this design **requires one of them at T2a, not later**:

- **(preferred) Migrate injection onto the capability vocabulary.** `composeRuntime`'s
  service factory keys off `capabilities.declared[]` (plus tool `requiresCapabilities[]`),
  and `requirements.services[]` becomes a derived/deprecated compatibility view. Single
  surface, no drift possible.
- **(minimum) A mandatory, NORMATIVE services↔capabilities consistency validator** at both
  install and load, with a **published mapping table** (this section is that table's
  authority). The validator **fails the manifest** when: a messaging/data/net/etc.
  capability is declared without its backing service, or a privileged service is injected
  with no declared capability describing its use. The mapping is part of the contract, not
  an implementation detail left to the loader.

Either way the two surfaces are kept provably consistent from T2a onward. The migration of
existing manifests (an app declaring `telegram` today gains reply-scoped messaging with **no
new token**; `messaging:any-user` is an explicit, reviewed addition) is detailed in §8 Q6.
**[grounded — `compose-runtime.ts:753,825`; `app-manifest.schema.json:160-183`]**

### 2.2 Tier boundaries (what enforces each capability)

The three tiers from the strategic review are **enforcement mechanisms for the same
vocabulary**, not three different vocabularies. This is the crux of "built once":

- **Tier A — capability scoping (declaration + injection-time narrowing).** The manifest
  declares capabilities; `composeRuntime`'s service factory injects a **reply-scoped**
  messenger by default and only widens to `messaging:any-user` when declared; per-app
  outbound send rate limits mirror LLMGuard. Honest apps are constrained; the manifest
  becomes a truthful permission prompt. **No isolation claim.** This is where the
  capability *names* live and it is the layer T2a/AG-3 build directly on.
- **Tier B — runtime import enforcement.** An ESM loader hook resolves every import
  (dynamic included) against the same declared capabilities; `process.env` is scrubbed
  into a core-held closure before app load. The regex analyzer is demoted to an install
  UX hint. Defeats the *lazy* adversary and all accidents. Still not a sandbox.
- **Tier C — process isolation.** One worker/child per app (or trust tier); CoreServices
  becomes an RPC boundary; the child runs under Node 22's permission model. The only real
  answer, and the gate before a public app registry. §4 makes the worker-vs-child call.

The capability vocabulary in §2.1 is identical at all three tiers. Tier A checks it at
injection; Tier B checks it at import; Tier C checks it at the RPC boundary. **[decision]**
An app that runs correctly under Tier A must run byte-identically under Tier C with no
manifest change — the manifest is the single contract, the tier is an operator/runtime
choice about how hard to enforce it.

---

## 3. The single manifest surface (the crux)

**[decision]** `capabilities.tools[]` (consumed by T2a's ToolRegistry) and AG-3's per-tool
risk metadata are **one array of one object shape**, not two parallel structures. There is
exactly one place a tool is described, and every consumer reads fields off that one object.

### 3.1 Why one surface

The failure mode the gate warns about is two arrays that must be kept in sync — e.g. a
`tools[]` for registration and a `tool_risk[]` (or a separate `agent.tools[]`) for agent
metadata, joined by tool name. That join is a standing drift bug: a tool added to one and
not the other is silently mis-registered or mis-classified, and "retrofitting risk classes
onto dozens of shipped tools later is the expensive path" (AG-3). **[inference]** A single
object per tool with the risk fields as **required-at-authoring, defaulted-at-read**
members removes the join entirely.

### 3.2 The unified `ToolDef` object

Each entry of `capabilities.tools[]` is one object (full JSON Schema in the companion
proposal). Field groups:

- **Identity & invocation (T2a / ToolRegistry):** `name` (namespaced `app:verb`),
  `description` (the model-facing spec), `parameters` (JSON Schema for arguments —
  **required**; a no-argument tool declares the empty object schema explicitly, since both
  the ToolRegistry and the confirmation gate's argument rendering need a schema-shaped
  arg spec), `handler` (file path relative to app root, mirroring `schedule.handler`).
- **Capability binding (Tier A/B/C):** `requiresCapabilities[]` — the subset of §2.1
  capabilities this tool exercises. This is the link between a tool and the trust model:
  ToolPolicy refuses to register a tool whose `requiresCapabilities` are not all declared
  at the manifest's app level, and the runtime tiers enforce the same set when the tool
  runs. **[decision]** A tool cannot silently exceed its app's declared capabilities.
- **Agent metadata (AG-3), co-located, not a second array:**
  - `riskClass`: `read` | `write` | `external-effect` — the three-value ladder from the
    doctrine (`docs/agentic-autonomy-doctrine.md` item 4) and AG-3.
  - `agentAllowed`: boolean — may a bounded agent session (AG-2) call this tool at all.
  - `requiresConfirmation`: boolean — must the confirmation gate render *arguments* before
    execution (doctrine item 4; AG-2 renders arguments, not just the name). **[decision]**
    Default derives from `riskClass`: `write` and `external-effect` default `true`, `read`
    defaults `false` — but the field is explicit so an author can force-confirm a
    sensitive read. Config (`agent.require_confirmation`) can tighten but never loosen a
    manifest `true` (doctrine: per-tool override only via manifest, not user config).
  - `costHint`: optional enum (`none` | `low` | `high`) — surfaced in the agent's escalation
    "estimated budget" offer; advisory, never an enforcement input.

### 3.3 How both consumers read the one surface

```
                    manifest.capabilities.tools[]  (one array, one object shape)
                                   |
     ┌─────────────────────────────┼──────────────────────────────┐
     ▼                             ▼                              ▼
 T2a ToolRegistry           AG-3 / AG-2 agent            SR-1 trust tiers
 reads: name, description,  policy reads: riskClass,      read: requiresCapabilities[]
   parameters, handler        agentAllowed,                (Tier A inject-check,
 builds callable tools        requiresConfirmation,         Tier B import-check,
 ToolPolicy gates on          costHint                      Tier C RPC-boundary check)
   requiresCapabilities[]    filters the same registry
```

- **T2a (structured tool calls)** iterates `tools[]`, builds the ToolRegistry from
  identity+invocation fields, and calls ToolPolicy — which validates
  `requiresCapabilities[]` against the app's declared capabilities at **install** and
  **load**. It ignores the agent fields.
- **AG-2/AG-3 (agent sessions, later)** take the *same* ToolRegistry and filter it by
  `agentAllowed` + `riskClass` + ToolPolicy, and drive confirmation from
  `requiresConfirmation`. No new manifest read; the fields were carried unused since T2a.
- **SR-1 trust tiers** read only `requiresCapabilities[]` — the same set at inject-time
  (A), import-time (B), and RPC-boundary time (C).

**[decision]** Because AG-3's fields ship in the schema at T2a but are only *consumed* once
agent mode lands, they are **required in the schema, defaulted on read**: authoring a tool
forces a `riskClass` choice (no accidental unclassified tools — that is the "expensive
retrofit" AG-3 warns of), while `agentAllowed`/`requiresConfirmation`/`costHint` have safe
defaults (`agentAllowed: false`, confirmation derived from `riskClass`, `costHint: low`)
so a pre-agent app author need not reason about agent semantics. **Safe default = a tool
is not agent-callable until deliberately opted in.**

---

## 4. Tier C isolation mechanism — worker thread vs. child process

### 4.1 The isolation principal (decided first — it drives everything below)

**[decision]** The isolation **principal is one app.** The default Tier C topology is
**one child process per non-core app** — not one child per trust tier. This corrects a
real error in the first draft of this section, which proposed pooling all `reviewed` apps
into a single shared child; a Codex review (high effort, 2026-07-07) flagged it as the
Critical finding and it is correct:

- **Pooling apps into one process is not app isolation.** Apps in the same child share a
  process, `globalThis`, the module cache, in-child state, and each other's crashes. That
  isolates the *tier from core* but leaves every app in the tier able to read the others'
  secrets, reach their data handles, and take them all down together. Since each app has
  **distinct secrets (`secrets:<id>`) and distinct data scopes**, they are **distinct
  security principals** and must not share a process. The first draft also contradicted
  itself — §4 said "reviewed in a shared child" while §8 said "community each in its own
  child." The honest resolution is per-app for every non-core app.
- **The only legitimate pooling** is co-locating apps that are *mutually trusted as a single
  security principal* — i.e. they share no distinct secrets or data and a compromise of one
  is already a compromise of the other (e.g. a suite of first-party apps by the same
  author, or the `built-in` set which is already core-trust). Pooling is an **optimization
  applied behind proven per-app isolation**, never the design default, and it is only ever
  applied to apps explicitly declared to share a principal.

So the topology is: **`built-in` apps run in-core** (they are core-trust already);
**every other app gets its own child** by default; **a co-location group** may share a
child only when the operator/registry has declared the group a single principal. The
`built-in`/`reviewed`/`community` trust levels from `app-sharing-vision.md` (lines 149-156)
**[grounded]** classify *how much scrutiny an app got*, not *how many share a process* —
those are orthogonal, and conflating them was the draft's mistake.

### 4.2 Worker thread vs. child process, for the per-app principal

**[decision] Child process (`fork`/`spawn`), one per app**, with worker threads rejected as
the isolation mechanism. Reasoning across the axes the strategic review named (§SR-1 open
question 1), with the technical claims corrected per the Codex review:

| Axis | Worker thread (`worker_threads`) | Child process | Call |
|---|---|---|---|
| **`process.env` exposure** | A worker gets its own `process.env` *copy*, but shares the V8 isolate group and can be handed/inherit host env unless every read path is scrubbed — env separation is a discipline, not a structural guarantee. | **Separate OS process → separate environment block.** The child is `fork`ed with an explicitly constructed `env` (only its declared `secrets:<id>` values), so the bot token and other apps' secrets are *structurally* absent. | **Child.** The deciding axis (ISO-4): env scrubbing is a *guarantee* with a child. |
| **Crash isolation** | A **native crash** (segfault in a bad native dep, OOM) can still take the **whole host process** down — workers do not contain native faults. *(Correction: `process.exit()` inside a worker exits only the worker, not the parent — the first draft's claim that it downs the whole process was wrong. Native crashes remain the real risk, and they favor the child.)* | A crashing child (native fault included) is reaped by the OS; core logs it and keeps serving other apps — matches CLAUDE.md "App failures caught and logged — never crash the system." | **Child.** Native-crash containment is the durable argument. |
| **Filesystem confinement** | The Node permission model is **process-scoped**; a worker cannot be given stricter fs permissions than its host process. | A child can be spawned with Node's `--permission --allow-fs-read=<appScope>` as **defense-in-depth**, narrowing fs reach toward the app's data scope. | **Child** — but see the caveat below: this is *additional confinement*, not the sandbox. |
| **Startup cost** | ~1–5 ms. | ~30–80 ms cold; a **persistent per-app process** amortizes this to near-zero at steady state. | **Worker is cheaper**, but per-app children are long-lived, so startup is paid once per app, not per request. Process/RAM count scales with installed-app count (the 32 GB Mac Mini target tolerates the low tens of apps; a large registry install base is an open scaling question — §8 Q3). |
| **IPC surface** | Shared `ArrayBuffer`/`MessagePort` — zero-copy for photo buffers, but shared memory is an isolation *risk*, not a feature. | Structured-clone / serialized messages; large `Buffer`s (photos) pay a copy cost. | **Worker is faster on photos**, but the copy cost is removed by keeping binaries core-side (below), so it does not decide. |

**On Node's `--permission`: it is defense-in-depth, not a security sandbox against
malicious code.** Node's own documentation states the permission model is not intended as a
hardened boundary against adversarial in-process code. **[decision]** Therefore a public
app registry (the moment PAS *recommends* third-party code) needs a **real OS-level sandbox
around the per-app child — an OS container / seccomp-bpf / VM-class boundary**, with
`--permission` layered inside it as an extra constraint, **not** `--permission` used *as*
the sandbox. This is a materially larger commitment than the first draft implied and it
sharpens why Tier C gates the registry rather than shipping with A+B. **[open question]**
the exact OS-sandbox technology (container runtime vs. `sandbox-exec`/seccomp vs. a
micro-VM) is deferred to the Tier C implementing phase (§8 Q8) — this design fixes the
*principal* (per-app) and the *mechanism class* (OS-sandboxed child process), not the
vendor.

**The serialization tax is real and bounded.** The one place child IPC bites is photo
transfer (`sendPhoto(userId, photo: Buffer)`). **[decision]** Keep large binary payloads
**core-side**: an app in a child returns a *reference/handle* (the AttachmentStore id T2b
introduces) rather than the raw buffer across the boundary, so photo bytes never cross IPC.
This turns the worst-case copy into a small-message pass — removing the one remaining
argument for workers.

**Consequence for CoreServices:** Tier C requires CoreServices to be expressible as an
**RPC boundary** — every method an async message round-trip, per app. This is a large
interface commitment and is why Tier C gates the public registry rather than shipping with
Tiers A+B. Designing the capability surface (§2–3) so it is *already* the enforcement point
at all three tiers is what lets Tier C land later without re-opening the manifest contract.

---

## 5. ESM loader-hook × tsx dev-mode interaction (the sharp edge)

**[grounded]** PAS loads apps two ways depending on mode:

- **Dev:** `pnpm dev` = `tsx watch core/src/bootstrap.ts` (`package.json:14`). Every
  script entry runs under `tsx` (`install-app`, `scaffold-app`, `test:regression`, etc.).
  `tsx` installs **its own ESM loader hooks** (via `module.register`) to transpile `.ts`
  on the fly.
- **Built:** the app loader prefers a compiled `.js`/`.mjs` runtime entry
  (`getModuleCandidates` → `isSafeRuntimeEntry`, `loader.ts:44-90`) and only falls back to
  `.ts` for dev (`loader.ts:187` doc comment: "Prefers safe compiled runtime entries, then
  falls back to .ts for dev mode"). Import is a plain
  `await import(pathToFileURL(modulePath).href)` (`loader.ts:198-200`).

**The sharp edge [inference]:** Tier B's enforcement is *also* a `module.register()` ESM
loader hook. Node runs registered hooks as a **chain**, and the chain composes by
registration order. Under `tsx`, the app source arriving at PAS's capability-enforcement
hook has **already been transformed by tsx's hook** — the specifier PAS sees in a
`resolve` hook is the original specifier (good — dynamic `import('node:'+'fs')` is resolved
by our hook regardless of tsx), but the *timing and ordering* of registration matters:
if PAS registers its enforcement hook **before** `tsx` (or in a build where `tsx` is
absent), behavior differs. Concretely:

1. **Built JS output (no tsx):** PAS's enforcement hook is the only custom hook. Clean
   case; every app import — static or dynamic — passes through `resolve` and is checked
   against `requiresCapabilities` / the capability→module map. **This is the runtime where
   Tier B can be claimed as fail-closed enforcement.**
2. **tsx runtime (dev *and* current native production):** two hook chains coexist.
   **[decision — corrected]** The first draft called tsx "dev only / trusted-author" and
   deferred fail-closed enforcement to built output. That is **wrong for PAS's current
   reality**: `pnpm dev` = `tsx watch` (`package.json:14`) **is** the live non-Docker
   deployment runtime — DEP-5 documents exactly this ("the dev/prod dependency boundary is
   blurred while tsx is the production runtime",
   `docs/superpowers/plans/2026-06-11-ux-review-findings-and-fix-plan.md:744`)
   **[grounded]**. So "fail-closed only on built output" would leave the **actual live
   native deployment in advisory/warn mode** — a silent Tier-B downgrade the operator did
   not choose. The honest posture, stated explicitly in the trust doc:
   - **Docker / built-JS deployment → Tier B is fail-closed** and may be claimed.
   - **Current tsx native deployment → Tier A + advisory Tier B only**; the loader hook
     runs in warn-mode because it cannot claim fail-closed enforcement while composed under
     tsx's own hook chain.
   - **Tier B as a native production guarantee is therefore gated on first resolving the
     native production runtime** (build-and-run compiled JS, or a supported non-tsx native
     path) — that runtime decision is a prerequisite of Tier B's native enforcement, not an
     afterthought. Until it is made, the native deployment's real tier is A. This is
     tracked as an open question (§8 Q4) and is the kind of environment-coupling that
     produced the Code-Orchestrator tsx/dev sharp edges — naming it is the point.
3. **The `import()` entry itself:** the app's top-level module is loaded by
   `await import(moduleUrl)` in-process (`loader.ts:200`). A loader hook intercepts the
   app's *own* imports but the entry import runs in the host realm. Under Tier C this moves
   into the child; under Tier B-only it stays in-process and the hook is the boundary.
   **[open question]** whether Tier B alone can meaningfully gate the entry module's
   first-line side effects before the hook is consulted (§8 Q4).

**[decision]** The loader hook resolves against a **capability→allowed-modules map**
derived from declared capabilities, not against a raw allowlist in the manifest: e.g.
`net:fetch` permits `node:https`/global `fetch` to declared hosts; absence of `data:user`
denies `node:fs`. This keeps the manifest in capability vocabulary (§2.1) and puts the
"which modules does this capability imply" table in core, versioned with core — apps never
name Node builtins directly.

---

## 6. `process.env` scrubbing boundary

**[grounded]** `process.env` is read across core (`bootstrap.ts`, `compose-runtime.ts`,
`provider-factory.ts`, `config/index.ts`, `secrets/index.ts`, GUI auth, …). Secrets are
mediated for *declared* external APIs (`compose-runtime.ts:807-817`: reads
`process.env[api.env_var]` for each declared `external_apis[]`, builds a
`SecretsServiceImpl` map) — but the raw `process.env` remains fully visible to any
in-process app **[grounded, ISO-4]**.

**[decision] The scrubbing boundary:**

- **Core captures every needed env var into closures/config at bootstrap, before any app
  loads.** `SecretsService` already demonstrates the pattern (env → in-memory map). Extend
  it: core reads all of `process.env` it needs (bot token, API keys, ports, data dir,
  timezone) into typed config objects during `composeRuntime`, then — **before the app
  registry's `loadAll` / first `import(app)`** — replaces or empties `process.env` so an
  app observes an **empty-or-allowlisted** environment.
- **A sandboxed app may see:** *nothing by default.* A declared `secrets:<id>` capability
  grants that one secret **through `SecretsService`**, never through `process.env`. Non-
  secret operational values an app legitimately needs (`dataDir`, `timezone`) are already
  passed explicitly on `CoreServices` (`app-module.ts:163-166`) — so the app has no reason
  to read `process.env` at all.
- **A sandboxed app may NOT see:** the Telegram bot token, any LLM provider API key, any
  other app's declared secret, GUI auth secrets, or arbitrary host env.
- **Tier interaction:** under **Tier B** the scrub is a soft boundary — a determined app
  could stash a reference to the original `process.env` before core clears it, so the
  scrub is combined with the loader hook and documented as "defeats accidents and the lazy
  adversary." Under **Tier C** the scrub is a **hard boundary** — the child process is
  spawned with an explicitly constructed `env` containing only what its declared
  `secrets:<id>` grant, so the parent's environment block never exists in the child.
  **[decision]** The scrub is *implemented at Tier B* and *guaranteed at Tier C*; the trust
  doc must state which guarantee each tier gives.

---

## 7. Trust model — what is trusted vs. hostile, and where validation lives

**[decision]** The boundary is: **the manifest is semi-trusted metadata; the app's code and
its runtime messages are hostile; core is the trusted enforcer.** Concretely:

| Artifact | Trust | Where it is validated |
|---|---|---|
| **Manifest contents** | **Semi-trusted.** Author-supplied and could over-declare (asking for `messaging:any-user` it doesn't need) or lie about intent. Validated for **structure and internal consistency**, not honesty. | Install + load: JSON-Schema validation (`validateManifest`, `loader.ts:158`); ToolPolicy checks each tool's `requiresCapabilities ⊆ app capabilities`; capability names are a closed enum. Over-declaration surfaces to the operator as the permission prompt — the human is the honesty check. |
| **App code** | **Hostile.** The core assumption. Static analysis (regex) is an **install-time UX hint only** post-SR-1, never a security gate (SEC-4). | Tier B loader hook (import enforcement) at runtime; Tier C per-app OS-sandboxed child process, with Node `--permission` as *defense-in-depth inside* the sandbox (not the sandbox itself). Code is never trusted to self-limit. |
| **IPC / RPC messages (Tier C)** | **Hostile.** A compromised child can send malformed or malicious RPC frames. | The **core side of the RPC boundary** validates every inbound message: shape (schema), that the requested operation is within the app's declared capabilities, and that arguments (e.g. a `userId` on a `messaging:any-user` send) are well-formed. Validation lives in core, never in the child. |
| **Tool arguments (agent path)** | **Hostile** (model-generated or app-supplied). | ToolPolicy + confirmation gate render arguments to the user for `requiresConfirmation` tools; the parameters JSON Schema validates shape before dispatch. |
| **`process.env`** | N/A — structurally removed from the app's view (§6). | Core scrubs before load (Tier B) / spawns clean env (Tier C). |

**Single-enforcer principle [decision]:** all capability and message validation lives in
**core, on the trusted side of every boundary** (injection-time, import-time,
RPC-boundary-time). No enforcement decision is delegated to app code or to a child process.
The manifest is the *contract*; core is the *enforcer*; the app is the *untrusted party*.
This is what makes "share apps safely" true rather than aspirational — the claim the whole
phase exists to back (ISO-1).

**Honest-docs requirement:** `docs/APP_TRUST_MODEL.md` (SR-3 deliverable, promoted from
`app-sharing-vision.md`'s "What PAS Does NOT Enforce", lines 141-147) must state exactly
what each shipped tier does and does not enforce — Tiers A+B "defeat accidents and the lazy
adversary; a determined author can still escape in-process"; Tier C "process-isolated,
permission-constrained." The doc ships regardless of how far B/C have landed.

---

## 8. Open questions for the implementing phases

1. **`requirements.services[]` ↔ capability consistency — migrate or validate (§2.1).**
   This design now *requires* one of two resolutions at T2a: (a) migrate service injection
   onto `capabilities.declared[]` (single surface), or (b) a mandatory normative
   services↔capabilities validator with the §2.1 mapping table as its authority. Open only:
   *which* of the two, and if (b), the exact rejection rules. **Not "layer and migrate
   later" — that was the rejected first-draft answer** (Codex Major). Recommendation:
   ship (b)'s validator at T2a regardless, migrate to (a) in SR-3's API-stability cut.

2. **Capability granularity for `net:fetch`.** Is per-host allowlisting (`net.allow: [host]`)
   worth the manifest complexity at Tier A, or is host-level enforcement deferred to Tier
   B/C where it can actually be enforced? The schema proposal includes an optional
   `net.allow[]` but marks it Tier-B-enforced.

3. **Per-app process scaling and the co-location principal (§4).** The isolation principal
   is decided — **one child per non-core app** (Codex Critical resolved). Open: (a) the
   process/RAM ceiling as installed-app count grows past the low tens on the Mac Mini
   target, and whether a lazy start/idle-reap pool is needed; (b) how a legitimate
   *co-location group* (apps declared a single security principal, sharing no distinct
   secrets/data) is *declared and attested* so pooling stays an optimization behind proven
   per-app isolation, never a default; (c) how an app's `built-in`/`reviewed`/`community`
   trust level is *assigned and recorded* (manifest field? install-time operator choice?
   registry attestation?) — not yet grounded in code; `app-sharing-vision.md` sketches the
   levels but nothing assigns them. Note these levels classify *scrutiny*, not *process
   sharing* — orthogonal axes (§4.1).

4. **Native production runtime as a Tier-B prerequisite (§5).** Tier B can be claimed
   fail-closed only off built JS; the current native deployment runs under `tsx`
   (`package.json:14`, DEP-5) where it is advisory only. Open: resolve the supported native
   production runtime (build-and-run compiled JS, or a supported non-tsx path) — this is a
   **prerequisite** of native Tier-B enforcement, not an afterthought. Until decided, the
   native deployment's real tier is A. Sub-question: under Tier B, can a loader hook gate
   the entry module's *own* top-level side effects, which run before the hook resolves that
   module's imports? If not, name it as an explicit Tier-B limitation in the trust doc and
   treat it as an argument to move untrusted apps to Tier C sooner.

5. **AG-3 default for `requiresConfirmation` on `read` tools.** This design defaults `read`
   to no-confirm. Confirm with the agentic-doctrine owner that no `read` tool leaks data
   across the household/user boundary in a way that itself warrants confirmation (e.g. a
   read that returns another user's data — which should instead be blocked by capability,
   not confirmed).

6. **Migration of existing manifests.** No app declares `capabilities.tools[]` today
   (grounded: the key does not exist in the live schema). When T2a introduces it, existing
   apps have zero tools and full legacy `services[]` grants. Define the migration so that
   adding `messaging:any-user` to apps that legitimately message multiple users
   (proactive food jobs) is a deliberate, reviewed step, not an implicit carry-over.

7. **Tier C RPC boundary shape.** CoreServices-as-RPC is a large interface commitment
   (§4). Should it reuse the `ChannelAdapter` seam SR-2 introduces, or is it an orthogonal
   internal boundary? Design the two seams with awareness of each other (both touch every
   app's service surface) to avoid a third round of app-signature churn after T5 and SR-2.

8. **OS-sandbox technology for the public-registry Tier C (§4.2).** Node's `--permission`
   is defense-in-depth, **not** a security boundary against malicious code — a public
   registry needs a real OS-level sandbox around each per-app child (container runtime vs.
   `sandbox-exec`/seccomp-bpf vs. a micro-VM). This design fixes the *principal* (per-app)
   and the *mechanism class* (OS-sandboxed child), not the vendor. The choice must weigh
   cross-platform reach (the Mac Mini target *and* the Windows deployment path) and is a
   Tier-C implementing-phase decision, gated before the registry ships.

---

## 9. Deferred-work note

Per CLAUDE.md's deferred-work rule, the enforcement work this design *specifies but does
not implement* (the services↔capabilities validator, Tier B loader hook, Tier C per-app
OS-sandboxed process isolation, `process.env` scrub, `net.allow` enforcement, the
native-production-runtime resolution that Tier B depends on, the OS-sandbox technology
choice, the trust-level assignment + co-location-principal mechanism, and
`docs/APP_TRUST_MODEL.md` itself) is tracked under the existing SR-1 phase entry in
`docs/open-items.md` (Confirmed Phases) and its planned-phase prose in
`docs/implementation-phases.md`
("Planned Phases — Strategic Review & Agentic Autonomy"). This design pass adds no *new*
deferred item beyond what those SR-1 entries already carry; it decides the open questions
they flagged (worker-vs-child, loader-hook×tsx) and fixes the manifest surface so T2a can
build against it.
