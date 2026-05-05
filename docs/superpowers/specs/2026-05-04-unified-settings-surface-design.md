# Unified Settings Surface — Design Spec

**Date:** 2026-05-04  
**Status:** Approved — pending implementation plan  
**Author:** brainstormed with user 2026-05-04

---

## Context

User-facing configuration is fragmented and undiscoverable:

- ~27 system-level knobs in `config/pas.yaml` have no GUI surface (chat sessions, routing verification, backup, n8n, LLM safeguards, USDA API key, defaults). Users must hand-edit YAML they've likely never opened.
- ~30 food + 1 notes + 3 chatbot per-user settings are only reachable via an unlabelled `<details>` accordion on `/gui/apps/:appId`. There's no "Settings" link in the nav.
- Telegram has only **2 mutable keys** (`log_to_notes`, `flush_memory_on_idle_reset`). A user asking the chatbot "how do I turn off seasonal recipe suggestions?" gets no useful answer.
- As new apps are installed, their settings must be manually wired into any settings page — there is no dynamic registration mechanism.

**Design principle:** settings must be discoverable from three surfaces — GUI, Telegram slash command, and natural-language chatbot — and any future app's settings must appear automatically on all three surfaces without code changes to the settings infrastructure.

---

## Goals

- **Single, discoverable home** (`/gui/settings`) for every user-facing tunable, linked prominently from the nav.
- **Dynamic** — installing a new app automatically registers its settings. No GUI code changes per app.
- **Safe** — dangerous knobs are admin-only with double-confirmation; secrets live on a separate credentials page.
- **Telegram-reachable** — `/settings` slash command for get/set and expanded `<config-set>` NL tag.
- **Chatbot-discoverable** — `/ask "how do I turn off seasonal nudges?"` returns the current value, where to change it in the GUI, and the Telegram command to use.

## Non-goals

- Replacing `/gui/llm` cost dashboard (ops metrics stay separate).
- Replacing `/gui/users`, `/gui/spaces`, `/gui/account/*` (dedicated pages stay).
- Moving secrets (USDA key, webhook secrets, n8n dispatch URL) onto the Settings page — they move to a dedicated `/gui/credentials` page (Chunk G, separate session).
- Per-household settings inheritance UX (system → household → user override chain visualization) — deferred.

---

## Architecture Overview

A new `SettingsRegistry` service is the single source of truth for all registered settings. It composes from three sources at startup:

1. **System schema metadata** — a new `settings-metadata.ts` sidecar to the existing Zod config schema, declaring label, help text, category, and safety flags for each system-level knob.
2. **App manifests** — existing `user_config:` arrays, extended with optional metadata fields. Parsed at install time and at startup.
3. **Virtual chatbot manifest** — `CONVERSATION_USER_CONFIG` in `core/src/services/conversation/manifest.ts`, extended with the same metadata.

At runtime, the Settings page, `/settings` command, and `<config-set>` allowlist all read from `SettingsRegistry` — one source, three surfaces.

---

## SettingsRegistry

```ts
// core/src/services/settings/settings-registry.ts

export interface SettingDef {
  /** Stable key used in storage, slash commands, and <config-set>. */
  key: string;
  /** App or 'system' or 'chatbot'. */
  appId: string;
  /** Section on the settings page. */
  category: SettingsCategory;
  /** Short label shown in the GUI. */
  label: string;
  /** One-sentence explanation shown under the control. Required. */
  help: string;
  /** Longer help shown in the `?` tooltip. Optional. */
  helpDetail?: string;
  /** Widget type for the GUI. */
  type: 'boolean' | 'number' | 'string' | 'select';
  /** For 'select': allowed values. */
  options?: string[];
  /** For 'number': inclusive bounds. */
  min?: number;
  max?: number;
  /** Default value. */
  default: unknown;
  /** If true, only `isPlatformAdmin` users may read or write this setting. */
  adminOnly: boolean;
  /**
   * If true, show a double-confirmation dialog before saving.
   * Use for settings that could break the system or delete data.
   */
  dangerous: boolean;
  /** Confirmation prompt shown in the double-confirm dialog. */
  dangerConfirmPrompt?: string;
  /** Scope of this setting. */
  scope: 'per-user' | 'per-household' | 'system';
  /**
   * If true, expose in the <config-set> NL allowlist and provide an intent regex.
   * Only booleans and low-risk enums should be nlSafe.
   */
  nlSafe: boolean;
  /** Intent regex for <config-set>. Required if nlSafe is true. */
  nlIntentRegex?: RegExp;
}

export type SettingsCategory =
  | 'personal'        // per-user prefs, not app-specific
  | 'food'            // food app settings
  | 'notes'           // notes app settings
  | 'memory-sessions' // chat session lifecycle settings
  | 'notifications'   // future: per-app digest opt-in
  | 'system'          // admin: system-wide knobs
  | 'dangerous';      // admin: double-confirm required

export class SettingsRegistry {
  register(def: SettingDef): void;
  getAll(): SettingDef[];
  getForUser(isAdmin: boolean): SettingDef[];
  getForCategory(category: SettingsCategory, isAdmin: boolean): SettingDef[];
  getNlSafeKeys(): Set<string>;
  getByKey(key: string): SettingDef | undefined;
}
```

