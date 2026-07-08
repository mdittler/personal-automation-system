# T2a — Tool Registry (+ AG-3 Rider) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Provenance:** **Fable-authored 2026-07-08, Codex-reviewed (high effort) + Fable-revised 2026-07-08.** The first review found 2 Critical + 4 Major + 1 Minor (verdict "needs rework"); all seven verified against SR-1 + the code and resolved — full disposition in §9. Plan for open-items Master Execution Order Track B phase **#6 "T2a — Tool foundation" including the AG-3 rider** (`docs/open-items.md`, table row 6 + hard gates 1–2). Implements the manifest surface SR-1 already decided: `docs/superpowers/specs/2026-07-07-sr-1-app-isolation-trust-model.md` **§2 (Tier A vocabulary + normative services↔capabilities resolution) and §3.2 (the unified `ToolDef` object)**, with the companion schema proposal `docs/superpowers/specs/app-manifest.capabilities.schema.json`. AG-3 metadata semantics from `docs/superpowers/plans/2026-07-07-agentic-harness-deep-dive.md` (AG-3 entry + Option 1) and `docs/agentic-autonomy-doctrine.md` item 4. **Plan only — no production code was written in this pass.**

**Goal:** Land `types/tool.ts`, the manifest `capabilities.declared[]` / `capabilities.net` / `capabilities.tools[]` surface, ToolPolicy, ToolRegistry, the SR-1-mandated services↔capabilities consistency validator, and install/load validation — with the AG-3 per-tool agent metadata (`riskClass` / `agentAllowed` / `requiresConfirmation` / `costHint`) required-at-authoring, defaulted-at-read.

**Architecture:** The SR-1 companion schema merges into the live `core/src/schemas/app-manifest.schema.json` (one array, one object shape — no parallel risk array). Pure validation functions (`tool-policy.ts`, `capability-consistency.ts`) run at **install** (`app-installer/index.ts` planInstall) and **load** (`app-registry/loader.ts` loadManifest); a `ToolRegistry` service is built in `compose-runtime.ts` Phase C (parallel to schedule registration) and dispatches tool calls through a new optional `AppModule.handleToolCall` method, mirroring the existing `handleScheduledJob` pattern. The registry is SDK-agnostic; T1's `completeWithTools` loop (not yet in the tree) consumes `listTools()` later.

**Tech Stack:** TypeScript 5.x ESM, Ajv 2020-12 (already a core dependency, `core/package.json:101`), Vitest, Biome.

---

## 0. Grounding (verified against the code, 2026-07-08)

Every structural claim below was read directly from the repo:

