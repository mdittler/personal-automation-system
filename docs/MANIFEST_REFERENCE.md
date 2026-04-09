# Manifest Reference

Every PAS app requires a `manifest.yaml` in its root directory. This file declares the app's identity, capabilities, and requirements. The infrastructure reads manifests to discover and integrate apps — if it's not in the manifest, the infrastructure doesn't know about it.

Manifests are validated against a JSON Schema at `core/src/schemas/app-manifest.schema.json`.

**Note:** In addition to the manifest, apps should include a `help.md` file in the app root directory. This file is automatically indexed by the `AppKnowledgeBase` and used by the chatbot's `/ask` command to answer user questions about your app. Write it for end users with plain language and examples. See [CREATING_AN_APP.md](CREATING_AN_APP.md#help-documentation-for-ask) for details.

## `app` Block (Required)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier. Pattern: `^[a-z][a-z0-9-]*$` |
| `name` | string | Yes | Human-readable name shown in GUI and `/help` |
| `version` | string | Yes | Semver version (e.g. `1.0.0`) |
| `description` | string | Yes | 1-3 sentence description |
| `author` | string | Yes | Author name |
| `pas_core_version` | string | No | Required CoreServices version range (e.g. `>=0.1.0`). Checked at install time |
| `license` | string | No | SPDX identifier (e.g. `MIT`, `Apache-2.0`) |
| `category` | string | No | One of: `productivity`, `home`, `health`, `finance`, `social`, `utility` |
| `tags` | string[] | No | Discovery keywords (max 20, each max 50 chars) |
| `homepage` | string | No | Project URL (must be `http://` or `https://`) |
| `repository` | string | No | Repository URL |

**Example:**

```yaml
app:
  id: my-app
  name: "My App"
  version: "1.0.0"
  description: "Does something useful."
  author: "Your Name"
  pas_core_version: ">=0.1.0"
  license: "MIT"
  category: productivity
  tags: ["example", "demo"]
```

## `capabilities` Block

### `messages`

| Field | Type | Description |
|-------|------|-------------|
| `intents` | string[] | Keywords/phrases for intent classification. The router uses LLM to match free-text messages against these |
| `commands` | Command[] | Explicit `/commands` this app handles |
| `accepts_photos` | boolean | Whether this app handles photo messages |
| `photo_intents` | string[] | Photo classification types this app handles |

**Command fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Command name. Pattern: `^/[a-z][a-z0-9_]*$` |
| `description` | string | Yes | Shown in `/help` |
| `args` | string[] | No | Named positional arguments |

**Example:**

```yaml
capabilities:
  messages:
    intents:
      - "note this"
      - "save a note"
    commands:
      - name: /note
        description: "Save a quick note"
        args: ["text"]
      - name: /notes
        description: "List recent notes"
```

### `schedules`

Recurring cron jobs. Each schedule requires a handler file.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique job ID. Pattern: `^[a-z][a-z0-9-]*$` |
| `description` | string | Yes | Human-readable description |
| `cron` | string | Yes | Standard 5-field cron expression |
| `handler` | string | Yes | Handler file path relative to app root |
| `user_scope` | string | Yes | `all` (invoked once per registered user), `shared` (once for shared data), `system` (once) |

**Per-user dispatch (`user_scope: all`):** The scheduler iterates registered system users and invokes the handler once per user inside a per-user request context. The second argument to `handleScheduledJob(jobId, userId?)` is the iterating user's id, and `services.config.get(key)` automatically returns that user's override within the invocation. For `shared` and `system` jobs the handler is invoked once with `userId` undefined.

**Example:**

```yaml
capabilities:
  schedules:
    - id: daily-cleanup
      description: "Archive old entries daily"
      cron: "0 3 * * *"
      handler: "dist/handlers/cleanup.js"
      user_scope: all
```

```ts
// In your AppModule
export const handleScheduledJob: AppModule['handleScheduledJob'] = async (
  jobId: string,
  userId?: string, // set for user_scope: all, undefined otherwise
) => {
  if (jobId === 'daily-cleanup' && userId) {
    // services.config.get(...) automatically returns userId's overrides
    const retention = await services.config.get<number>('retention_days');
    // ... per-user cleanup logic
  }
};
```

### `rules`

Condition evaluator rule files.

```yaml
capabilities:
  rules:
    files:
      - "rules/my-rules.yaml"
```

### `events`

Inter-app event pub/sub.

```yaml
capabilities:
  events:
    emits:
      - id: "my-app:item-created"
        description: "Fired when a new item is created"
    subscribes:
      - event: "other-app:something-happened"
        handler: "dist/handlers/on-event.js"
        required: false
```

## `requirements` Block

### `services`

Infrastructure services your app needs. Only declared services are injected — undeclared ones will be `undefined`.

| Service ID | CoreServices field | Description |
|-----------|-------------------|-------------|
| `telegram` | `telegram` | Send and receive Telegram messages |
| `data-store` | `data` | File-based data storage (per-user and shared) |
| `llm` | `llm` | LLM access (classify, extract, complete) |
| `scheduler` | `scheduler` | One-off job scheduling |
| `condition-eval` | `conditionEvaluator` | Programmatic condition checking |
| `audio` | `audio` | Text-to-speech and Chromecast casting |
| `event-bus` | `eventBus` | In-process event pub/sub. Emit custom events for n8n webhook integration |
| `context-store` | `contextStore` | Read-only user preferences knowledge base |
| `app-metadata` | `appMetadata` | Read-only metadata about installed apps |
| `app-knowledge` | `appKnowledge` | Read-only app and infra documentation search |
| `model-journal` | `modelJournal` | Persistent model journal (read, append, archive) |
| `system-info` | `systemInfo` | Read-only system introspection (models, costs, scheduling, status) + model switching |