`SettingsRegistry` is registered as a `CoreService` and injected into the GUI route handlers, the Router (for `/settings` command), and `ConversationRetrievalService` (for chatbot discoverability).

---

## System Settings Metadata

A new sidecar file `core/src/services/config/settings-metadata.ts` declares metadata for every system-level knob that should appear in the GUI. It is the only place these descriptions live — derived from the Zod schema shape at startup.

Example entries:
```ts
// core/src/services/config/settings-metadata.ts

export const SYSTEM_SETTING_DEFS: Omit<SettingDef, 'appId'>[] = [
  {
    key: 'chat.sessions.auto_reset_idle_minutes',
    category: 'memory-sessions',
    label: 'Auto-reset idle sessions after',
    help: 'Automatically end a chat session after this many minutes of inactivity. Leave empty to disable.',
    type: 'number',
    min: 1,
    max: 525600,
    default: null,
    adminOnly: false,
    dangerous: false,
    scope: 'system',
    nlSafe: false,
  },
  {
    key: 'chat.sessions.retention_days',
    category: 'memory-sessions',
    label: 'Keep ended sessions for',
    help: 'How many days to retain ended chat session transcripts. Older sessions are pruned if auto-prune is enabled.',
    type: 'number',
    min: 1,
    max: 3650,
    default: 90,
    adminOnly: false,
    dangerous: false,
    scope: 'system',
    nlSafe: false,
  },
  {
    key: 'chat.sessions.auto_prune',
    category: 'dangerous',
    label: 'Auto-prune old sessions',
    help: 'Permanently delete session transcripts older than the retention window.',
    helpDetail: 'CAUTION: Deleted transcripts cannot be recovered. Enable only if you are certain you do not need old sessions for recall or audit.',
    type: 'boolean',
    default: false,
    adminOnly: true,
    dangerous: true,
    dangerConfirmPrompt: 'Type "I understand sessions will be permanently deleted" to confirm',
    scope: 'system',
    nlSafe: false,
  },
  {
    key: 'routing.verification.enabled',
    category: 'system',
    label: 'Route verification (double-check)',
    help: 'When the router is uncertain about a message, it checks with a second LLM call. Disable to save cost at the expense of occasional misrouting.',
    type: 'boolean',
    default: true,
    adminOnly: true,
    dangerous: false,
    scope: 'system',
    nlSafe: false,
  },
  // ... backup.*, defaults.timezone, defaults.log_level, LLM safeguards, etc.
];
```

---

## Manifest Extension

The app manifest JSON schema (`core/src/schemas/app-manifest.schema.json`) is extended to support optional metadata on each `user_config` entry. All new fields are optional; missing values fall back to safe defaults (no admin required, not dangerous, not nlSafe). Existing manifests continue to work without changes.

```yaml
# apps/food/manifest.yaml (excerpt, showing new optional fields)
user_config:
  - key: seasonal_nudges
    type: boolean
    default: true
    label: "Seasonal recipe suggestions"
    help: "Send weekly suggestions based on local seasonal produce."
    category: food
    nlSafe: true
    nlIntentRegex: "(turn|switch|enable|disable).*(seasonal|season).*(nudge|suggestion)"

  - key: routing_primary
    type: select
    options: [regex, shadow]
    default: regex
    label: "Routing strategy"
    help: "Controls which classifier is used for message routing. Change only after reviewing shadow classifier telemetry."
    category: dangerous
    adminOnly: true
    dangerous: true
    dangerConfirmPrompt: "Type \"I understand this changes message routing\" to confirm"
    nlSafe: false
```

The `SettingsRegistry` is populated at startup by iterating installed app manifests. When `pas install` adds a new app, its settings appear at next restart automatically.

