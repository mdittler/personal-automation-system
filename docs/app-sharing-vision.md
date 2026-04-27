# App Sharing Vision

| Field | Value |
|---|---|
| **Purpose** | Design document for shareable apps, distribution, trust model, and chatbot fallback |
| **Status** | Draft — requirements documented, implementation in Phases 16-18 |
| **Last Updated** | 2026-03-11 |

---

## Why Shareable Apps

PAS is built as a platform, not a monolith. The infrastructure (routing, LLM, data storage, scheduling, events) is general-purpose. Apps are plugins that implement specific functionality via the manifest contract.

Friends want to join and build their own apps. For this to work safely:
- Apps must be distributable as standalone packages
- The infrastructure must mediate all sensitive access (LLM, data, Telegram)
- Installing someone else's app shouldn't require trusting them with your API keys or data
- Incompatibilities between an app and the infrastructure should be caught at install time, not at runtime

---

## App Package Structure

A distributable PAS app is a git repo containing:

```
my-app/
  manifest.yaml          # App identity, capabilities, requirements (validated against JSON Schema)
  package.json           # npm package with dependencies
  src/
    index.ts             # Exports AppModule (init, handleMessage, etc.)
    ...                  # App implementation
  dist/                  # Compiled JS (built before distribution or built on install)
  __tests__/             # Tests (optional but encouraged)
```

**Required exports from `src/index.ts`:**
- `init(services: CoreServices): Promise<void>` — receive infrastructure services
- `handleMessage(ctx: MessageContext): Promise<void>` — handle routed text messages
- Optional: `handlePhoto`, `handleCommand`, `shutdown`