- **No ToolRegistry exists.** `grep -rn "ToolRegistry\|ToolPolicy\|completeWithTools"` over `core/src` returns nothing outside docs. T2a is greenfield; **T1a/T1 (Master Execution Order #4–#5) have not shipped either** — this plan therefore exposes an SDK-agnostic registry surface and defers the Vercel AI SDK adapter to T1 integration (deferred-work entry, §7). Per the Master Execution Order, T1a/T1 precede T2a; if T2a is built first anyway, nothing here blocks — the registry has no import from the (future) loop wrapper.
- **Manifest schema:** `core/src/schemas/app-manifest.schema.json` — `capabilities` object (line 79) currently allows only `messages`/`schedules`/`rules`/`events`, `additionalProperties: false`; `requirements.services` closed enum (lines 160–183). Validation via Ajv 2020-12 in `core/src/schemas/validate-manifest.ts:87` (`validateManifest`), strict mode, allErrors.
- **TS manifest types:** `core/src/types/manifest.ts` — `ManifestCapabilities` (line 43) must gain the three new members.
- **Service injection is gated by `requirements.services[]`:** `core/src/compose-runtime.ts:752` (`serviceFactory` builds `declaredServices`), lines 819–892 (`telegram: declaredServices.has('telegram') ? contextAwareTelegram : undefined`, etc.). This is the surface the consistency validator must keep provably consistent with `capabilities.declared[]` (SR-1 §2.1).
- **Handler dispatch precedent:** manifest `schedule.handler` is registration *metadata*; actual dispatch goes through the module method `handleScheduledJob(jobId, userId)` (`compose-runtime.ts:908–945`, `core/src/services/scheduler/index.ts:39–58`, `core/src/types/app-module.ts:104`). Nothing checks the schedule handler file exists. Tool dispatch follows the same pattern (decision D1 below).
- **Load pipeline:** `core/src/services/app-registry/loader.ts` — `loadManifest` (line 149) validates and returns `null` on failure (app skipped, `index.ts:56-59`); `isSafeRuntimeEntry` (line 87) is the existing path-safety idiom (no null byte, no absolute, no `..` escape via `resolve`+`relative`).
- **Install pipeline:** `core/src/services/app-installer/index.ts` — `planInstall` runs `validateManifest` (line 237), `checkCompatibility` (line 279), `analyzeApp` (line 290), then `buildPermissionSummary` (line 138). `InstallError.type` is a closed union (lines 32–43).
- **Existing apps declare no capability surface:** `apps/echo|notes|food/manifest.yaml` have `requirements.services[]` only — no `capabilities.declared`, no `tools`. `core/src/schemas/__tests__/bundled-manifests.test.ts` validates all bundled manifests against the live schema, so schema changes must keep legacy manifests green (SR-1 §8 Q6 migration).
- **Doctrine item 4** (`docs/agentic-autonomy-doctrine.md:31-36`): agent sessions draw from the same ToolRegistry, filtered by ToolPolicy + AG-3 metadata; mutating and external-effect tools require confirmation rendering the *arguments*.

## Decisions this plan makes (accepting SR-1's [decision] markers)

- **D1 — Dispatch target is `AppModule.handleToolCall?(toolName, args, ctx)`**, a new optional module method mirroring `handleScheduledJob`. **The manifest `handler` field is RESERVED Tier-C metadata, not the current dispatch target** (SR-1 §3.2 requires the field; Tier C will use it as the per-app-child dispatch descriptor). At T2a it is validated for **path shape only** (relative, inside app root, no null byte — same rules as `isSafeRuntimeEntry` minus the extension restriction, `.ts` allowed for dev parity) and is otherwise unused by runtime dispatch. Existence is *not* checked, matching the `schedule.handler` precedent. Rationale: per-file dynamic import of handler paths would invent a second module-loading path the loader doesn't have; the module-method pattern is the grounded PAS idiom. *(Codex Minor 7: documenting `handler` as reserved rather than "invocation metadata" removes the false implication that it drives dispatch today; the drift risk is named in §8.)*
- **D2 — The consistency validator SR-1 mandated lands HERE, in T2a** — SR-1 §8 Q1's explicit recommendation: "ship (b)'s validator at T2a regardless, migrate to (a) in SR-3's API-stability cut." Direction 1 (capability declared without its backing service → **fail**) is enforced unconditionally. Direction 2 (privileged service injected with no covering capability) is enforced **only for manifests that opt into the capability surface**, where opt-in is determined by property **presence** — `Object.hasOwn(capabilities, 'declared' | 'tools' | 'net')` — so an explicit empty `tools: []` / `declared: []` counts as adoption (Codex Major 3). Legacy manifests (all three bundled apps declare none of those keys) pass unchanged — SR-1 §8 Q6's migration posture ("existing apps have zero tools and full legacy `services[]` grants"). **`data-store` is NOT baseline-exempt** — SR-1 §2.1 gives an implicit baseline ONLY to reply-scoped Telegram; data access defaults to "No filesystem/data access", so a capability-surface app injecting `data-store` must declare `data:user`/`data:shared` (Codex Critical 2). Full direction-2 enforcement for all manifests is a deferred item owned by SR-1 Tier A implementation (§7).
- **D3 — Load-time semantic violations skip the whole app**, exactly like an invalid manifest today (`loader.ts:158-165`, fail-loud in logs). An app whose tool surface lies about its capabilities must not run with a silently amputated tool set.
- **D4 — Per-app tool registration is all-or-nothing.** One bad tool → zero tools registered for that app (and, per D3, at load time the app itself is skipped). No partial registration.
- **D5 — AG-3 defaults are applied at read** by a pure `resolveToolDefaults()`: `requiresConfirmation ??= (riskClass !== 'read')`, `agentAllowed ??= false`, `costHint ??= 'low'`, `requiresCapabilities ??= []`. `riskClass` has no default — it is schema-`required` (the "no unclassified tools" AG-3 gate).
- **D6 — ToolPolicy rejects explicit `requiresConfirmation: false` on BOTH `riskClass: write` and `riskClass: external-effect`** (doctrine item 4, `docs/agentic-autonomy-doctrine.md:34`: "Mutating and external-effect tools require user confirmation rendering the *arguments*"). An author cannot ship AG-3 metadata that contradicts current doctrine. `read` tools may set `requiresConfirmation: false` (that IS the derived default) or force-confirm with `true`. *(Revised per Codex Major 5 — the earlier "clamp only external-effect, defer the write floor to AG-2" position let contradictory metadata ship now; withdrawn. If a future phase decides a write floor genuinely belongs only inside agent sessions, that is a deliberate doctrine amendment, made in `agentic-autonomy-doctrine.md` first — not a silent T2a metadata allowance.)*
- **D7 — Tool `parameters` schemas are compiled with Ajv at registration**; a schema that fails to compile is a policy violation (hostile-schema fail-loud), and argument validation runs on every `dispatch()`.
- **D8 — The registry is infrastructure-side, not on `CoreServices`.** Apps never see the registry; consumers are the T1 loop wrapper, T2b/T2c surfaces, and AG-2. No change to `CoreServices` members besides the new optional `AppModule.handleToolCall`.
- **D9 — `$async` parameter schemas are rejected (Codex Critical 1).** Ajv compiles `{"$async": true, …}` into a validator that returns a Promise; a Promise is truthy, so the synchronous guard `!validate(args)` is always `false` and invalid args reach the handler (and the thrown `ValidationError` surfaces as an unhandled rejection) — verified against the project's ajv 8.18.0. ToolPolicy rejects any tool whose compiled `parameters` validator has `.$async` truthy (rule `async-parameters-schema`); the registry re-checks at registration, and `dispatch()` treats `validate(args) !== true` (not mere falsiness) as invalid so a Promise return can never be read as "valid" — three independent closes of the same hole.

## The T2a ToolRegistry contract (summary the tasks implement)

1. **Registration source:** `manifest.capabilities.tools[]` — the single SR-1 §3 surface. `composeRuntime` Phase C builds one `ToolRegistry` and calls `registerApp(manifest, module)` for every registry entry (after `loadAll` + virtual registration, parallel to schedule registration at `compose-runtime.ts:908`).
2. **Validation:** three layers, all fail-loud —
   - **Schema (Ajv):** shape, `riskClass` required, closed capability enum, name pattern, `additionalProperties: false`. Runs wherever `validateManifest` already runs (install line 237, load line 158).
   - **ToolPolicy (semantic, pure):** app-id name prefix, uniqueness, `requiresCapabilities ⊆ capabilities.declared`, `secrets:<id>` ↔ `external_apis[].id`, handler path safety, D6 confirmation clamp (write AND external-effect), parameters compilable AND non-`$async` (D9).
   - **Consistency validator (SR-1 §2.1 option b):** capability ↔ backing-service mapping table (below), both install and load.
3. **Exposure to the tool loop:** `listTools(filter?)` returns frozen `RegisteredTool` objects (resolved defaults applied); `getTool(name)`; `dispatch(name, args, ctx)` validates args against the compiled parameter schema then awaits `module.handleToolCall(name, args, ctx)`. T2a ignores the agent fields at dispatch (structured path); AG-2 filters the same list by `agentAllowed`/`riskClass` later — no second read of the manifest.
4. **AG-3 rider:** `riskClass` required-at-authoring (schema); `agentAllowed`/`requiresConfirmation`/`costHint` defaulted-at-read (D5); write AND external-effect confirmation not loosenable (D6); `$async` parameter schemas rejected (D9). Carried unused by T2a's structured path — that is the point (cheap to carry, expensive to retrofit).
5. **Capability → backing-service mapping table** (the §2.1 authority, encoded once in `capability-consistency.ts`):

   | Capability | Required entry in `requirements.services[]` | Direction-2 covering caps for that service |
   |---|---|---|
   | `messaging:any-user`, `messaging:proactive` | `telegram` | *(none — reply-scoped `telegram` is the implicit baseline, SR-1 §2.1)* |
   | `data:user`, `data:shared` | `data-store` | `data:user` \| `data:shared` (NOT baseline — Critical 2) |
   | `schedule:register` | `scheduler` | `schedule:register` |
   | `events:emit`, `events:subscribe` | `event-bus` | `events:emit` \| `events:subscribe` |
   | `audio:play` | `audio` | `audio:play` |
   | `secrets:<id>` | *(not a service)* — `<id>` must match a `requirements.external_apis[].id` | *(n/a)* |
   | `net:fetch` | *(none — Tier B/C enforced; only coupling: `capabilities.net` present ⇒ `net:fetch` declared)* | *(n/a)* |

   Direction 1 (declared capability ⇒ its backing service must be present) uses column 2; direction 2 (opted-in app injecting a privileged service ⇒ a covering capability must be declared) uses column 3. `telegram` is the only service with no direction-2 requirement (reply-scoped messaging is implicit); `data-store` has one (Critical 2).

## File structure

- **Create:** `core/src/types/tool.ts` — `ToolRiskClass`, `ToolCostHint`, `ManifestToolDef`, `ResolvedToolDef`, `resolveToolDefaults`, `ToolCallContext`, `RegisteredTool`, `ToolCallResult`.
- **Create:** `core/src/services/tools/tool-policy.ts` — `validateAppTools(manifest)` (pure).
- **Create:** `core/src/services/tools/capability-consistency.ts` — `validateServiceCapabilityConsistency(manifest)` (pure) + the mapping table.
- **Create:** `core/src/services/tools/tool-registry.ts` — the `ToolRegistry` class.
- **Create:** `core/src/services/tools/index.ts` — re-exports.
- **Create:** `core/src/services/tools/__tests__/{tool-defaults,tool-policy,capability-consistency,tool-registry}.test.ts`.
- **Modify:** `core/src/schemas/app-manifest.schema.json` — add `capabilities.declared` / `capabilities.net` / `capabilities.tools` + `$defs.capability` / `$defs.toolDef` (from the SR-1 companion proposal, adapted).
- **Modify:** `core/src/types/manifest.ts:43` — extend `ManifestCapabilities`.
- **Modify:** `core/src/types/app-module.ts` — add optional `handleToolCall` to `AppModule` (near `handleScheduledJob`, line 104).
- **Modify:** `core/src/services/app-registry/loader.ts:149` — semantic validation in `loadManifest`.
- **Modify:** `core/src/services/app-installer/index.ts` — `TOOL_POLICY_VIOLATION` error type; policy + consistency checks in `planInstall`; `tools` in `PermissionSummary`.
- **Modify:** `core/src/compose-runtime.ts` — build + expose `toolRegistry` in Phase C.
- **Modify (tests):** `core/src/schemas/__tests__/validate-manifest.test.ts`, `core/src/services/app-registry/__tests__/loader.test.ts`, `core/src/services/app-installer/__tests__/*`.
- **Docs:** `docs/urs.md` (REQ-TOOL-001..006 + matrix), `docs/open-items.md` (flip row #6), `docs/implementation-phases.md`.

Shared fixture builders go in one helper (`core/src/services/tools/__tests__/fixtures.ts`) exporting `toolManifest(overrides)` / `validTool(overrides)` so hostile variants are one-line diffs. All test snippets below assume it.

```ts
// core/src/services/tools/__tests__/fixtures.ts
import type { AppManifest } from '../../../types/manifest.js';
import type { ManifestToolDef } from '../../../types/tool.js';

export function validTool(overrides: Partial<ManifestToolDef> = {}): ManifestToolDef {
	return {
		name: 'echo:list-log',
		description: 'List the echo log entries for the requesting user.',
		parameters: { type: 'object', additionalProperties: false },
		handler: 'tools/list-log.ts',
		requiresCapabilities: ['data:user'],
		riskClass: 'read',
		...overrides,
	};
}

export function toolManifest(overrides: {
	tools?: ManifestToolDef[];
	declared?: string[];
	services?: string[];
	externalApis?: { id: string; description: string; required: boolean; env_var: string }[];
	net?: { allow?: string[] };
}): AppManifest {
	return {
		app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Test app.', author: 'PAS' },
		capabilities: {
			...(overrides.declared ? { declared: overrides.declared } : {}),
			...(overrides.net ? { net: overrides.net } : {}),
			...(overrides.tools ? { tools: overrides.tools } : {}),
		},
		requirements: {
			services: overrides.services ?? ['telegram', 'data-store'],
			...(overrides.externalApis ? { external_apis: overrides.externalApis } : {}),
		},
	} as AppManifest;
}
```

---

## Task 1: Manifest schema — the unified capability + tool surface

**Files:**
- Modify: `core/src/schemas/app-manifest.schema.json` (capabilities block, line 79; `$defs`, line 268)
- Test: `core/src/schemas/__tests__/validate-manifest.test.ts`

- [ ] **Step 1: Write the failing tests** (append a `describe('capabilities.tools surface (T2a)')` block)

```ts
const baseTool = {
	name: 'echo:list-log',
	description: 'List echo log entries.',
	parameters: { type: 'object', additionalProperties: false },
	handler: 'tools/list-log.ts',
	riskClass: 'read',
};
const withTools = (tool: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	...echoManifest,
	capabilities: { ...echoManifest.capabilities, tools: [tool], ...extra },
});

describe('capabilities.tools surface (T2a)', () => {
	it('accepts a minimal valid tool with declared capabilities', () => {
		const result = validateManifest(withTools(
			{ ...baseTool, requiresCapabilities: ['data:user'] },
			{ declared: ['data:user'] },
		));
		expect(result.valid).toBe(true);
	});

	it('rejects a tool missing riskClass (AG-3: no unclassified tools)', () => {
		const { riskClass, ...noRisk } = baseTool;
		const result = validateManifest(withTools(noRisk));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.errors.join('\n')).toMatch(/riskClass/);
	});

	it('rejects a tool missing parameters (required — empty schema must be explicit)', () => {
		const { parameters, ...noParams } = baseTool;
		expect(validateManifest(withTools(noParams)).valid).toBe(false);
	});

	it('rejects an unknown capability string in declared[]', () => {
		expect(validateManifest(withTools(baseTool, { declared: ['shell:exec'] })).valid).toBe(false);
	});

	it('accepts the secrets:<id> parameterized capability form', () => {
		expect(validateManifest(withTools(baseTool, { declared: ['secrets:weather-api'] })).valid).toBe(true);
	});

	it('rejects a non-namespaced tool name', () => {
		expect(validateManifest(withTools({ ...baseTool, name: 'listlog' })).valid).toBe(false);
	});

	it('rejects unexpected properties on a tool (additionalProperties: false)', () => {
		expect(validateManifest(withTools({ ...baseTool, shell: true })).valid).toBe(false);
	});

	it('rejects an invalid riskClass value', () => {
		expect(validateManifest(withTools({ ...baseTool, riskClass: 'nuclear' })).valid).toBe(false);
	});

	it('accepts capabilities.net with a hostname allowlist', () => {
		const result = validateManifest({
			...echoManifest,
			capabilities: { ...echoManifest.capabilities, declared: ['net:fetch'], net: { allow: ['api.example.com'] } },
		});
		expect(result.valid).toBe(true);
	});

	it('still accepts legacy manifests with no capability surface (echo/full fixtures)', () => {
		expect(validateManifest(echoManifest).valid).toBe(true);
		expect(validateManifest(fullManifest).valid).toBe(true);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/schemas/__tests__/validate-manifest.test.ts`. Expected: the new block FAILS (`unexpected property 'tools'` / `'declared'` — the live schema's `additionalProperties: false` on `capabilities` rejects them); legacy tests still pass.

- [ ] **Step 3: Merge the SR-1 companion schema into the live schema.** Inside `properties.capabilities.properties` add `declared`, `net`, `tools` exactly as in `docs/superpowers/specs/app-manifest.capabilities.schema.json:9-37`; add `$defs.capability` and `$defs.toolDef` from that proposal's `$defs` (lines 40–133) **minus** its `allOf` no-op comment block (keep the derivation note as a `$comment` on `requiresConfirmation`). Keep the proposal's patterns verbatim: capability enum + `^secrets:[a-z][a-z0-9-]*$`; tool name `^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$`; `required: ["name", "description", "parameters", "handler", "riskClass"]`; `net.allow` items `^[a-z0-9.-]+$`; `uniqueItems` on all three arrays. Do NOT copy the proposal's root `additionalProperties: true` — the live `capabilities` object stays `additionalProperties: false`.

- [ ] **Step 4: Run to verify pass** — same command, all green. Also run `pnpm vitest run core/src/schemas/__tests__/bundled-manifests.test.ts` (legacy bundled manifests must stay green — proves SR-1 §8 Q6 zero-impact migration).

- [ ] **Step 5: Commit** — `git add core/src/schemas && git commit -m "feat(t2a): manifest schema gains unified capabilities.declared/net/tools surface (SR-1 §3.2)"`

## Task 2: `types/tool.ts` + manifest types + AG-3 read-time defaults

**Files:**
- Create: `core/src/types/tool.ts`
- Modify: `core/src/types/manifest.ts:43` (`ManifestCapabilities`)
- Test: `core/src/services/tools/__tests__/tool-defaults.test.ts` (+ create `fixtures.ts` from the File structure section)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveToolDefaults } from '../../../types/tool.js';
import { validTool } from './fixtures.js';

describe('resolveToolDefaults (AG-3 required-at-authoring, defaulted-at-read)', () => {
	it('defaults agentAllowed=false, costHint=low, requiresCapabilities=[]', () => {
		const resolved = resolveToolDefaults(validTool({ requiresCapabilities: undefined }));
		expect(resolved.agentAllowed).toBe(false);
		expect(resolved.costHint).toBe('low');
		expect(resolved.requiresCapabilities).toEqual([]);
	});

	it('derives requiresConfirmation from riskClass: read=>false, write/external-effect=>true', () => {
		expect(resolveToolDefaults(validTool({ riskClass: 'read' })).requiresConfirmation).toBe(false);
		expect(resolveToolDefaults(validTool({ riskClass: 'write' })).requiresConfirmation).toBe(true);
		expect(resolveToolDefaults(validTool({ riskClass: 'external-effect' })).requiresConfirmation).toBe(true);
	});

	it('an explicit requiresConfirmation wins over the derivation (force-confirm a read)', () => {
		expect(
			resolveToolDefaults(validTool({ riskClass: 'read', requiresConfirmation: true })).requiresConfirmation,
		).toBe(true);
	});

	it('preserves explicit agentAllowed/costHint', () => {
		const resolved = resolveToolDefaults(validTool({ agentAllowed: true, costHint: 'high' }));
		expect(resolved.agentAllowed).toBe(true);
		expect(resolved.costHint).toBe('high');
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/services/tools/__tests__/tool-defaults.test.ts`. Expected: FAIL, cannot resolve `../../../types/tool.js`.

- [ ] **Step 3: Implement `core/src/types/tool.ts`**

```ts
/**
 * Tool type system (T2a) — the unified SR-1 §3.2 ToolDef surface.
 * One object shape read by three consumers: ToolRegistry (identity/invocation),
 * AG-2/AG-3 agent policy (risk metadata), SR-1 trust tiers (requiresCapabilities).
 */

export type ToolRiskClass = 'read' | 'write' | 'external-effect';
export type ToolCostHint = 'none' | 'low' | 'high';

/** A tool exactly as authored in manifest.capabilities.tools[]. */
export interface ManifestToolDef {
	/** Namespaced `app:verb` id. Prefix must equal manifest app.id (ToolPolicy). */
	name: string;
	/** Model-facing spec. Fenced as untrusted app content downstream (T2c). */
	description: string;
	/** JSON Schema (2020-12) for arguments. Required; no-arg tools declare {} explicitly. */
	parameters: Record<string, unknown>;
	/** RESERVED Tier-C dispatch descriptor (D1). NOT the current dispatch target — dispatch is via AppModule.handleToolCall. Validated for path shape only at T2a. */
	handler: string;
	/** Subset of capabilities.declared[] this tool exercises. */
	requiresCapabilities?: string[];
	/** AG-3 — required at authoring; no default. */
	riskClass: ToolRiskClass;
	/** AG-3 — may a bounded agent session call this tool. Default false (opt-in). */
	agentAllowed?: boolean;
	/** AG-3 — render arguments for confirmation. Default derives from riskClass. */
	requiresConfirmation?: boolean;
	/** AG-3 — advisory budget signal. Never an enforcement input. */
	costHint?: ToolCostHint;
}

/** A ToolDef after read-time defaulting — every optional resolved. */
export interface ResolvedToolDef extends ManifestToolDef {
	requiresCapabilities: string[];
	agentAllowed: boolean;
	requiresConfirmation: boolean;
	costHint: ToolCostHint;
}

/** AG-3 defaulted-at-read (SR-1 §3.2): riskClass stays author-mandatory. */
export function resolveToolDefaults(def: ManifestToolDef): ResolvedToolDef {
	return {
		...def,
		requiresCapabilities: def.requiresCapabilities ?? [],
		agentAllowed: def.agentAllowed ?? false,
		requiresConfirmation: def.requiresConfirmation ?? def.riskClass !== 'read',
		costHint: def.costHint ?? 'low',
	};
}

/** Context for a single tool invocation (extended by T2b/T2c/AG-2). */
export interface ToolCallContext {
	userId: string;
	/** 'structured' = T2a/T1 loop; 'agent' = AG-2 sessions (future). */
	source: 'structured' | 'agent';
}

/** A registered, validated, default-resolved tool. */
export interface RegisteredTool {
	appId: string;
	def: ResolvedToolDef;
}

export type ToolCallResult =
	| { ok: true; result: unknown }
	| { ok: false; error: string };
```

Then extend `core/src/types/manifest.ts` — add to `ManifestCapabilities` (line 43):

```ts
import type { ManifestToolDef } from './tool.js';

export interface ManifestCapabilities {
	messages?: ManifestMessages;
	schedules?: ManifestSchedule[];
	rules?: ManifestRules;
	events?: ManifestEvents;
	/** Tier A capability vocabulary (SR-1 §2.1). Closed enum + secrets:<id>. */
	declared?: string[];
	/** Network egress policy; only meaningful with net:fetch declared. Tier B/C enforced. */
	net?: { allow?: string[] };
	/** THE UNIFIED SURFACE (SR-1 §3): one object per tool, read by all consumers. */
	tools?: ManifestToolDef[];
}
```

- [ ] **Step 4: Run to verify pass** — same command, green.

- [ ] **Step 5: Commit** — `git add core/src/types core/src/services/tools && git commit -m "feat(t2a): tool type system + AG-3 read-time default resolver"`

## Task 3: ToolPolicy — per-tool semantic validation

**Files:**
- Create: `core/src/services/tools/tool-policy.ts`
- Test: `core/src/services/tools/__tests__/tool-policy.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { validateAppTools } from '../tool-policy.js';
import { toolManifest, validTool } from './fixtures.js';

const rules = (m: Parameters<typeof validateAppTools>[0]) => validateAppTools(m).map((v) => v.rule);

describe('validateAppTools', () => {
	it('passes a valid tool whose requiresCapabilities are all declared', () => {
		expect(validateAppTools(toolManifest({ tools: [validTool()], declared: ['data:user'] }))).toEqual([]);
	});

	it('passes a manifest with no tools at all (legacy)', () => {
		expect(validateAppTools(toolManifest({}))).toEqual([]);
	});

	it('rejects a tool exceeding its app capability set (SR-1 §3.2: cannot silently exceed)', () => {
		const m = toolManifest({
			tools: [validTool({ requiresCapabilities: ['messaging:any-user'] })],
			declared: ['data:user'],
		});
		expect(rules(m)).toContain('capability-exceeds-declared');
	});

	it('rejects a tool requiring capabilities when the app declares none', () => {
		const m = toolManifest({ tools: [validTool({ requiresCapabilities: ['data:user'] })] });
		expect(rules(m)).toContain('capability-exceeds-declared');
	});

	it('rejects a tool whose name prefix is not the app id', () => {
		const m = toolManifest({ tools: [validTool({ name: 'food:list-log', requiresCapabilities: [] })] });
		expect(rules(m)).toContain('name-prefix-mismatch');
	});

	it('rejects duplicate tool names within one app', () => {
		const t = validTool({ requiresCapabilities: [] });
		expect(rules(toolManifest({ tools: [t, { ...t }] }))).toContain('duplicate-tool-name');
	});

	it('rejects secrets:<id> not matching any requirements.external_apis[].id', () => {
		const m = toolManifest({
			tools: [validTool({ requiresCapabilities: ['secrets:weather-api'] })],
			declared: ['secrets:weather-api'],
		});
		expect(rules(m)).toContain('unknown-secret-id');
	});

	it('accepts secrets:<id> that matches a declared external API', () => {
		const m = toolManifest({
			tools: [validTool({ requiresCapabilities: ['secrets:weather-api'] })],
			declared: ['secrets:weather-api'],
			externalApis: [{ id: 'weather-api', description: 'w', required: false, env_var: 'WEATHER_KEY' }],
		});
		expect(validateAppTools(m)).toEqual([]);
	});

	it.each([
		['absolute', '/etc/passwd'],
		['traversal', '../../evil.js'],
		['null byte', 'tools/x .js'],
	])('rejects a hostile handler path (%s)', (_label, handler) => {
		const m = toolManifest({ tools: [validTool({ handler, requiresCapabilities: [] })] });
		expect(rules(m)).toContain('unsafe-handler-path');
	});

	it('rejects explicit requiresConfirmation:false on external-effect (doctrine item 4)', () => {
		const m = toolManifest({
			tools: [validTool({ riskClass: 'external-effect', requiresConfirmation: false, requiresCapabilities: [] })],
		});
		expect(rules(m)).toContain('confirmation-not-loosenable');
	});

	it('ALSO rejects explicit requiresConfirmation:false on write (doctrine item 4: mutating AND external-effect, D6/Major 5)', () => {
		const m = toolManifest({
			tools: [validTool({ riskClass: 'write', requiresConfirmation: false, requiresCapabilities: [] })],
		});
		expect(rules(m)).toContain('confirmation-not-loosenable');
	});

	it('allows requiresConfirmation:false on read (that IS the derived default)', () => {
		const m = toolManifest({
			tools: [validTool({ riskClass: 'read', requiresConfirmation: false, requiresCapabilities: [] })],
		});
		expect(validateAppTools(m)).toEqual([]);
	});

	it('rejects a parameters value that is not a compilable JSON Schema', () => {
		const m = toolManifest({
			tools: [validTool({ parameters: { type: 'not-a-type' }, requiresCapabilities: [] })],
		});
		expect(rules(m)).toContain('uncompilable-parameters-schema');
	});

	it('rejects an $async parameters schema (Critical 1: async validator returns a truthy Promise, bypassing dispatch arg checks)', () => {
		const m = toolManifest({
			tools: [validTool({ parameters: { $async: true, type: 'object', additionalProperties: false }, requiresCapabilities: [] })],
		});
		expect(rules(m)).toContain('async-parameters-schema');
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/services/tools/__tests__/tool-policy.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `core/src/services/tools/tool-policy.ts`**

```ts
/**
 * ToolPolicy (T2a): pure semantic validation of manifest.capabilities.tools[]
 * beyond JSON-Schema shape. Runs at install (planInstall) and load (loadManifest).
 * A tool cannot exceed its app's declared capability surface (SR-1 §3.2).
 */

import { isAbsolute, relative, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { AppManifest } from '../../types/manifest.js';

export interface ToolPolicyViolation {
	rule:
		| 'name-prefix-mismatch'
		| 'duplicate-tool-name'
		| 'capability-exceeds-declared'
		| 'unknown-secret-id'
		| 'unsafe-handler-path'
		| 'confirmation-not-loosenable'
		| 'uncompilable-parameters-schema'
		| 'async-parameters-schema';
	toolName?: string;
	message: string;
}

// Compile-check instance for app-authored parameter schemas. strict:false —
// author schemas are hostile input; we require *compilability*, not our
// authoring conventions. Structural garbage (bad `type` values etc.) still throws.
const paramAjv = new Ajv2020.default({ strict: false });

function isSafeHandlerPath(handler: string): boolean {
	if (!handler || handler.includes(' ') || isAbsolute(handler)) return false;
	const rel = relative('/app-root', resolve('/app-root', handler));
	return !(rel.startsWith('..') || isAbsolute(rel));
}

export function validateAppTools(manifest: AppManifest): ToolPolicyViolation[] {
	const tools = manifest.capabilities?.tools ?? [];
	if (tools.length === 0) return [];

	const violations: ToolPolicyViolation[] = [];
	const appId = manifest.app.id;
	const declared = new Set(manifest.capabilities?.declared ?? []);
	const externalApiIds = new Set((manifest.requirements?.external_apis ?? []).map((a) => a.id));
	const seen = new Set<string>();

	for (const tool of tools) {
		if (!tool.name.startsWith(`${appId}:`)) {
			violations.push({ rule: 'name-prefix-mismatch', toolName: tool.name,
				message: `Tool "${tool.name}" must be namespaced under app id "${appId}:"` });
		}
		if (seen.has(tool.name)) {
			violations.push({ rule: 'duplicate-tool-name', toolName: tool.name,
				message: `Duplicate tool name "${tool.name}"` });
		}
		seen.add(tool.name);

		for (const cap of tool.requiresCapabilities ?? []) {
			if (!declared.has(cap)) {
				violations.push({ rule: 'capability-exceeds-declared', toolName: tool.name,
					message: `Tool "${tool.name}" requires "${cap}" which is not in capabilities.declared[]` });
			}
			if (cap.startsWith('secrets:') && !externalApiIds.has(cap.slice('secrets:'.length))) {
				violations.push({ rule: 'unknown-secret-id', toolName: tool.name,
					message: `"${cap}" does not match any requirements.external_apis[].id` });
			}
		}

		if (!isSafeHandlerPath(tool.handler)) {
			violations.push({ rule: 'unsafe-handler-path', toolName: tool.name,
				message: `Handler path "${tool.handler}" is not a safe app-relative path` });
		}

		// Doctrine item 4 (agentic-autonomy-doctrine.md:34): BOTH mutating and
		// external-effect tools require confirmation. An author cannot opt out.
		if (tool.riskClass !== 'read' && tool.requiresConfirmation === false) {
			violations.push({ rule: 'confirmation-not-loosenable', toolName: tool.name,
				message: `Tool "${tool.name}": ${tool.riskClass} tools cannot opt out of confirmation (doctrine item 4)` });
		}

		try {
			const validate = paramAjv.compile(tool.parameters);
			// Critical 1: an $async schema compiles to a validator returning a
			// Promise, which is truthy — the synchronous `!validate(args)` guard
			// then never fires and invalid args reach the handler. Reject it.
			if (validate.$async) {
				violations.push({ rule: 'async-parameters-schema', toolName: tool.name,
					message: `Tool "${tool.name}" parameters must not be an $async schema (its validator returns a Promise, bypassing argument validation)` });
			}
		} catch (error) {
			violations.push({ rule: 'uncompilable-parameters-schema', toolName: tool.name,
				message: `Tool "${tool.name}" parameters schema failed to compile: ${String(error)}` });
		}
	}

	return violations;
}
```

Note: `secrets:<cap>` in `capabilities.declared[]` with no matching external API is caught by Task 4 (it is an app-level, not tool-level, inconsistency); the tool-level check above catches a tool *requiring* an unresolvable secret even when app-level validation is bypassed.

- [ ] **Step 4: Run to verify pass** — same command, green.

- [ ] **Step 5: Commit** — `git add core/src/services/tools && git commit -m "feat(t2a): ToolPolicy semantic validation (capability ceiling, naming, handler safety, write+external-effect confirm clamp, async-schema rejection)"`

## Task 4: Services↔capabilities consistency validator (the SR-1 §2.1 mandate)

**Files:**
- Create: `core/src/services/tools/capability-consistency.ts`
- Test: `core/src/services/tools/__tests__/capability-consistency.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { validateServiceCapabilityConsistency } from '../capability-consistency.js';
import { toolManifest, validTool } from './fixtures.js';

const rules = (m: Parameters<typeof validateServiceCapabilityConsistency>[0]) =>
	validateServiceCapabilityConsistency(m).map((v) => v.rule);

describe('validateServiceCapabilityConsistency (SR-1 §2.1 option b)', () => {
	it('passes a consistent manifest (capability backed by its service)', () => {
		const m = toolManifest({ declared: ['messaging:any-user'], services: ['telegram'] });
		expect(validateServiceCapabilityConsistency(m)).toEqual([]);
	});

	it('fails a capability declared without its backing service (drift, direction 1)', () => {
		const m = toolManifest({ declared: ['messaging:any-user'], services: ['data-store'] });
		expect(rules(m)).toContain('capability-without-backing-service');
	});

	it('fails data:user declared without data-store', () => {
		const m = toolManifest({ declared: ['data:user'], services: ['telegram'] });
		expect(rules(m)).toContain('capability-without-backing-service');
	});

	it('fails schedule:register without scheduler, events:* without event-bus, audio:play without audio', () => {
		const m = toolManifest({
			declared: ['schedule:register', 'events:emit', 'events:subscribe', 'audio:play'],
			services: ['telegram'],
		});
		expect(validateServiceCapabilityConsistency(m)).toHaveLength(4);
	});

	it('fails a declared secrets:<id> with no matching external API', () => {
		const m = toolManifest({ declared: ['secrets:weather-api'], services: ['telegram'] });
		expect(rules(m)).toContain('secret-capability-without-external-api');
	});

	it('fails capabilities.net present without net:fetch declared', () => {
		const m = toolManifest({ declared: ['data:user'], services: ['data-store'], net: { allow: ['api.example.com'] } });
		expect(rules(m)).toContain('net-policy-without-net-fetch');
	});

	it('net:fetch needs no backing service (Tier B/C enforced)', () => {
		const m = toolManifest({ declared: ['net:fetch'], services: ['telegram'], net: { allow: ['api.example.com'] } });
		expect(validateServiceCapabilityConsistency(m)).toEqual([]);
	});

	it('LEGACY PASSTHROUGH: a manifest with services but no capability surface passes untouched (SR-1 §8 Q6)', () => {
		const m = toolManifest({ services: ['telegram', 'data-store', 'scheduler', 'event-bus', 'audio'] });
		expect(validateServiceCapabilityConsistency(m)).toEqual([]);
	});

	it('OPT-IN direction 2: an app on the capability surface injecting a privileged service with no covering capability fails', () => {
		// Declares tools (opted in) + scheduler service, but no schedule:register capability.
		const m = toolManifest({
			tools: [validTool({ requiresCapabilities: ['data:user'] })],
			declared: ['data:user'],
			services: ['data-store', 'scheduler'],
		});
		expect(rules(m)).toContain('privileged-service-without-capability');
	});

	it('direction 2 does not fire when data-store IS covered by a declared data:* capability', () => {
		const m = toolManifest({
			tools: [validTool({ requiresCapabilities: ['data:user'] })],
			declared: ['data:user'],
			services: ['telegram', 'data-store'],
		});
		expect(validateServiceCapabilityConsistency(m)).toEqual([]);
	});

	it('CRITICAL 2 — direction 2 FIRES for data-store with no declared data:* capability (data has no implicit baseline, SR-1 §2.1)', () => {
		const m = toolManifest({
			tools: [validTool({ requiresCapabilities: [] })],
			declared: [],
			services: ['telegram', 'data-store'],
		});
		expect(rules(m)).toContain('privileged-service-without-capability');
	});

	it('telegram alone never triggers direction 2 (reply-scoped messaging IS the implicit baseline)', () => {
		const m = toolManifest({ tools: [validTool({ requiresCapabilities: [] })], declared: [], services: ['telegram'] });
		expect(validateServiceCapabilityConsistency(m)).toEqual([]);
	});

	it('MAJOR 3 — opt-in is by property presence: an explicit empty tools: [] counts as adoption', () => {
		// tools present (empty) but scheduler injected with no schedule:register → fails.
		const m = toolManifest({ tools: [], services: ['telegram', 'scheduler'] });
		expect(rules(m)).toContain('privileged-service-without-capability');
	});

	it('MAJOR 3 — an explicit empty declared: [] counts as adoption too', () => {
		const m = toolManifest({ declared: [], services: ['telegram', 'audio'] });
		expect(rules(m)).toContain('privileged-service-without-capability');
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/services/tools/__tests__/capability-consistency.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `core/src/services/tools/capability-consistency.ts`**

```ts
/**
 * The NORMATIVE services↔capabilities consistency validator (SR-1 §2.1, option b;
 * §8 Q1 recommends shipping it at T2a). The mapping table below is the published
 * authority linking Tier A capability names to the requirements.services[] enum
 * that actually gates injection today (compose-runtime.ts:752-892).
 *
 * Direction 1 (capability without backing service) is enforced unconditionally.
 * Direction 2 (privileged service without covering capability) is enforced only
 * for manifests that OPT INTO the capability surface, where opt-in is by property
 * PRESENCE (Object.hasOwn) so an explicit empty `tools: []` / `declared: []`
 * counts as adoption (Codex Major 3) — legacy manifests (no declared/tools/net key)
 * keep full services[] grants (SR-1 §8 Q6 migration). `data-store` has NO implicit
 * baseline (SR-1 §2.1: data defaults to no access — Codex Critical 2); only
 * reply-scoped `telegram` is baseline-exempt. Full direction-2 enforcement for all
 * manifests is SR-1 Tier A's job.
 */

import type { AppManifest } from '../../types/manifest.js';

export interface ConsistencyViolation {
	rule:
		| 'capability-without-backing-service'
		| 'secret-capability-without-external-api'
		| 'net-policy-without-net-fetch'
		| 'privileged-service-without-capability';
	capability?: string;
	service?: string;
	message: string;
}

/** SR-1 §2.1 table: capability → required requirements.services[] entry. */
const CAPABILITY_BACKING_SERVICE: Record<string, string | null> = {
	'messaging:any-user': 'telegram',
	'messaging:proactive': 'telegram',
	'data:user': 'data-store',
	'data:shared': 'data-store',
	'net:fetch': null, // Tier B/C enforced; no CoreServices backing
	'schedule:register': 'scheduler',
	'events:emit': 'event-bus',
	'events:subscribe': 'event-bus',
	'audio:play': 'audio',
};

/** Direction 2: services that MUST be described by a capability once opted in. */
const PRIVILEGED_SERVICE_COVERING_CAPS: Record<string, string[]> = {
	'data-store': ['data:user', 'data:shared'],
	scheduler: ['schedule:register'],
	'event-bus': ['events:emit', 'events:subscribe'],
	audio: ['audio:play'],
	// telegram is the ONLY baseline: reply-scoped messaging is implicit
	// (SR-1 §2.1 — no messaging:reply token). data-store has NO implicit
	// baseline — SR-1 §2.1 defaults data to "No filesystem/data access", so a
	// capability-surface app must declare data:user / data:shared (Codex Critical 2).
};

export function validateServiceCapabilityConsistency(manifest: AppManifest): ConsistencyViolation[] {
	const violations: ConsistencyViolation[] = [];
	const caps = manifest.capabilities;
	const declared = caps?.declared ?? [];
	const services = new Set(manifest.requirements?.services ?? []);
	const externalApiIds = new Set((manifest.requirements?.external_apis ?? []).map((a) => a.id));
	// Opt-in by property PRESENCE, not array length — an explicit empty
	// `tools: []` / `declared: []` is schema-legal and counts as adoption
	// (Codex Major 3). A legacy manifest declares none of these keys.
	const optedIn =
		caps !== undefined &&
		(Object.hasOwn(caps, 'declared') || Object.hasOwn(caps, 'tools') || Object.hasOwn(caps, 'net'));

	for (const cap of declared) {
		if (cap.startsWith('secrets:')) {
			if (!externalApiIds.has(cap.slice('secrets:'.length))) {
				violations.push({ rule: 'secret-capability-without-external-api', capability: cap,
					message: `"${cap}" has no matching requirements.external_apis[].id` });
			}
			continue;
		}
		const backing = CAPABILITY_BACKING_SERVICE[cap];
		if (backing && !services.has(backing)) {
			violations.push({ rule: 'capability-without-backing-service', capability: cap, service: backing,
				message: `Capability "${cap}" requires service "${backing}" in requirements.services[]` });
		}
	}

	if (manifest.capabilities?.net !== undefined && !declared.includes('net:fetch')) {
		violations.push({ rule: 'net-policy-without-net-fetch',
			message: 'capabilities.net is only meaningful when net:fetch is declared' });
	}

	if (optedIn) {
		for (const [service, coveringCaps] of Object.entries(PRIVILEGED_SERVICE_COVERING_CAPS)) {
			if (services.has(service) && !coveringCaps.some((c) => declared.includes(c))) {
				violations.push({ rule: 'privileged-service-without-capability', service,
					message: `Service "${service}" is injected but no covering capability (${coveringCaps.join(' | ')}) is declared` });
			}
		}
	}

	return violations;
}
```

- [ ] **Step 4: Run to verify pass** — same command, green.

- [ ] **Step 5: Commit** — `git add core/src/services/tools && git commit -m "feat(t2a): normative services↔capabilities consistency validator (SR-1 §2.1 option b)"`

## Task 5: ToolRegistry — register, list, dispatch (+ `AppModule.handleToolCall`)

**Files:**
- Create: `core/src/services/tools/tool-registry.ts`, `core/src/services/tools/index.ts`
- Modify: `core/src/types/app-module.ts` (optional method after `handleScheduledJob`, line 104)
- Test: `core/src/services/tools/__tests__/tool-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import { ToolRegistry } from '../tool-registry.js';
import { toolManifest, validTool } from './fixtures.js';

const logger = pino({ level: 'silent' });

function moduleWithToolCall(impl?: AppModule['handleToolCall']): AppModule {
	return {
		init: async () => {},
		handleMessage: async () => ({ handled: false }),
		handleToolCall: impl ?? (async (name, args) => ({ echoed: { name, args } })),
	} as AppModule;
}

const manifest = () =>
	toolManifest({
		tools: [
			validTool(),
			validTool({
				name: 'echo:add-entry',
				riskClass: 'write',
				parameters: {
					type: 'object', required: ['text'],
					properties: { text: { type: 'string' } }, additionalProperties: false,
				},
			}),
		],
		declared: ['data:user'],
	});

describe('ToolRegistry', () => {
	it('registers valid tools and lists them with AG-3 defaults resolved', () => {
		const registry = new ToolRegistry({ logger });
		expect(registry.registerApp(manifest(), moduleWithToolCall())).toEqual([]);
		const tools = registry.listTools();
		expect(tools.map((t) => t.def.name).sort()).toEqual(['echo:add-entry', 'echo:list-log']);
		const write = registry.getTool('echo:add-entry');
		expect(write?.def.requiresConfirmation).toBe(true); // derived from write
		expect(write?.def.agentAllowed).toBe(false);
		expect(write?.def.costHint).toBe('low');
	});

	it('is all-or-nothing per app: one bad tool registers zero tools ON THE SAME registry (D4/Major 6)', () => {
		const registry = new ToolRegistry({ logger });
		const bad = toolManifest({
			tools: [validTool(), validTool({ name: 'echo:evil', requiresCapabilities: ['messaging:any-user'] })],
			declared: ['data:user'],
		});
		const violations = registry.registerApp(bad, moduleWithToolCall());
		expect(violations.length).toBeGreaterThan(0);
		// Assert the MUTATED registry — a partial-registration bug (the good tool
		// committed before the bad one is detected) would slip past a fresh-registry
		// check (Codex Major 6).
		expect(registry.listTools()).toEqual([]);
	});

	it('refuses to register a tool with an $async parameters schema, mutating registry stays empty (Critical 1 defense in depth)', () => {
		const registry = new ToolRegistry({ logger });
		const m = toolManifest({
			tools: [validTool({ parameters: { $async: true, type: 'object', additionalProperties: false } })],
			declared: ['data:user'],
		});
		const violations = registry.registerApp(m, moduleWithToolCall());
		expect(violations.map((v) => v.rule)).toContain('async-parameters-schema');
		expect(registry.listTools()).toEqual([]);
	});

	it('refuses an app that declares tools but exports no handleToolCall', () => {
		const registry = new ToolRegistry({ logger });
		const mod = moduleWithToolCall();
		(mod as { handleToolCall?: unknown }).handleToolCall = undefined;
		const violations = registry.registerApp(manifest(), mod);
		expect(violations.map((v) => v.rule)).toContain('module-missing-handle-tool-call');
		expect(registry.listTools()).toEqual([]);
	});

	it('refuses a duplicate tool name across registration calls', () => {
		const registry = new ToolRegistry({ logger });
		registry.registerApp(manifest(), moduleWithToolCall());
		const violations = registry.registerApp(manifest(), moduleWithToolCall());
		expect(violations.map((v) => v.rule)).toContain('duplicate-tool-name');
	});

	it('dispatches a valid call to module.handleToolCall with args and ctx', async () => {
		const calls: unknown[] = [];
		const registry = new ToolRegistry({ logger });
		registry.registerApp(manifest(), moduleWithToolCall(async (name, args, ctx) => {
			calls.push([name, args, ctx]);
			return 'done';
		}));
		const result = await registry.dispatch('echo:add-entry', { text: 'milk' }, { userId: 'u1', source: 'structured' });
		expect(result).toEqual({ ok: true, result: 'done' });
		expect(calls).toEqual([['echo:add-entry', { text: 'milk' }, { userId: 'u1', source: 'structured' }]]);
	});

	it('rejects args failing the tool parameters schema without invoking the handler', async () => {
		let invoked = false;
		const registry = new ToolRegistry({ logger });
		registry.registerApp(manifest(), moduleWithToolCall(async () => { invoked = true; return null; }));
		const result = await registry.dispatch('echo:add-entry', { wrong: 1 }, { userId: 'u1', source: 'structured' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/text/);
		expect(invoked).toBe(false);
	});

	it('returns ok:false for an unknown tool', async () => {
		const result = await new ToolRegistry({ logger }).dispatch('food:nope', {}, { userId: 'u1', source: 'structured' });
		expect(result).toEqual({ ok: false, error: 'Unknown tool "food:nope"' });
	});

	it('catches a throwing handler — never crashes the system', async () => {
		const registry = new ToolRegistry({ logger });
		registry.registerApp(manifest(), moduleWithToolCall(async () => { throw new Error('boom'); }));
		const result = await registry.dispatch('echo:list-log', {}, { userId: 'u1', source: 'structured' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/boom/);
	});

	it('listTools({ agentAllowed: true }) filters by resolved AG-3 metadata', () => {
		const registry = new ToolRegistry({ logger });
		registry.registerApp(
			toolManifest({ tools: [validTool({ agentAllowed: true })], declared: ['data:user'] }),
			moduleWithToolCall(),
		);
		expect(registry.listTools({ agentAllowed: true })).toHaveLength(1);
		expect(registry.listTools({ agentAllowed: false })).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/services/tools/__tests__/tool-registry.test.ts`. Expected: FAIL, module not found (and a type error on `handleToolCall` until app-module.ts is edited).

- [ ] **Step 3: Implement.** First `core/src/types/app-module.ts` — insert after `handleScheduledJob` (line 104):

```ts
	/**
	 * Called by the ToolRegistry (T2a) when the LLM tool loop invokes one of the
	 * tools this app declares in manifest.capabilities.tools[]. Mirrors the
	 * handleScheduledJob pattern: the manifest `handler` path is RESERVED Tier-C
	 * metadata (not consulted today); THIS method is the actual dispatch target.
	 * Arguments are already validated against the tool's parameters schema.
	 * Required when the manifest declares any tools (an app declaring tools without
	 * it is skipped at load — see AppRegistry.loadAll, T2a).
	 */
	handleToolCall?(
		toolName: string,
		args: Record<string, unknown>,
		ctx: ToolCallContext,
	): Promise<unknown>;
```

(with `import type { ToolCallContext } from './tool.js';` at the top). Then `core/src/services/tools/tool-registry.ts`:

```ts
/**
 * ToolRegistry (T2a): the runtime registry over manifest.capabilities.tools[].
 * Registration validates via ToolPolicy + consistency validator, resolves AG-3
 * defaults, and compiles each tool's parameters schema. Dispatch validates
 * arguments then routes to AppModule.handleToolCall. SDK-agnostic: T1's
 * completeWithTools loop consumes listTools() and adapts to the provider SDK.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { Logger } from 'pino';
import type { AppModule } from '../../types/app-module.js';
import type { AppManifest } from '../../types/manifest.js';
import type { RegisteredTool, ToolCallContext, ToolCallResult } from '../../types/tool.js';
import { resolveToolDefaults } from '../../types/tool.js';
import { validateServiceCapabilityConsistency } from './capability-consistency.js';
import type { ToolPolicyViolation } from './tool-policy.js';
import { validateAppTools } from './tool-policy.js';

export interface RegistrationViolation {
	rule: string;
	toolName?: string;
	message: string;
}

interface StoredTool extends RegisteredTool {
	module: AppModule;
	validateArgs: ValidateFunction;
}

export class ToolRegistry {
	private readonly tools = new Map<string, StoredTool>();
	private readonly logger: Logger;
	private readonly ajv = new Ajv2020.default({ strict: false });

	constructor(options: { logger: Logger }) {
		this.logger = options.logger;
	}

	/** All-or-nothing per app (D4). Returns [] on success. */
	registerApp(manifest: AppManifest, module: AppModule): RegistrationViolation[] {
		const defs = manifest.capabilities?.tools ?? [];
		if (defs.length === 0) return [];

		const violations: RegistrationViolation[] = [
			...(validateAppTools(manifest) as ToolPolicyViolation[]),
			...validateServiceCapabilityConsistency(manifest),
		];
		if (typeof module.handleToolCall !== 'function') {
			violations.push({ rule: 'module-missing-handle-tool-call',
				message: `App "${manifest.app.id}" declares tools but exports no handleToolCall()` });
		}
		for (const def of defs) {
			if (this.tools.has(def.name)) {
				violations.push({ rule: 'duplicate-tool-name', toolName: def.name,
					message: `Tool "${def.name}" is already registered` });
			}
		}
		if (violations.length > 0) {
			this.logger.error({ appId: manifest.app.id, violations },
				'Tool registration refused — zero tools registered for app');
			return violations;
		}

		for (const def of defs) {
			const resolved = resolveToolDefaults(def);
			this.tools.set(def.name, {
				appId: manifest.app.id,
				def: Object.freeze(resolved),
				module,
				validateArgs: this.ajv.compile(def.parameters),
			});
		}
		this.logger.info({ appId: manifest.app.id, count: defs.length },
			'Registered %d tool(s) for app %s', defs.length, manifest.app.id);
		return [];
	}

	listTools(filter?: { appId?: string; agentAllowed?: boolean }): RegisteredTool[] {
		return [...this.tools.values()]
			.filter((t) => filter?.appId === undefined || t.appId === filter.appId)
			.filter((t) => filter?.agentAllowed === undefined || t.def.agentAllowed === filter.agentAllowed)
			.map(({ appId, def }) => ({ appId, def }));
	}

	getTool(name: string): RegisteredTool | undefined {
		const stored = this.tools.get(name);
		return stored ? { appId: stored.appId, def: stored.def } : undefined;
	}

	async dispatch(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolCallResult> {
		const stored = this.tools.get(name);
		if (!stored) return { ok: false, error: `Unknown tool "${name}"` };

		// NB: `=== true`, not truthiness — an $async validator (rejected at
		// registration by ToolPolicy, but belt-and-suspenders here) returns a
		// Promise, which is truthy; treating anything but literal `true` as invalid
		// closes Codex Critical 1 at the dispatch site regardless of what compiled.
		if (typeof args !== 'object' || args === null || stored.validateArgs(args) !== true) {
			const detail = (stored.validateArgs.errors ?? [])
				.map((e) => `${e.instancePath || '/'}: ${e.message}`).join('; ');
			return { ok: false, error: `Arguments for "${name}" failed schema validation: ${detail || 'not an object'}` };
		}

		try {
			// biome-ignore lint/style/noNonNullAssertion: registration requires handleToolCall
			const result = await stored.module.handleToolCall!(name, args as Record<string, unknown>, ctx);
			return { ok: true, result };
		} catch (error) {
			this.logger.error({ toolName: name, appId: stored.appId, error }, 'Tool handler threw');
			return { ok: false, error: `Tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
}
```

And `core/src/services/tools/index.ts`:

```ts
export { ToolRegistry } from './tool-registry.js';
export type { RegistrationViolation } from './tool-registry.js';
export { validateAppTools } from './tool-policy.js';
export type { ToolPolicyViolation } from './tool-policy.js';
export { validateServiceCapabilityConsistency } from './capability-consistency.js';
export type { ConsistencyViolation } from './capability-consistency.js';
```

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run core/src/services/tools` — all four test files green.

- [ ] **Step 5: Commit** — `git add core/src/services/tools core/src/types/app-module.ts && git commit -m "feat(t2a): ToolRegistry with validated dispatch via AppModule.handleToolCall"`

## Task 6: Load-time enforcement — loader + registry skip apps whose tool surface lies (D3, Major 4)

**Files:**
- Modify: `core/src/services/app-registry/loader.ts:149-182` (`loadManifest` — manifest-only semantic checks)
- Modify: `core/src/services/app-registry/index.ts:62-87` (`loadAll` — module-dependent check: tools declared but no `handleToolCall`)
- Test: `core/src/services/app-registry/__tests__/loader.test.ts`, `core/src/services/app-registry/__tests__/registry.test.ts`

Two layers because `loadManifest` (loader) cannot see the module. `loadManifest` catches everything decidable from the manifest alone; `loadAll` (registry) catches the one module-dependent violation — a declared tool surface with no callable entrypoint — after `importModule` and **before** `init`, so a broken app never initializes (Codex Major 4). The registry's own `registerApp` check (Task 5) stays as defense in depth for the compose-runtime path.

- [ ] **Step 1a: Write the failing loader tests** (follow the file's existing temp-dir + manifest-writing pattern; add a describe block)

```ts
describe('loadManifest tool-surface enforcement (T2a)', () => {
	it('returns null (skips app) when a tool exceeds the declared capability set', async () => {
		// Write a manifest.yaml whose tools[0].requiresCapabilities = ['messaging:any-user']
		// while capabilities.declared = ['data:user'] — schema-valid, semantically hostile.
		const manifest = await loader.loadManifest(appDirWithHostileTool);
		expect(manifest).toBeNull();
	});

	it('returns null when a declared capability has no backing service (consistency drift)', async () => {
		// capabilities.declared: ['messaging:any-user'], requirements.services: ['data-store']
		const manifest = await loader.loadManifest(appDirWithDriftManifest);
		expect(manifest).toBeNull();
	});

	it('still loads a legacy manifest with no capability surface', async () => {
		const manifest = await loader.loadManifest(legacyAppDir);
		expect(manifest).not.toBeNull();
	});

	it('loads a manifest whose tool surface is fully consistent', async () => {
		const manifest = await loader.loadManifest(appDirWithValidTool);
		expect(manifest?.capabilities?.tools).toHaveLength(1);
	});
});
```

(Each fixture dir is created in the test with the same `mkdtemp` + `writeFile('manifest.yaml', yaml)` helpers the existing loader tests use — reuse the file's helper if present, else copy its established pattern.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/services/app-registry/__tests__/loader.test.ts`. Expected: the two `toBeNull()` tests FAIL (schema alone accepts the hostile manifests).

- [ ] **Step 3: Implement** — in `loadManifest` after the schema validation block (line 158) and before the scope-path warnings:

```ts
		const semanticViolations = [
			...validateAppTools(result.manifest),
			...validateServiceCapabilityConsistency(result.manifest),
		];
		if (semanticViolations.length > 0) {
			this.logger.error(
				{ path: manifestPath, violations: semanticViolations },
				'Manifest tool/capability surface is inconsistent — skipping app',
			);
			return null;
		}
```

with imports from `'../tools/index.js'` (from inside `services/app-registry/`, `'../../services/tools/index.js'` would be wrong).

- [ ] **Step 4: Write the failing registry test** (Major 4) in `registry.test.ts`, following its existing `loadAll` + temp-app-dir harness:

```ts
describe('loadAll — tools declared without handleToolCall (T2a, Major 4)', () => {
	it('skips an app that declares capabilities.tools but whose module has no handleToolCall', async () => {
		// Fixture app dir: manifest with one valid, fully-consistent tool; module
		// exports init + handleMessage but NO handleToolCall. init() must NOT run.
		let initRan = false;
		const registry = buildRegistryOverFixture('tooldecl-no-handler', { onInit: () => { initRan = true; } });
		await registry.loadAll(serviceFactory);
		expect(registry.getApp('tooldecl-no-handler')).toBeUndefined();
		expect(initRan).toBe(false); // skipped BEFORE init (Major 4)
	});

	it('loads an app that declares tools AND exports handleToolCall', async () => {
		const registry = buildRegistryOverFixture('tooldecl-with-handler');
		await registry.loadAll(serviceFactory);
		expect(registry.getApp('tooldecl-with-handler')).toBeDefined();
	});
});
```

(`buildRegistryOverFixture` / `serviceFactory` stand in for the file's existing registry-test scaffolding — reuse its real helpers; the assertion that `init` did not run is the load-order guarantee Major 4 is about.)

- [ ] **Step 5: Implement the registry check** in `AppRegistry.loadAll` (`index.ts`), after the duplicate-app-id guard (line 76) and **before** `serviceFactory` / `module.init` (lines 79–82):

```ts
			// T2a (Major 4): an app declaring a tool surface with no callable
			// entrypoint cannot serve those tools — skip it fail-loud, before init.
			if ((manifest.capabilities?.tools?.length ?? 0) > 0 &&
				typeof module.handleToolCall !== 'function') {
				this.logger.error(
					{ appId: manifest.app.id, appDir },
					'App declares capabilities.tools but exports no handleToolCall() — skipping',
				);
				skipped.push({ dir: appDir, reason: 'tools declared without handleToolCall' });
				continue;
			}
```

- [ ] **Step 6: Run to verify pass** — `pnpm vitest run core/src/services/app-registry` (loader + registry suites green).

- [ ] **Step 7: Commit** — `git add core/src/services/app-registry && git commit -m "feat(t2a): loader + registry skip apps with inconsistent or non-callable tool surfaces (fail-loud, before init)"`

## Task 7: Install-time enforcement + truthful permission prompt

**Files:**
- Modify: `core/src/services/app-installer/index.ts` (`InstallError.type` union lines 32–43; `PermissionSummary` lines 47–52; `buildPermissionSummary` line 138; `planInstall` after line 237)
- Test: `core/src/services/app-installer/__tests__/` (extend the existing planInstall test file; same fixture style)

- [ ] **Step 1: Write the failing tests**

```ts
describe('planInstall tool-surface enforcement (T2a)', () => {
	it('rejects an app whose tool exceeds its capability set with TOOL_POLICY_VIOLATION', async () => {
		const result = await planInstall(optionsForFixtureRepo('hostile-tool-app'));
		expect(result.success).toBe(false);
		expect(result.errors.map((e) => e.type)).toContain('TOOL_POLICY_VIOLATION');
		expect(result.errors[0].message).toMatch(/messaging:any-user/);
	});

	it('rejects services↔capabilities drift with TOOL_POLICY_VIOLATION', async () => {
		const result = await planInstall(optionsForFixtureRepo('drift-app'));
		expect(result.errors.map((e) => e.type)).toContain('TOOL_POLICY_VIOLATION');
	});

	it('surfaces declared tools in the permission summary with risk metadata', async () => {
		const result = await planInstall(optionsForFixtureRepo('valid-tool-app'));
		expect(result.success).toBe(true);
		expect(result.permissionSummary?.tools).toEqual([
			{ name: 'echo:list-log', riskClass: 'read', requiresConfirmation: false, agentAllowed: false },
		]);
	});

	it('permission summary tools is empty for legacy apps', async () => {
		const result = await planInstall(optionsForFixtureRepo('legacy-app'));
		expect(result.permissionSummary?.tools).toEqual([]);
	});
});
```

(`optionsForFixtureRepo` = whatever local-git-fixture helper the existing installer tests use; if they clone from a temp git repo, add the three manifest fixtures there. Match the surrounding file's idiom exactly rather than inventing a new harness.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/services/app-installer`. Expected: FAIL (`TOOL_POLICY_VIOLATION` not in the union / `tools` undefined on summary).

- [ ] **Step 3: Implement.**
  - Add `'TOOL_POLICY_VIOLATION'` to `InstallError['type']`.
  - Extend `PermissionSummary` with `tools: { name: string; riskClass: string; requiresConfirmation: boolean; agentAllowed: boolean }[]`.
  - In `buildPermissionSummary`, map `manifest.capabilities?.tools ?? []` through `resolveToolDefaults` and project the four prompt-relevant fields (the operator sees the tool surface + risk before committing the install — SR-1's "truthful permission prompt").
  - In `planInstall`, after the `validateManifest` success branch (line 237):

```ts
	const toolViolations = [
		...validateAppTools(manifest),
		...validateServiceCapabilityConsistency(manifest),
	];
	if (toolViolations.length > 0) {
		return {
			success: false,
			errors: toolViolations.map((v) => ({
				type: 'TOOL_POLICY_VIOLATION' as const,
				message: v.message,
				details: v.rule,
			})),
		};
	}
```

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run core/src/services/app-installer`, green.

- [ ] **Step 5: Commit** — `git add core/src/services/app-installer && git commit -m "feat(t2a): install-time tool policy gate + tools in the permission summary"`

## Task 8: compose-runtime wiring — build the registry in Phase C

**Files:**
- Modify: `core/src/compose-runtime.ts` (Phase C, after schedule registration ~line 945; add `toolRegistry` to the composed-runtime return type ~line 198)
- Test: `core/src/services/tools/__tests__/registry-wiring.integration.test.ts`

Rather than extending the heavyweight `compose-runtime.smoke.integration.test.ts`, test the seam in isolation the way `scheduler/per-user-dispatch` is tested: a helper that takes registry entries and a ToolRegistry.

- [ ] **Step 1: Write the failing test**

```ts
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { registerAppTools } from '../register-app-tools.js';
import { ToolRegistry } from '../tool-registry.js';
import { toolManifest, validTool } from './fixtures.js';

const logger = pino({ level: 'silent' });
const entry = (manifest: ReturnType<typeof toolManifest>, hasHandler = true) => ({
	manifest,
	appDir: '/tmp/x',
	module: {
		init: async () => {},
		handleMessage: async () => ({ handled: false }),
		...(hasHandler ? { handleToolCall: async () => null } : {}),
	},
});

describe('registerAppTools (compose-runtime seam)', () => {
	it('registers tools for every app that declares them and reports the total', () => {
		const registry = new ToolRegistry({ logger });
		const total = registerAppTools(
			registry,
			[entry(toolManifest({ tools: [validTool()], declared: ['data:user'] })), entry(toolManifest({}))],
			logger,
		);
		expect(total).toBe(1);
		expect(registry.listTools()).toHaveLength(1);
	});

	it('a violating app registers zero tools and does not prevent other apps registering', () => {
		const registry = new ToolRegistry({ logger });
		const bad = toolManifest({ tools: [validTool({ requiresCapabilities: ['messaging:any-user'] })], declared: [] });
		const total = registerAppTools(
			registry,
			[entry(bad), entry(toolManifest({ tools: [validTool()], declared: ['data:user'] }))],
			logger,
		);
		expect(total).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run core/src/services/tools/__tests__/registry-wiring.integration.test.ts`. Expected: FAIL, `register-app-tools.js` not found.

- [ ] **Step 3: Implement** `core/src/services/tools/register-app-tools.ts`:

```ts
import type { Logger } from 'pino';
import type { RegisteredApp } from '../app-registry/index.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * Phase C wiring seam: register every loaded app's manifest tools.
 * Violations are logged by the registry (never crash the system); a violating
 * app simply contributes zero tools. Returns the total registered count.
 */
export function registerAppTools(
	registry: ToolRegistry,
	entries: Pick<RegisteredApp, 'manifest' | 'module'>[],
	logger: Logger,
): number {
	let total = 0;
	for (const entry of entries) {
		const violations = registry.registerApp(entry.manifest, entry.module);
		if (violations.length === 0) {
			total += entry.manifest.capabilities?.tools?.length ?? 0;
		}
	}
	logger.info({ total }, 'Tool registry: %d tool(s) registered', total);
	return total;
}
```

Then in `compose-runtime.ts`, directly after the schedule-registration loop (following the `// 9b.` block that ends ~line 945):

```ts
	// 9c. Build the ToolRegistry from manifest.capabilities.tools[] (T2a).
	const toolRegistry = new ToolRegistry({
		logger: createChildLogger(logger, { service: 'tool-registry' }),
	});
	registerAppTools(toolRegistry, registry.getAll(), logger);
```

and add `toolRegistry` to the composed-runtime return object + its interface (~line 198). Export nothing to `CoreServices` (D8).

- [ ] **Step 4: Run to verify pass** — seam test green, then the full core project: `pnpm vitest run core` (expect zero failures; the boot smoke integration test must stay green with legacy apps registering 0 tools).

- [ ] **Step 5: Commit** — `git add core/src && git commit -m "feat(t2a): compose-runtime builds the ToolRegistry in Phase C"`

## Task 9: URS entries, traceability, docs reconcile

**Files:**
- Modify: `docs/urs.md` (new `REQ-TOOL-*` area + traceability matrix rows)
- Modify: `docs/open-items.md` (row #6: mark T2a complete with date; note AG-3 rider shipped; move the SR-1 §8 Q1 direction-2 remainder + Vercel adapter to Deferred)
- Modify: `docs/implementation-phases.md` (T2a phase write-up per its established format)

- [ ] **Step 1:** Add URS entries (follow the `### REQ-*` block format at `docs/urs.md`, e.g. the REQ-GUI-SURFACE blocks near line 12412), each citing the tests from Tasks 1–8:
  - **REQ-TOOL-001** — Apps declare tools exclusively via `manifest.capabilities.tools[]`, one object per tool (SR-1 §3 single surface); schema-validated at install and load.
  - **REQ-TOOL-002** — Every tool carries a `riskClass` at authoring; a manifest with an unclassified tool is rejected (AG-3).
  - **REQ-TOOL-003** — `agentAllowed`/`requiresConfirmation`/`costHint` are defaulted at read (`false` / derived-from-riskClass / `low`); an external-effect tool cannot opt out of confirmation.
  - **REQ-TOOL-004** — A tool whose `requiresCapabilities` exceed `capabilities.declared[]` is refused at install (TOOL_POLICY_VIOLATION) and at load (app skipped).
  - **REQ-TOOL-005** — The services↔capabilities consistency validator enforces the SR-1 §2.1 mapping (direction 1 always; direction 2 for capability-surface adopters); legacy manifests pass unchanged.
  - **REQ-TOOL-006** — Tool dispatch validates arguments against the tool's `parameters` schema before invoking `AppModule.handleToolCall`; handler failures are caught and reported, never crash the system.
- [ ] **Step 2:** Update the traceability matrix with the new test citations.
- [ ] **Step 3:** Reconcile `docs/open-items.md` row #6 and add the deferred entries listed in §7 below. Add the `docs/implementation-phases.md` phase entry.
- [ ] **Step 4: Commit** — `git add docs && git commit -m "docs(t2a): REQ-TOOL-001..006 + traceability + phase reconcile"`

## Task 10: Full verification + smoke

See §6. Run everything, then execute the smoke procedure before calling the phase done.

---

## 5. Hostile-input test matrix (consolidated)

The state machine under test is: *hostile manifest → schema gate → policy gate → consistency gate → registry → dispatch*. Every row names the layer that must catch it and the test that proves it.

| # | Hostile input | Expected behavior | Caught by | Test |
|---|---|---|---|---|
| 1 | Tool `requiresCapabilities` ⊄ `capabilities.declared[]` (tool exceeds app capability set) | Install: `TOOL_POLICY_VIOLATION`; load: app skipped | ToolPolicy `capability-exceeds-declared` | Task 3 / 6 / 7 |
| 2 | Tool missing `riskClass` (unclassified tool) | Schema-invalid at install AND load — fails at authoring per SR-1 §3.3 | Ajv `required` | Task 1 |
| 3 | Tool missing `parameters` | Schema-invalid (explicit empty schema required) | Ajv `required` | Task 1 |
| 4 | Unknown capability string (`shell:exec`) in `declared[]` or `requiresCapabilities[]` | Schema-invalid (closed enum + `secrets:` pattern) | Ajv `anyOf` | Task 1 |
| 5 | `riskClass` outside the three-value ladder | Schema-invalid | Ajv `enum` | Task 1 |
| 6 | Undeclared tool at runtime (LLM hallucinates `food:nope`) | `dispatch` → `{ok:false, error:'Unknown tool …'}`, no handler invoked | ToolRegistry | Task 5 |
| 7 | Drift: `messaging:any-user` declared, `telegram` absent from `requirements.services[]` | Install rejected / app skipped at load | Consistency dir-1 | Task 4 / 6 / 7 |
| 8 | Drift: `scheduler` or `data-store` service injected, capability-surface adopter declares no covering capability (Critical 2 — data has no baseline) | Rejected (direction 2, opt-in scope) | Consistency dir-2 | Task 4 |
| 9 | Legacy manifest (no `declared`/`tools`/`net` key) with full `services[]` | Passes untouched — zero-impact migration | Consistency legacy passthrough | Task 4, bundled-manifests |
| 10 | `secrets:ghost` declared / required with no matching `external_apis[].id` | Rejected | Consistency + ToolPolicy | Task 3 / 4 |
| 11 | `capabilities.net` present without `net:fetch` declared | Rejected | Consistency `net-policy-without-net-fetch` | Task 4 |
| 12 | Tool name not prefixed with the app id (namespace squatting: `food:*` inside echo) | Rejected | ToolPolicy `name-prefix-mismatch` | Task 3 |
| 13 | Duplicate tool name (within an app or across apps) | Rejected; second registration refused | ToolPolicy / ToolRegistry | Task 3 / 5 |
| 14 | Handler path `../../evil.js`, `/etc/passwd`, embedded null byte | Rejected | ToolPolicy `unsafe-handler-path` | Task 3 |
| 15 | `requiresConfirmation: false` on `write` OR `external-effect` | Rejected — doctrine item 4 covers both, not loosenable (Major 5) | ToolPolicy `confirmation-not-loosenable` (D6) | Task 3 |
| 16 | `parameters` that is schema-shaped garbage (`{"type":"not-a-type"}`) | Rejected at registration (compile failure) | ToolPolicy (D7) | Task 3 |
| 17 | Model-generated args failing the parameters schema | `{ok:false}` with Ajv detail; handler never invoked | ToolRegistry dispatch | Task 5 |
| 18 | Args that are not an object (`null`, `"str"`) | `{ok:false}` | ToolRegistry dispatch | Task 5 |
| 19 | Handler throws | Caught, logged, `{ok:false}` — never crash the system | ToolRegistry dispatch | Task 5 |
| 20 | App declares tools but exports no `handleToolCall` | App SKIPPED at load before `init` (Major 4); registry registration also refuses (defense in depth) | AppRegistry.loadAll + ToolRegistry `module-missing-handle-tool-call` | Task 5 / 6 |
| 21 | Unexpected extra property on a tool object | Schema-invalid (`additionalProperties: false`) | Ajv | Task 1 |
| 22 | One bad tool among good ones | Zero tools for that app (all-or-nothing, D4) asserted on the MUTATED registry (Major 6); other apps unaffected | ToolRegistry / wiring seam | Task 5 / 8 |
| 23 | `$async: true` parameters schema (async validator returns a truthy Promise → sync `!validate()` guard bypassed, invalid args reach handler) | Rejected at policy + registration; dispatch guard uses `!== true` as third defense (Critical 1) | ToolPolicy `async-parameters-schema` + registry + dispatch | Task 3 / 5 |
| 24 | Opt-in evasion: explicit empty `tools: []` / `declared: []` with an uncovered privileged service | Counts as adoption (property presence) → direction 2 fires (Major 3) | Consistency `Object.hasOwn` opt-in | Task 4 |

## 6. Verification (planner deliverable)

**Automated (run all; expected: zero failures — PAS zero-failing-tests policy):**

```
pnpm vitest run core/src/services/tools          # the new suites
pnpm vitest run core/src/schemas                 # schema + bundled legacy manifests
pnpm vitest run core/src/services/app-registry   # loader enforcement
pnpm vitest run core/src/services/app-installer  # install gate
pnpm test                                        # full root suite (vitest run, projects core/apps/scripts)
pnpm lint                                        # Biome — zero errors
pnpm build                                       # tsc across workspaces (pre-push hook parity)
```

**Smoke (operator-runnable, expected outputs stated):**

1. **Legacy zero-impact boot:** `pnpm dev` → within startup logs expect `App registry: loaded 3 app(s), skipped 0` (echo, notes, food unchanged) **and** `Tool registry: 0 tool(s) registered`. Ctrl-C. *Pass = both lines; fail = any app skipped or the tool-registry line missing.*
2. **Positive registration:** temporarily (uncommitted) add to `apps/echo/manifest.yaml`:
   ```yaml
   capabilities:
     tools:
       - name: "echo:list-log"
         description: "List echo log entries."
         parameters: { type: object, additionalProperties: false }
         handler: "tools/list-log.ts"
         requiresCapabilities: ["data:user"]
         riskClass: read
     declared: ["data:user"]
   ```
   (merge into the existing `capabilities:` block) and add a no-op `handleToolCall` to `apps/echo/index.ts` returning `[]`. `pnpm dev` → expect `Registered 1 tool(s) for app echo` and `Tool registry: 1 tool(s) registered`.
3. **Negative — capability ceiling:** change `requiresCapabilities` to `["messaging:any-user"]` (leave `declared` as-is). `pnpm dev` → expect `Manifest tool/capability surface is inconsistent — skipping app` naming rule `capability-exceeds-declared`, and `loaded 2 app(s), skipped 1`. *This is the SR-1 headline guarantee observed live.*
4. **Negative — unclassified tool:** delete the `riskClass` line. `pnpm dev` → expect `Invalid app manifest — skipping` with an error string containing `riskClass` (schema layer, before policy).
5. **Restore:** `git checkout -- apps/echo/manifest.yaml apps/echo/index.ts` (or `apps/echo/src/index.ts` — whichever was touched); re-run step 1 to confirm the baseline again.

## 7. Deferred work (must land in `docs/open-items.md` before the session ends)

- **Vercel AI SDK tool-set adapter** (`RegisteredTool[]` → provider `tools` param) — owned by T1 integration / T2c round-trip, once T1's `completeWithTools` exists in the tree.
- **Direction-2 consistency enforcement for ALL manifests** (not just capability-surface adopters) + the preferred migration of injection onto `capabilities.declared[]` — SR-1 Tier A implementation / SR-3 API-stability cut (SR-1 §8 Q1).
- **`net.allow` runtime enforcement** — Tier B/C (SR-1 §2.1); T2a records it truthfully only.
- **Runtime confirmation gate + pending-confirmation store** (actually rendering tool arguments to the user and gating execution) — T2b (Master Execution Order row 7). T2a only sets the `requiresConfirmation` metadata, now clamped to doctrine (D6). *(This replaces the earlier — withdrawn — "defer the write floor to AG-2" deferral, which was the wrong resolution per Codex Major 5.)*
- **`requiresCapabilities` runtime narrowing at dispatch** (injecting a capability-scoped service view per tool call) — SR-1 Tier A; T2a validates the declaration only.
- **Tool trace / confirmation store / PII redaction / attachment store** — T2b/T2c by design (Master Execution Order rows 7–8).

## 8. Remaining risks to watch during implementation

*(The first Codex high-effort review — 2 Critical + 4 Major + 1 Minor — is resolved; see §9. These are the residual watch-items for the implementer / a second review.)*

1. **`handler` declared-but-unused (Codex Minor 7, accepted-with-documentation):** the field is now explicitly RESERVED Tier-C metadata (D1), not a dispatch target, so no drift with `handleToolCall` is *claimed* — but a stale `handler` path can still rot silently since nothing reads it at T2a. Left as-is (matching the `schedule.handler` precedent, which is equally unchecked); a Tier-C phase that starts consuming `handler` must add existence + drift checking then. Flag if the implementer would rather add a shape/existence check now.
2. **Two Ajv instances with different strictness:** the strict manifest schema (`validate-manifest.ts`) vs. `strict: false` for app-authored parameter schemas (ToolPolicy + registry). Deliberate — hostile author schemas need compilability, not our conventions. Both now reject `$async` (Critical 1). Keep the two `strict: false` instances (ToolPolicy compile-check and the registry's dispatch validator) in lockstep on options; a divergence could let a schema pass policy but compile differently for dispatch.
3. **`agentAllowed` cross-app filtering (forward-looking):** T2a's `listTools({ agentAllowed })` filter is unused by the structured path and untested against real AG-2 semantics. When AG-2 lands it must confirm the filter composes with per-user/household policy (a `read` tool that returns another user's data should be blocked by *capability*, not merely un-`agentAllowed`) — SR-1 §8 Q5.

## Deliverables

- [ ] Manifest schema surface: `capabilities.declared` / `net` / `tools` merged into `core/src/schemas/app-manifest.schema.json`; legacy bundled manifests still green (Task 1)
- [ ] `core/src/types/tool.ts` + `ManifestCapabilities` extension + `resolveToolDefaults` (Task 2)
- [ ] ToolPolicy with capability-ceiling, naming, handler-safety, doctrine-clamp, schema-compilability rules (Task 3)
- [ ] SR-1 §2.1 services↔capabilities consistency validator, landing in T2a per §8 Q1 (Task 4)
- [ ] ToolRegistry (register/list/get/dispatch) + `AppModule.handleToolCall` (Task 5)
- [ ] Load-time app skip on semantic violations (Task 6)
- [ ] Install-time `TOOL_POLICY_VIOLATION` + tools in the permission summary (Task 7)
- [ ] compose-runtime Phase C wiring (Task 8)
- [ ] URS REQ-TOOL-001..006 + traceability + open-items/implementation-phases reconcile (Task 9)
- [ ] Full suite + lint + build green; 5-step smoke passed with documented expected outputs (Task 10)

## Skills invoked

- `superpowers:writing-plans` (this document)
- Execution: `superpowers:subagent-driven-development` or `superpowers:executing-plans`; per-task `superpowers:test-driven-development`; `superpowers:requesting-code-review` before merge.

## Self-review notes (writing-plans checklist)

- **Spec coverage:** SR-1 §2.1 (validator — Task 4), §3.2 (all ToolDef field groups — Tasks 1–3, 5), §3.3 (consumer split — contract §3 + D8), §8 Q1 (validator at T2a — D2), Q5 (read default kept, flagged), Q6 (legacy passthrough — Task 4 + bundled-manifests). AG-3 four fields: Tasks 1–3. Open-items row 6 deliverable list (`types/tool.ts`, `capabilities.tools[]`, ToolRegistry, ToolPolicy, install/load validation): Tasks 2, 1, 5, 3, 6–7 respectively.
- **Placeholder scan:** no TBDs; every code step shows the code; fixture helpers defined once and referenced.
- **Type consistency:** `ManifestToolDef`/`ResolvedToolDef`/`RegisteredTool`/`ToolCallContext` names match across Tasks 2, 5, 8; violation `rule` strings in tests match the implementations in Tasks 3–5 (note: `confirmation-not-loosenable` replaced the earlier `external-effect-confirmation-not-loosenable` after Codex Major 5 — checked across §contract, D6, Task 3 union + tests, matrix row 15).

## 9. Codex review disposition (high-effort review #1, 2026-07-08)

Verdict was "needs rework": 2 Critical + 4 Major + 1 Minor. All seven verified against SR-1 + the code and accepted (no push-back). How each was closed:

| # | Finding | Verification | Resolution |
|---|---|---|---|
| Critical 1 | `$async` parameter schema bypasses dispatch validation (async validator returns a truthy Promise) | **Reproduced** against the project's ajv 8.18.0: `validator.$async === true`, return is a Promise, `!validate(args) === false` → invalid args pass; the thrown `ValidationError` also surfaces as an unhandled rejection | D9 + rule `async-parameters-schema` in ToolPolicy (Task 3), registry re-check (Task 5), and dispatch `!== true` guard (Task 5) — three independent closes; matrix row 23 + tests |
| Critical 2 | `data-store` wrongly exempt from direction-2 consistency | SR-1 §2.1 confirms data defaults to "No filesystem/data access" — only reply-scoped Telegram is the implicit baseline | Added `'data-store': ['data:user','data:shared']` to `PRIVILEGED_SERVICE_COVERING_CAPS` (Task 4); D2 + mapping table column 3 updated; tests for data-store-without-data:\* and telegram-alone-ok |
| Major 3 | Opt-in trigger length-based, so `tools: []` / `declared: []` evade direction 2 | `[]` is schema-legal; length check misses it | Opt-in by property **presence** (`Object.hasOwn`) in Task 4; tests for `tools: []` and `declared: []`; matrix row 24 |
| Major 4 | Apps declaring tools but missing `handleToolCall` not skipped at LOAD | `loadManifest` can't see the module; Task 5's registry check runs only after import+init | Added a skip in `AppRegistry.loadAll` between `importModule` and `init` (Task 6, new steps 4–5); registry check kept as defense in depth; matrix row 20 |
| Major 5 | Write tools can opt out of confirmation, contradicting doctrine | Doctrine item 4 (`agentic-autonomy-doctrine.md:34`) says BOTH mutating and external-effect require confirmation | **Withdrew** the defer-to-AG-2 position; D6 now clamps `requiresConfirmation: false` on BOTH `write` and `external-effect` (rule renamed `confirmation-not-loosenable`); Task 3 tests + matrix row 15 |
| Major 6 | All-or-nothing test asserted a FRESH registry, so a partial-registration bug would pass | Correct — the test built a second `ToolRegistry` | Task 5 test now stores the registry and asserts `registry.listTools()` empty after the violating call |
| Minor 7 | `handler` required-but-unused overstated as invocation metadata | Accurate — nothing reads it at T2a | D1 + the `ManifestToolDef.handler` doc + the `handleToolCall` doc reframed as RESERVED Tier-C metadata; residual drift risk named in §8.1 |