---

## GUI — `/gui/settings`

### Route

`GET /gui/settings` — renders the full settings page for the requesting user.
`POST /gui/settings/:key` — saves a single setting value via htmx partial swap.
`POST /gui/settings/:key/confirm` — second-step for dangerous settings; validates the typed confirmation phrase before saving.

The existing `/gui/config` route (currently a redirect to dashboard) is repurposed as a redirect to `/gui/settings`.

### Page Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ Settings                                                          │
├──────────────────────────────────────────────────────────────────┤
│ Personal                                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Smart chat detection         [●─────] ON                   │  │
│  │ Detect when questions are PAS-related to inject app context│  │
│  │                                                            │  │
│  │ Daily notes logging          [─────○] OFF                  │  │
│  │ Save every chat message to your daily notes file.          │  │
│  │                                                            │  │
│  │ Memory flush on session reset [─────○] OFF                 │  │
│  │ Summarize the session to memory when the chat auto-resets. │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                              Save │
├──────────────────────────────────────────────────────────────────┤
│ ▶ Food (click to expand)                                         │
│ ▶ Memory & Sessions                                              │
│ ▶ Notes                                                          │
│ ▶ System (admin only)                                            │
│ ▶ ⚠ Advanced / Dangerous (admin only)                           │
└──────────────────────────────────────────────────────────────────┘
```

### Per-setting rendering rules

- **boolean** → toggle switch (not a dropdown — fix for existing `type: boolean` GUI bug).
- **number** → `<input type="number" min="..." max="...">`.
- **string** → `<input type="text">`.
- **select** → `<select>` with `<option>` for each allowed value. **This fixes the existing bug where `select` type renders as plain text.**
- Label + current value always shown. Mandatory `help` text shown below the control in muted style.
- Optional `?` button expands `helpDetail` inline.
- "Reset to default" link appears when current value differs from the declared `default`.

### Auth and visibility

- Non-admin users see Personal, Memory & Sessions, and per-app sections. System and Dangerous sections are hidden entirely (not just disabled).
- Admin users see all sections. Dangerous section has a warning banner: "These settings can break PAS or permanently delete data."

### Save flow (htmx)

- Each section has its own "Save" button.
- `POST /gui/settings/:key` returns only the updated control partial (htmx swap). No full page reload.
- Dangerous settings: "Save" triggers a modal asking the user to type the `dangerConfirmPrompt` string. The typed value is POSTed to `POST /gui/settings/:key/confirm`. Server validates exact match before saving.
- Success: green flash on the control row. Error: red flash with message.

### Nav

A "Settings" link is added to the primary navigation in `core/src/gui/views/layout.eta`. The link appears for all authenticated users (not admin-only, since personal settings are user-visible).

### Per-app blocks

Each installed app with `user_config` entries gets a collapsible section. The section header is the app's `name` from its manifest. If the app has no user_config, no section appears. The "Food" section replaces the `<details>` accordion on `/gui/apps/food` for editing — that page keeps install/enable/info but shows "Edit settings →" deep-linking to `/gui/settings#food`.

---

## Telegram — `/settings` Slash Command

Registered as a builtin Router command (alongside `/newchat`, `/reset`, `/title`, `/notes`).

```
/settings                              → list categories + usage hint
/settings personal                     → list personal settings + current values
/settings food                         → list food settings + current values
/settings food seasonal_nudges         → show current value + help
/settings food seasonal_nudges off     → set value; validates type + coerces
/settings food meal_plan_dinners 4     → numeric set
/settings system                       → admin only; shows system knobs
/settings reset food seasonal_nudges   → reset to default value
```

**Implementation notes:**
- The command parser splits on whitespace: `[category, key?, value?]`.
- Category `personal` maps to settings with `appId: 'chatbot'` and scope `per-user`.
- Category matching is by appId (e.g. `food` → `appId: 'food'`).
- Value coercion re-uses the existing `coerceUserConfigValue` utility.
- Admin-only settings: non-admin users see "that setting requires admin access."
- Dangerous settings: bot replies "⚠ That setting is dangerous. Reply `/settings confirm <key> <value>` to confirm." A 60-second `PendingSettingsConfirmStore` holds the pending change. On confirmation, the change is applied.
- When no category or key is given, the command responds with a compact category list and example: `"/settings personal — your personal prefs. Try: /settings personal seasonal_nudges off"`.

**Discoverability:** the `/settings` command is listed in `/help` output and in the chatbot-discoverability catalog (below).