**Key constraint:** Apps must not import LLM SDKs directly (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama`). All LLM access goes through `CoreServices.llm`. This is enforced at install time via static analysis.

---

## Installation Flow

```
pas install <git-url>
  |
  +-- Clone repo into apps/
  |
  +-- Validate manifest.yaml against JSON Schema
  |     - Missing required fields? → error with details
  |
  +-- Check pas_core_version compatibility
  |     - App needs newer CoreServices? → error: "App requires v2.0, this instance runs v1.3"
  |     - Specific missing features reported when possible
  |
  +-- Static analysis scan
  |     - Scan source for banned imports (LLM SDKs, raw fs/net/child_process)
  |     - Violations reported as clear error messages:
  |       "my-app/src/helper.ts:14 imports '@anthropic-ai/sdk' directly.
  |        Apps must use CoreServices.llm for all LLM access."
  |
  +-- Show permission summary to user
  |     - Services: telegram, llm, data-store
  |     - Data scopes: user/my-app/* (read-write), shared/notes/* (read)
  |     - External APIs: WEATHER_API_KEY
  |     - User approves or cancels
  |
  +-- Install npm dependencies
  |
  +-- Register app in app registry
  |
  +-- Done — app loaded on next restart (or hot-reload if supported)
```

---

## Static Analysis Details

**Banned import patterns** (checked against app source files):

| Pattern | Reason |
|---------|--------|
| `@anthropic-ai/sdk` | LLM must go through CoreServices.llm |
| `openai` | LLM must go through CoreServices.llm |
| `@google/genai` | LLM must go through CoreServices.llm |
| `ollama` | LLM must go through CoreServices.llm |
| `child_process` | Arbitrary command execution |
| `node:child_process` | Arbitrary command execution |

**Not banned** (but documented as a known limitation):
- `fs` / `node:fs` — apps could bypass `ScopedStore`, but static analysis would produce too many false positives since legitimate file operations exist. Runtime scoping via `ScopedStore` is the enforcement layer.
- `net` / `node:net` — apps making their own network calls (e.g., to external APIs they declared) is legitimate. The manifest's `external_apis` section documents what they need.

**Error message format:**
```
ERROR: App "my-app" failed validation:

  [BANNED_IMPORT] src/helper.ts:14
    imports '@anthropic-ai/sdk' directly.
    Apps must use CoreServices.llm for all LLM access.

  [INCOMPATIBLE] pas_core_version ">=2.0.0" not satisfied
    This PAS instance runs CoreServices v1.3.0.
    App may use features not available in this version.

Install cancelled. Fix the issues above and try again.
```

---

## CoreServices API Versioning

- CoreServices interface (`core/src/types/app-module.ts`) is versioned with semver
- **Breaking changes** (major version bump): removing a service, changing a method signature, removing a method
- **Additions** (minor version bump): new optional services, new methods on existing services
- Apps declare compatibility: `pas_core_version: ">=1.0.0 <2.0.0"` in manifest
- The installer checks this before proceeding
- Version is defined in `core/package.json` and exposed at runtime

---

## Trust Model

### What PAS Enforces

| Layer | Mechanism | Enforcement |
|-------|-----------|-------------|
| Service access | Dependency injection | Runtime — undeclared services are `undefined` |
| Data access | ScopedStore | Runtime — path traversal blocked, scoped to declared paths |
| LLM access | CoreServices.llm only | Install-time (static analysis) + runtime (DI) |
| Cost control | LLMGuard (Phase 13) | Runtime — per-app rate limits and monthly cost caps |
| Manifest validity | JSON Schema validation | Install-time — invalid manifests rejected |
| Banned imports | Static analysis | Install-time — violations reported as errors |
| Compatibility | pas_core_version check | Install-time — incompatibilities reported |

### What PAS Does NOT Enforce

- **No runtime sandbox.** Apps run in the same Node.js process as core. A malicious app could access `process.env`, use raw `fs`, open network connections, or crash the process.
- **Static analysis is not a security jail.** It catches accidental violations and honest mistakes. A determined attacker could obfuscate imports or use `eval()`.
- **No code signing yet.** There's no cryptographic proof that an app hasn't been tampered with.

This is documented transparently. The trust model is: "we verify the manifest and scan for obvious violations, but ultimately you're running someone else's code in your process. Only install apps from people you trust."

### Trust Levels (Future)

| Level | Meaning |
|-------|---------|
| `built-in` | Ships with PAS. Maintained by the project. |
| `reviewed` | Community-reviewed. Source audited. Signed. |
| `community` | Unreviewed. Use at own risk. |

---

## Chatbot Fallback Design

### Current Behavior
When no app matches a message (routing priority steps 1-3 all miss):
- Message timestamped and appended to daily notes file
- User gets: "Noted — saved to your daily notes."

### Planned Behavior (Phase 16)
When no app matches:
- Route to a built-in **chatbot app** — a full conversational AI
- The chatbot can discuss **any topic** (not limited to installed apps)
- Uses `LLMService` (standard tier) + `ContextStore` for personalized responses
- Daily notes append preserved as a side effect (all messages still logged)

### Design Constraints
- The chatbot IS an app — follows `AppModule` interface, has a `manifest.yaml`, gets `CoreServices` via `init()`
- Always enabled (cannot be toggled off; free-text routing always reaches ConversationService)
- Subject to the same LLM cost safeguards as any other app (Phase 13 rate limits + cost caps)
- Does not have special privileges — same `CoreServices` access as any app

### Cost Management
- Chatbot uses the `standard` LLM tier by default
- Per-app cost cap in `LLMGuard` prevents runaway spending


---

## Deferred / Future Items

These are documented for future implementation. Not in current phases.

### App Registry / Marketplace
- A registry is a static JSON index file hosted at any URL (GitHub Pages, personal server, etc.)
- Registry entries: app ID, name, description, author, repo URL, version, tags, category, license, trust level
- PAS instances subscribe to multiple registries in `pas.yaml`
- GUI provides a "Browse Apps" page that queries subscribed registries
- Installation flow: browse → review permissions → install → configure
- **Deferred until:** enough apps exist to warrant discovery (current model: share git URLs directly)

### App Signing
- Cryptographic signatures for `reviewed` trust level
- Infrastructure verifies signature before loading
- **Deferred until:** community forms and review process is established

### Credential Scoping
- Currently: external API keys are system-wide env vars (`process.env.WEATHER_API_KEY`)
- Planned: infrastructure reads the env var and passes only the declared value to the app's init context
- Apps would not have access to undeclared env vars
- **Deferred until:** trust model enforcement is implemented (Phase 17+)

### Container Isolation
- Run untrusted apps in separate processes or containers
- Maximum security but conflicts with single-process architecture
- **Deferred indefinitely** — static analysis + manifest review is the chosen approach