Legacy service IDs `llm:ollama` and `llm:claude` are still accepted but map to the same `llm` service.

#### Always-Provided Services

The following services are **always injected** into every app, regardless of `requirements.services`. You do not need to list them — they are always available.

| CoreServices field | Type | Description |
|-------------------|------|-------------|
| `config` | `AppConfigService` | Per-user app configuration. Returns the calling user's override (set via the GUI) when present, otherwise the `user_config` default. The active userId is propagated transparently via the infrastructure's `requestContext`, so app code never needs to pass userId to `config.get(...)` |
| `secrets` | `SecretsService` | External API credential access via `services.secrets.get(id)`. See `external_apis` below |
| `timezone` | `string` | IANA timezone string from system config (e.g. `'America/New_York'`). Use with `Intl.DateTimeFormat` |
| `logger` | `AppLogger` | Scoped structured logger (Pino), automatically tagged with your app ID. Levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

### `data`

| Field | Type | Description |
|-------|------|-------------|
| `user_scopes` | DataScope[] | Per-user data access declarations |
| `shared_scopes` | DataScope[] | Shared (cross-user) data access declarations |
| `context_reads` | string[] | Context store keys this app reads |

**DataScope fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | Yes | File or directory path |
| `access` | string | Yes | `read`, `write`, or `read-write` |
| `description` | string | Yes | What this data is for |

### `external_apis`

External API credentials your app needs. At runtime, the infrastructure reads each `env_var` from the host's environment and makes the value available via `services.secrets.get(id)`. This keeps API keys with the infrastructure operator, not in app code — so apps can be shared without exposing credentials.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | API identifier (used with `services.secrets.get(id)`) |
| `description` | string | Yes | What this API is used for |
| `required` | boolean | Yes | Whether the app needs this to function |
| `env_var` | string | Yes | Environment variable name. Pattern: `^[A-Z][A-Z0-9_]*$` |
| `fallback_behavior` | string | No | What happens when this optional API is unavailable |

**Runtime access:** `services.secrets.get('weather')` returns the value of the corresponding `env_var`, or `undefined` if not set. `services.secrets.has('weather')` checks existence. The `secrets` service is always provided — it returns `undefined` for any ID not declared in `external_apis`. Missing `required` APIs log a warning at startup.

### `integrations`

Soft dependencies on other apps. The `required` field must always be `false` — apps must work standalone.

```yaml
requirements:
  integrations:
    - app: "other-app"
      description: "Uses other-app's event for enrichment"
      required: false
```

### `llm`

Per-app LLM safeguard overrides.

| Field | Type | Description |
|-------|------|-------------|
| `tier` | string | Preferred model tier: `fast`, `standard`, or `reasoning` |
| `rate_limit.max_requests` | integer | Max requests within the window (min: 1) |
| `rate_limit.window_seconds` | integer | Sliding window in seconds (min: 1) |
| `monthly_cost_cap` | number | Per-app monthly cost cap in USD (must be > 0) |

**Example:**

```yaml
requirements:
  llm:
    tier: fast
    rate_limit:
      max_requests: 30
      window_seconds: 3600
    monthly_cost_cap: 5.00
```

## `user_config` Block

Per-user configuration shown in the management GUI.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | Config key. Pattern: `^[a-z][a-z0-9_]*$` |
| `type` | string | Yes | `string`, `number`, `boolean`, or `select` |
| `default` | any | Yes | Default value |
| `description` | string | Yes | Shown in GUI |
| `options` | string[] | Conditional | Required when `type` is `select` |

**Example:**

```yaml
user_config:
  - key: notes_per_page
    type: number
    default: 10
    description: "Number of notes to show when listing"
  - key: theme
    type: select
    default: "light"
    description: "UI theme"
    options: ["light", "dark", "auto"]
```

## Complete Example

```yaml
app:
  id: notes
  name: "Notes"
  version: "1.0.0"
  description: "Quick notes via Telegram. Save, list, and summarize your daily notes."
  author: "PAS Team"
  pas_core_version: ">=0.1.0"
  license: "MIT"
  category: productivity
  tags: ["notes", "memo", "daily", "example"]

capabilities:
  messages:
    intents:
      - "note this"
      - "save a note"
      - "remember that"
      - "jot down"
    commands:
      - name: /note
        description: "Save a quick note"
        args: ["text"]
      - name: /notes
        description: "List recent notes"
      - name: /summarize
        description: "Summarize today's notes using AI"

requirements:
  services:
    - telegram
    - data-store
    - llm
  data:
    user_scopes:
      - path: "notes/daily-notes/"
        access: read-write
        description: "Daily notes organized by date"
  llm:
    tier: fast
    rate_limit:
      max_requests: 30
      window_seconds: 3600
    monthly_cost_cap: 5.00

user_config:
  - key: notes_per_page
    type: number
    default: 10
    description: "Number of notes to show when listing"
```