---

## Telegram — Expanded `<config-set>` NL Allowlist

Currently 2 keys (`log_to_notes`, `flush_memory_on_idle_reset`). The allowlist and intent regex for each key are defined separately in `control-tags.ts`.

**New approach:** the allowlist and intent regexes are derived from `SettingsRegistry.getNlSafeKeys()` at startup. Each `SettingDef` with `nlSafe: true` provides its own `nlIntentRegex`. The `<config-set>` parser iterates this derived set — the allowlist is no longer a hardcoded constant.

**~25 keys flagged nlSafe=true in v1:**

| Key | App | Type | Intent regex (summary) |
|---|---|---|---|
| `log_to_notes` | chatbot | bool | existing regex (unchanged) |
| `flush_memory_on_idle_reset` | chatbot | bool | existing regex (unchanged) |
| `auto_detect_pas` | chatbot | bool | "turn (on/off) smart chat / app detection" |
| `seasonal_nudges` | food | bool | "turn (on/off) seasonal (suggestions/nudges)" |
| `cultural_calendar` | food | bool | "turn (on/off) holiday/cultural recipe suggestions" |
| `child_meal_adaptation` | food | bool | "adapt (for/without) kids / disable kid-friendly" |
| `show_price_estimates` | food | bool | "show/hide price(s) on grocery list" |
| `hands_free_default` | food | bool | "enable/disable hands-free / voice cooking mode" |
| `seasonal_nudges` | food | bool | (see above) |
| `meal_plan_dinners` | food | number | "plan (N) dinners per week" |
| `new_recipe_ratio` | food | number | "(N)% new recipes (in the plan)" |
| `dietary_preferences` | food | string | "I prefer (healthy/quick/budget) meals" |
| `dietary_restrictions` | food | string | "I don't eat / I'm (vegetarian/gluten-free/…)" |
| `default_store` | food | string | "my default store is (X)" |
| `macro_target_calories` | food | number | "(N) calories per day / my calorie goal is N" |
| `macro_target_protein` | food | number | "N grams of protein per day" |
| `notes_per_page` | notes | number | "show (N) notes at a time" |

Keys **not** flagged nlSafe: anything dangerous or admin-only, `routing_primary`, `shadow_sample_rate`, `auto_prune`, `retention_days`, `auto_reset_idle_minutes`, all system/backup/webhook settings.

The NL path uses intent gating (same pattern as existing `log_to_notes`): the `<config-set>` tag is only acted on when the user's message matches the key's `nlIntentRegex`. This prevents accidentally changing settings in unrelated conversation.

---

## Chatbot Discoverability

The user must be able to ask the chatbot "how do I turn off seasonal nudges?" or "what's my default store?" and get an accurate, current answer including how to change the setting in both the GUI and via Telegram.

**Implementation:** extend `ConversationRetrievalService` source policy to include a `settings` source. When `auto_detect_pas` is true and the classifier detects a settings-related question, `buildContextSnapshot` calls a new `SettingsReader` that:

1. Fetches the relevant settings from `SettingsRegistry` (filtered to the asking user's scope and admin status).
2. Reads each setting's current value from `AppConfigService`.
3. Returns a compact catalog snapshot:

```
## Your settings
- Seasonal nudges: ON  — /settings food seasonal_nudges off  |  GUI: Settings → Food
- Default store: Harris Teeter  — /settings food default_store "Walmart"  |  GUI: Settings → Food
- Memory flush on reset: OFF  — /settings personal flush_memory_on_idle_reset on  |  GUI: Settings → Personal
```

This catalog is injected into the system prompt as a `<memory-context label="settings-catalog">` block (Layer 3, after app metadata). It is only included when the classifier determines the user is asking a settings-related question — not on every turn.

**Source policy:** `settings` is a new allowed source in `SOURCE_POLICY` with default enabled in `/ask` mode and conditionally enabled in `handleMessage` mode (when the recall classifier detects a settings question).

---

## Bug Fixes Included in This Work

These bugs were found during the settings audit and must be fixed as part of this phase:

1. **`select` type renders as plain text** — `core/src/gui/views/app-detail.eta` lines ~113–129. The `if (field.type === 'boolean')` branch gets a `<select>` but all other types fall through to `<input type="text">`. The new settings page uses `<select>` for `type: 'select'`. The `app-detail.eta` view must also be fixed for backward compatibility (or the settings editing will be moved entirely to `/gui/settings` and the `app-detail.eta` form will become read-only with a "Edit in Settings →" link).

2. **Food pseudo-fields in user_config** — `guest_profiles_info` and `schedule_overrides_info` are documentation text crammed into `user_config` entries. They will render incorrectly on the settings page. Remove them from `user_config`; move their content into the `description:` field of the relevant slash commands in the manifest, or into `MANIFEST_REFERENCE.md`.

3. **Scheduler page claims edit support it doesn't have** — `food.schedule_overrides_info` text says "Edit the seasonal-nudge and weekly-nutrition-summary cron schedules via the GUI Scheduler page." The `/gui/scheduler` page has no edit endpoint. Either build `PUT /gui/scheduler/:appId/:jobId` (out of scope here) or correct the manifest text to reflect reality.

4. **`/gui/config` redirect** — Currently redirects to dashboard. Repurpose as a redirect to `/gui/settings` so any existing bookmarks continue to work.

5. **Chatbot manifest comment** — `core/src/services/conversation/manifest.ts` has a comment claiming `CONVERSATION_USER_CONFIG` "mirrors apps/chatbot/manifest.yaml" but that file no longer exists. Update comment to "is the source of truth for the chatbot virtual app's user configuration."

---

## Implementation Phasing

### Chunk A — SettingsRegistry + metadata sidecar + manifest extension

Deliverables:
- `core/src/services/settings/settings-registry.ts` — `SettingDef`, `SettingsRegistry` class, `SettingsCategory` type.
- `core/src/services/config/settings-metadata.ts` — `SYSTEM_SETTING_DEFS` for all system-level knobs.
- Extend `core/src/schemas/app-manifest.schema.json` — optional `category`, `help`, `helpDetail`, `adminOnly`, `dangerous`, `dangerConfirmPrompt`, `nlSafe`, `nlIntentRegex` fields on `user_config` entries.
- Wire `SettingsRegistry` into `bootstrap.ts` as a `CoreService`.
- Populate from: system metadata sidecar + all installed manifests + `CONVERSATION_USER_CONFIG`.
- No UI yet.

### Chunk B — `/gui/settings` page (Personal + Per-app sections)

Deliverables:
- `core/src/gui/routes/settings.ts` — `GET /gui/settings`, `POST /gui/settings/:key`.
- `core/src/gui/views/settings.eta` — full settings page with Personal section + per-app collapsible sections.
- Per-setting widget rendering (toggle, number, text, **working select**).
- Mandatory `help` text displayed.
- `?` tooltip expander for `helpDetail`.
- "Reset to default" link.
- "Settings" link added to nav.
- `/gui/config` → `/gui/settings` redirect.
- Fix #1 (select type) + Fix #4 (config redirect) + Fix #5 (manifest comment).

### Chunk C — Memory & Sessions + System + Dangerous sections

Deliverables:
- Memory & Sessions section (`retention_days`, `auto_reset_idle_minutes`).
- System section (admin-only, collapsed by default): `defaults.timezone`, `defaults.log_level`, `routing.verification.*`, `backup.*`, LLM safeguard caps.
- Dangerous section: `routing_primary`, `shadow_min_confidence`, `shadow_sample_rate`, `auto_prune`.
- Double-confirm modal (htmx): typed-phrase validation at `POST /gui/settings/:key/confirm`.
- Non-admin users see neither System nor Dangerous sections.
- Fix #2 (pseudo-fields) + Fix #3 (scheduler claim).

### Chunk D — `/settings` Telegram command

Deliverables:
- `core/src/services/conversation/handle-settings.ts` — parse subcommand, dispatch get/set/reset.
- `PendingSettingsConfirmStore` — 60-second TTL store for dangerous-setting pending confirmations.
- Router integration: `'/settings'` builtin command registered.
- `/help` output updated to include `/settings`.
- All 25 nlSafe keys verified with their intent regexes in the manifest and system metadata.

### Chunk E — `<config-set>` allowlist expansion + intent-regex registry

Deliverables:
- `control-tags.ts` `ALLOWED_CONFIG_KEYS` constant removed; replaced with `SettingsRegistry.getNlSafeKeys()` at startup.
- Each `<config-set>` intent check uses the `nlIntentRegex` from the matching `SettingDef`.
- Food manifest and chatbot manifest updated with `nlSafe: true` and `nlIntentRegex` for all 25 keys.
- Regression: verify the 2 existing keys still work; verify dangerous/admin-only keys reject via `<config-set>`.

### Chunk F — Chatbot discoverability

Deliverables:
- `core/src/services/settings/settings-reader.ts` — fetches current values for settings visible to the requesting user; builds the settings catalog text block.
- `SettingsReader` registered as a `ConversationRetrievalService` source with key `'settings'`.
- `SOURCE_POLICY` updated: `settings` allowed in both `/ask` mode (default on) and `handleMessage` mode (conditional on recall classifier detecting a settings question).
- `build-app-aware-system-prompt.ts` + `build-system-prompt.ts` updated to render the settings catalog as `<memory-context label="settings-catalog">`.
- Persona test: "how do I turn off seasonal nudges?" → chatbot response mentions `/settings food seasonal_nudges off` and "GUI: Settings → Food".

### Chunk G — `/gui/credentials` page (separate session)

Out of scope for this phase. Covers: USDA FDC API key, n8n dispatch URL, webhook secrets. Deferred to its own focused session.

---

## URS Requirements

To be added to `docs/urs.md` under a new `## Settings Surface` section:

| ID | Requirement |
|---|---|
| REQ-SETTINGS-001 | `SettingsRegistry` MUST compose settings from system metadata, all installed app manifests, and the chatbot virtual manifest at startup. |
| REQ-SETTINGS-002 | Installing a new app via `pas install` MUST make its `user_config` entries appear on `/gui/settings` at next restart without any changes to settings-infrastructure code. |
| REQ-SETTINGS-003 | `adminOnly: true` settings MUST NOT be visible to non-admin users on any surface (GUI, Telegram, chatbot). |
| REQ-SETTINGS-004 | `dangerous: true` settings MUST require a typed-phrase double-confirmation before saving on both GUI and Telegram surfaces. |
| REQ-SETTINGS-005 | `select`-type settings MUST render as a `<select>` element in the GUI, not a text input. |
| REQ-SETTINGS-006 | Every setting MUST have a non-empty `help` string; the registry MUST throw a configuration error if `help` is absent. |
| REQ-SETTINGS-007 | The `<config-set>` NL allowlist MUST be derived from `SettingsRegistry.getNlSafeKeys()` at startup; hardcoded allowlist constants MUST be removed. |
| REQ-SETTINGS-008 | `nlSafe: true` settings MUST provide an `nlIntentRegex`; the registry MUST throw if `nlIntentRegex` is absent when `nlSafe: true`. |
| REQ-SETTINGS-009 | The `/settings` Telegram command MUST be accessible to all authenticated users for non-admin settings. |
| REQ-SETTINGS-010 | The `/settings` Telegram command MUST reject dangerous settings without the pending-confirm flow; bypassing the confirm step MUST NOT save the value. |
| REQ-SETTINGS-011 | The chatbot MUST be able to answer questions about setting names, current values, and how to change them via GUI and Telegram. |
| REQ-SETTINGS-012 | The settings catalog injected into the chatbot system prompt MUST reflect current values at the time of the request, not cached at session mint. |
| REQ-SETTINGS-013 | Secrets (USDA key, n8n URL, webhook secrets) MUST NOT appear on the Settings page; they are deferred to `/gui/credentials`. |
| REQ-SETTINGS-014 | `/gui/config` MUST redirect to `/gui/settings`. |
| REQ-SETTINGS-015 | Food manifest pseudo-fields (`guest_profiles_info`, `schedule_overrides_info`) MUST be removed from `user_config` before the settings page ships. |
| REQ-SETTINGS-016 | The "Settings" nav link MUST be visible to all authenticated users. |
| REQ-SETTINGS-017 | Setting writes MUST go through `AppConfigService.updateOverrides`; direct YAML edits are the only other path (for system settings only). |
| REQ-SETTINGS-018 | The CSRF double-submit cookie MUST be validated on all POST endpoints under `/gui/settings`. |

---

## Open Items / Deferred

- **Chunk G — `/gui/credentials` page** — USDA key, n8n URL, webhook secrets. Separate session.
- **Notifications section** — placeholder reserved in the page layout; content deferred until a per-app digest opt-in feature is designed.
- **Per-household settings inheritance UX** — visualizing the system → household → user override chain, and allowing household-scoped settings to be edited, is deferred.
- **Scheduler cron editing** — the food manifest claims "Edit cron via GUI Scheduler" but no edit endpoint exists. Building `PUT /gui/scheduler/:appId/:jobId` is out of scope here; Fix #3 corrects the manifest text only.
- **Streaming / typing-indicator UX** — belongs in Hermes P7 UX polish bucket, not here.
