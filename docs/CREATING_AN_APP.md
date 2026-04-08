# Creating a PAS App

This guide walks you through building, testing, and sharing a PAS app.

## Overview

A PAS app is a TypeScript module that:
1. Declares its identity and capabilities in `manifest.yaml`
2. Exports functions matching the `AppModule` interface
3. Receives infrastructure services via dependency injection in `init()`

Apps live in the `apps/` directory of the PAS monorepo (or as standalone git repos for sharing).

## Development Paths

### Inside the PAS monorepo

Use `pnpm scaffold-app --name=my-app` to generate a skeleton, then build and test with monorepo scripts (`pnpm build`, `pnpm test`). This is the fastest way to get started.

### Standalone app repo

For sharing apps or developing outside the monorepo:

1. Create a fresh git repo
2. Add `@pas/core` as a dev dependency (for types and testing utilities)
3. Create `manifest.yaml` using the minimal manifest example below
4. Implement the `AppModule` interface in `src/index.ts`
5. Add a `tsconfig.json` extending the base config (or create your own with `"module": "ESNext"`, `"moduleResolution": "bundler"`)
6. Test with Vitest using `@pas/core/testing` for mock services
7. Install into a PAS instance with `pnpm install-app <git-url>`

**Documents you need:** this file and [MANIFEST_REFERENCE.md](MANIFEST_REFERENCE.md). For reference patterns, see the example apps listed at the bottom of this guide.

## Quick Start

Generate a new app skeleton:

```bash
pnpm scaffold-app --name=my-app --description="My first app" --author="Your Name"
```

This creates `apps/my-app/` with a working manifest, TypeScript source, and test file. Then:

```bash
pnpm install    # Link the new workspace package
pnpm build      # Compile TypeScript
pnpm test       # Run tests
```

## Project Structure

```
apps/my-app/
  manifest.yaml          # App identity, capabilities, requirements
  package.json           # Dependencies (must include @pas/core)
  tsconfig.json          # TypeScript config
  help.md                # User-facing help for /ask discoverability
  docs/
    requirements.md      # Raw requirements organized by feature area
    urs.md               # Formal URS with test traceability
  src/
    index.ts             # AppModule implementation (entry point)
    __tests__/
      app.test.ts        # Tests
```

## Help Documentation for /ask

Include a `help.md` file in your app root so users can discover your features via the chatbot's `/ask` command. The `AppKnowledgeBase` automatically indexes `help.md` and any files in `docs/` — but `help.md` is the primary user-facing document.

**Write for end users, not developers:**
- Use plain language, not technical jargon
- Include examples of what to say ("Try: *save this recipe for banana bread*")
- Organize by feature area with clear headings
- Explain what each command does and when to use it

**Example `help.md`:**

```markdown
# My App — Quick Notes

## Saving Notes
Send any message to save it as a note. You can also use `/note` followed by your text.

Try: *note Buy milk on the way home*

## Viewing Notes
Use `/notes` to see today's notes.

## Summarizing
Use `/summarize` to get an AI summary of today's notes.
```

The scaffold generates a starter `help.md` automatically. Update it as you add features.

## The Manifest

The manifest declares everything the infrastructure needs to know about your app. Key sections:

- **`app`** — identity (id, name, version, author)
- **`capabilities`** — what your app can do (intents, commands, photos, schedules)
- **`requirements`** — what your app needs (services, data access, LLM config)
- **`user_config`** — per-user settings shown in the management GUI

See [MANIFEST_REFERENCE.md](MANIFEST_REFERENCE.md) for the complete field reference.

**Minimal manifest:**

```yaml
app:
  id: my-app
  name: "My App"
  version: "1.0.0"
  description: "Does something useful."
  author: "Your Name"
  pas_core_version: ">=0.1.0"

capabilities:
  messages:
    commands:
      - name: /myapp
        description: "Run my app"

requirements:
  services:
    - telegram
```

## Implementing AppModule

Your `src/index.ts` must export functions matching the `AppModule` interface:

```typescript
import type { AppModule, CoreServices, MessageContext } from '@pas/core/types';

let services: CoreServices;

// Required: called once at startup. Store the services reference.
export const init: AppModule['init'] = async (s) => {
  services = s;
};

// Required: handles text messages routed to your app via intents.
export const handleMessage: AppModule['handleMessage'] = async (ctx) => {
  await services.telegram.send(ctx.userId, `Got: ${ctx.text}`);
};

// Optional: handles /commands declared in your manifest.
export const handleCommand: AppModule['handleCommand'] = async (command, args, ctx) => {
  await services.telegram.send(ctx.userId, `Command: ${command}, args: ${args.join(' ')}`);
};

// Optional: handles photo messages (requires accepts_photos: true in manifest).
// export const handlePhoto: AppModule['handlePhoto'] = async (ctx) => { ... };

// Optional: called on shutdown. Clean up resources.
// export const shutdown: AppModule['shutdown'] = async () => { ... };
```

### MessageContext

Every message handler receives a `MessageContext`:

```typescript
interface MessageContext {
  userId: string;       // Telegram user ID
  text: string;         // Message text
  timestamp: Date;      // When the message was sent
  chatId: number;       // Telegram chat ID
  messageId: number;    // Telegram message ID
}
```

## Using CoreServices

You only receive the services declared in `requirements.services`. Undeclared services will be `undefined`. Four services are always provided regardless of declarations: `config`, `secrets`, `timezone`, and `logger` (see [Always-Provided Services](MANIFEST_REFERENCE.md#always-provided-services)).

### Sending Messages

```typescript
// Send text
await services.telegram.send(ctx.userId, 'Hello!');

// Send with inline keyboard
await services.telegram.sendOptions(ctx.userId, 'Choose:', {
  reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'yes' }]] }
});
```

### Storing Data

```typescript
// Per-user data (scoped to data/users/<userId>/<appId>/)
const store = services.data.forUser(ctx.userId);
await store.write('config.yaml', yamlContent);
await store.append('log.md', `- ${new Date().toISOString()} Event\n`, {
  frontmatter: generateFrontmatter({ title: 'My App Log', tags: ['pas/log', 'pas/my-app'], type: 'log', app: 'my-app', source: 'pas-my-app' }),
}); // See "Obsidian-Compatible Markdown" section below
const content = await store.read('config.yaml');
const exists = await store.exists('config.yaml');
const files = await store.list('notes/');

// Shared data (scoped to data/users/shared/<appId>/)
const shared = services.data.forShared();
```

### Timezone

`services.timezone` provides the IANA timezone string from system config (e.g. `'America/New_York'`). Use it for user-facing dates and times:

```typescript
// Timezone-aware date (YYYY-MM-DD)
const date = new Intl.DateTimeFormat('en-CA', { timeZone: services.timezone ?? 'UTC' }).format(new Date());

// Timezone-aware time (HH:MM)
const time = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: services.timezone ?? 'UTC',
}).format(new Date());
```

Always fall back to `'UTC'` with `?? 'UTC'` in case the property isn't set.

### Using LLM

All LLM access goes through `services.llm` — never import LLM SDKs directly.

```typescript
// Free-form completion
const answer = await services.llm.complete('Summarize: ' + text, { tier: 'fast' });

// Classification
const result = await services.llm.classify(text, ['greeting', 'question', 'command']);
// result = { category: 'greeting', confidence: 0.95 }

// Structured extraction
const data = await services.llm.extractStructured(text, {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' }
  }
});

// Check which model is assigned to a tier
const model = services.llm.getModelForTier?.('standard');
// model = 'anthropic/claude-sonnet-4-6'
```

### Handling LLM Errors

LLM calls can fail for many reasons (billing, rate limits, overload). Use `classifyLLMError` to give users actionable messages instead of generic "try again" text:

```typescript
import { classifyLLMError } from '@pas/core/utils/llm-errors';

try {
  const answer = await services.llm.complete(prompt, { tier: 'fast' });
  await services.telegram.send(ctx.userId, answer);
} catch (err) {
  const { userMessage } = classifyLLMError(err);
  await services.telegram.send(ctx.userId, userMessage);
  services.logger.error('LLM failed: %s', (err as Error).message);
}
```

The classifier detects these categories:

| Category | Cause | User message |
|----------|-------|-------------|
| `billing` | API credits exhausted | "AI service unavailable — account credits are too low." |
| `rate-limit` | Too many requests (provider or PAS guard) | "Too many requests. Please wait a moment." |
| `cost-cap` | Monthly per-app cost cap reached | "Monthly AI usage limit reached." |
| `auth` | Invalid API key | "AI service configuration error." |
| `overloaded` | Provider 5xx error | "AI service is temporarily overloaded." |
| `unknown` | Anything else | "Could not process your request right now." |

The returned `LLMErrorInfo` also includes `isRetryable: boolean` so you can decide whether to offer a retry.

### Logging

```typescript
services.logger.info('Processing message from %s', ctx.userId);
services.logger.debug('Details: %o', { key: 'value' });
services.logger.error('Something failed: %s', error.message);
```

### Obsidian-Compatible Markdown

All PAS `.md` files include YAML frontmatter for Obsidian vault compatibility. When your app writes markdown files, add frontmatter so they integrate cleanly with Obsidian and external tools like n8n.

**Writing with frontmatter:**

```typescript
import { generateFrontmatter } from '@pas/core/utils/frontmatter';

const frontmatter = generateFrontmatter({
  title: 'My App Log',
  tags: ['pas/log', 'pas/my-app'],
  type: 'log',
  app: 'my-app',
  source: 'pas-my-app',
});

const store = services.data.forUser(ctx.userId);
await store.append('log.md', `- ${new Date().toISOString()} Event\n`, { frontmatter });
```

The `{ frontmatter }` option on `append()` is race-safe — frontmatter is only written when the file is first created. Subsequent appends add content without duplicating the header.

**Reading markdown that has frontmatter:**

```typescript
import { stripFrontmatter } from '@pas/core/utils/frontmatter';

const raw = await store.read('log.md');
const content = raw ? stripFrontmatter(raw) : '';
// content has no frontmatter — safe for LLM prompts or text processing
```

Always strip frontmatter before passing markdown content to an LLM or processing it as text.

**Standard frontmatter fields:**

| Field | Purpose | Example |
|-------|---------|---------|
| `title` | Human-readable title | `'Daily Notes'` |
| `date` | ISO date string | `'2026-03-19'` |
| `tags` | Array with `pas/` prefix | `['pas/daily-note', 'pas/my-app']` |
| `type` | Content type | `'log'`, `'note'`, `'report'` |
| `app` | App ID that created it | `'my-app'` |
| `source` | Source identifier | `'pas-my-app'` |

**When to skip frontmatter:** Machine-readable data files (CSV tables, YAML config, JSON) should not have frontmatter — it would break parsers.

### Cross-App Linking via Obsidian Conventions

PAS data files are unified into per-user vault directories at `data/vaults/<userId>/` (created by VaultService) which can be opened as an Obsidian vault. By following these conventions, your app's data integrates into Obsidian's graph view, backlinks, tag pane, and Dataview plugin — and connects to data from other apps without any code dependency.

**Vault root:** `data/vaults/<userId>/` — each user's vault is generated by the VaultService with symlinks that unify personal, shared, and space data into a single directory tree. Wiki-links use `<appId>/<path>` format relative to this root.

The vault directory structure:

```
data/vaults/<userId>/
  <appId>/           → symlink to data/users/<userId>/<appId>/   (personal data)
  _shared/<appId>/   → symlink to data/users/shared/<appId>/     (global shared data)
  _spaces/<spaceId>/<appId>/ → symlink to data/spaces/<spaceId>/<appId>/ (space data)
```

The `_shared/` and `_spaces/` prefixes use underscores, which cannot collide with app IDs (app ID pattern: `^[a-z][a-z0-9-]*$`).

#### Wiki-Links

Use `[[target]]` syntax in markdown content to link to files in other apps:

```markdown
## Monday Dinner
Made [[food-tracker/recipes/chicken-stir-fry]] — serves 4
Ingredients added to [[grocery/lists/2026-03-19]]

## Shared and Space Links
Check the shared [[_shared/grocery/lists/weekly]] for the family list
See the family space [[_spaces/family/meal-planner/plans/week-12]]
```

Obsidian resolves these links automatically. The graph view shows connections between apps. Backlinks show which files reference the current file.

**Wiki-link conventions by data scope:**

| Scope | Wiki-link format | Example |
|-------|-----------------|---------|
| Personal | `[[<appId>/<path>]]` | `[[notes/daily/2026-03-19]]` |
| Shared | `[[_shared/<appId>/<path>]]` | `[[_shared/grocery/lists/weekly]]` |
| Space | `[[_spaces/<spaceId>/<appId>/<path>]]` | `[[_spaces/family/meal-planner/plans/week-12]]` |

Use the `related` frontmatter field for structured cross-references:

```typescript
import { generateFrontmatter } from '@pas/core/utils/frontmatter';

const frontmatter = generateFrontmatter({
  title: 'Meal Plan - Week 12',
  tags: ['pas/meal-plan', 'pas/meal-planner', 'ingredient/chicken', 'meal/dinner'],
  app: 'meal-planner',
  related: [
    '[[food-tracker/recipes/chicken-stir-fry]]',
    '[[grocery/lists/2026-03-19]]',
  ],
});
```

Use `aliases` so files can be found by alternative names:

```typescript
const frontmatter = generateFrontmatter({
  title: 'Chicken Stir Fry',
  aliases: ['stir fry chicken', 'chicken stir-fry'],
  // ...
});
```

**Utility:** `extractWikiLinks(content)` extracts all `[[target]]` references from markdown content (handles `[[target|display text]]` format too).

#### Tag Taxonomy

Use hierarchical tags to create implicit connections between apps. Apps don't need to know about each other — shared tag namespaces link them automatically in Obsidian's tag pane.

| Pattern | Purpose | Example |
|---------|---------|---------|
| `pas/<app-id>` | Source app | `pas/food-tracker` |
| `pas/<type>` | Content type | `pas/recipe`, `pas/workout` |
| `ingredient/<name>` | Food items | `ingredient/chicken`, `ingredient/broccoli` |
| `meal/<type>` | Meal category | `meal/dinner`, `meal/lunch`, `meal/snack` |
| `exercise/<type>` | Exercise type | `exercise/cardio`, `exercise/strength` |
| `category/<domain>` | Broad domain | `category/health`, `category/finance` |

**Helper:** `buildAppTags(appId, type, extras?)` builds standardized tags:

```typescript
import { buildAppTags, generateFrontmatter } from '@pas/core/utils/frontmatter';

const tags = buildAppTags('food-tracker', 'recipe', ['ingredient/chicken', 'meal/dinner']);
// => ['pas/recipe', 'pas/food-tracker', 'ingredient/chicken', 'meal/dinner']

const frontmatter = generateFrontmatter({ title: 'Chicken Stir Fry', tags });
```

#### Dataview-Friendly Frontmatter

If users install the [Dataview plugin](https://blacksmithgu.github.io/obsidian-dataview/), any frontmatter field becomes queryable. Add structured numeric/string fields for your domain:

**Food/nutrition apps:**
```yaml
calories: 450
protein: 35        # grams
carbs: 40
fat: 15
servings: 4
prep_time: 20      # minutes
cook_time: 30      # minutes
```

**Fitness apps:**
```yaml
duration: 45       # minutes
exercise_type: strength
muscle_groups: [chest, triceps, shoulders]
total_volume: 12000  # lbs
```

**General (any app):**
```yaml
rating: 4          # 1-5 scale
status: complete   # or draft, planned, etc.
cost: 12.50        # dollars
```

These enable Dataview queries like:
- `TABLE calories, protein FROM #pas/recipe WHERE calories < 500`
- `TABLE duration, exercise_type FROM #pas/workout WHERE date >= date(2026-03-01)`
- `LIST FROM #ingredient/chicken SORT date DESC`

Any frontmatter key is automatically queryable — add whatever fields make sense for your domain.

### Cross-App Integration (Future)

PAS has planned infrastructure for programmatic cross-app data discovery. While not yet implemented, designing your data with these conventions makes your app ready:

**FileIndexService (Phase 27B, planned)** — an in-memory index of all markdown file frontmatter across all apps. Will enable apps to search by tags, text, and backlinks across app boundaries:

```typescript
// Future API (not yet available)
const recipes = await services.fileIndex.searchByTags(['ingredient/chicken'], userId);
const backlinks = await services.fileIndex.getBacklinks('food-tracker/recipes/stir-fry.md', userId);
```

**CrossAppDataService (Phase 27C, planned)** — read-only access to other apps' data directories, gated by manifest `integrations` declaration:

```typescript
// Future API (not yet available)
const content = await services.crossAppData.readFile('food-tracker', userId, 'recipes/stir-fry.md');
```

**What to do now:** Use wiki-links, hierarchical tags, aliases, and Dataview-friendly fields in your frontmatter. These work in Obsidian immediately and will be indexed by the FileIndexService when it ships.

### Using External APIs

If your app needs external API keys (weather services, calendar APIs, etc.), declare them in `requirements.external_apis` and access them via `services.secrets`:

```yaml
# manifest.yaml
requirements:
  external_apis:
    - id: weather
      description: "OpenWeatherMap API for forecasts"
      required: true
      env_var: OPENWEATHER_API_KEY
    - id: geocoding
      description: "Google Geocoding for location lookup"
      required: false
      env_var: GOOGLE_GEOCODING_KEY
      fallback_behavior: "Uses hardcoded coordinates"
```

```typescript
// src/index.ts
const apiKey = services.secrets.get('weather');
if (!apiKey) {
  await services.telegram.send(ctx.userId, 'Weather API key not configured.');
  return;
}

const hasGeocoding = services.secrets.has('geocoding');
```

The infrastructure reads the declared `env_var` values from the host's environment and makes them available through `services.secrets`. This keeps API keys with the infrastructure operator (not bundled in app code), so apps can be shared without exposing credentials.

- `get(id)` returns the value or `undefined` if the env var isn't set
- `has(id)` returns `true` if the value exists (even if empty string)
- Only IDs declared in `requirements.external_apis` are accessible
- The `secrets` service is always provided (empty if no `external_apis` declared)
- Missing `required` APIs log a warning at startup but don't prevent the app from loading

### User Config

Read per-user settings declared in `user_config`:

```typescript
const limit = await services.config.get<number>('notes_per_page') ?? 10;
```

## Testing

Tests use Vitest with mock CoreServices.

```typescript
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import * as app from '../src/index.js';

describe('My App', () => {
  let services: CoreServices;

  beforeEach(() => {
    services = createMockCoreServices();
  });

  it('should init without error', async () => {
    await expect(app.init(services)).resolves.toBeUndefined();
  });

  it('should handle a message', async () => {
    await app.init(services);
    const ctx = createTestMessageContext({ text: 'hello' });
    await app.handleMessage(ctx);
    expect(services.telegram.send).toHaveBeenCalledWith('test-user', expect.any(String));
  });

  it('should read from data store', async () => {
    await app.init(services);
    const store = createMockScopedStore({ read: vi.fn().mockResolvedValue('data') });
    vi.mocked(services.data.forUser).mockReturnValue(store);
    // ... test data store interactions
  });
});
```

### Test Helpers

- `createMockCoreServices(overrides?)` — creates a complete mock `CoreServices` with all methods stubbed
- `createMockScopedStore(overrides?)` — creates a mock `ScopedDataStore`
- `createTestMessageContext(overrides?)` — creates a `MessageContext` with defaults (userId: `test-user`, text: `hello`)
- `createTestPhotoContext(overrides?)` — creates a `PhotoContext` with defaults

Run tests:

```bash
pnpm test                              # All tests
pnpm test apps/my-app                  # Just your app
npx vitest run apps/my-app --watch     # Watch mode
```

## Requirement-Driven Development

Every scaffolded app includes a `docs/` directory for tracking requirements and test coverage:

- **`docs/requirements.md`** — raw requirements organized by feature area. Write requirements here first.
- **`docs/urs.md`** — formal User Requirements Specification with test traceability. Map requirements into this file using the `REQ-<AREA>-<NNN>` format.

### Workflow

1. **Before implementation:** add requirements to `docs/requirements.md` grouped by feature area
2. **Formalize** into `docs/urs.md` with requirement IDs, all status: `Planned`
3. **List expected tests** (standard + edge cases) under each requirement
4. **After implementation:** update status to `Implemented`, replace TBD tests with actual test references
5. **Update the traceability matrix** at the bottom of the URS

### Test Categories

For each requirement, consider tests across these categories (not all apply everywhere):

- **Standard (happy path)** — normal usage, expected inputs
- **Edge cases** — boundary values, empty inputs, zero, max values
- **Error handling** — invalid inputs, failures, malformed data
- **Security** — injection attempts, path traversal, unauthorized access

See the Food app (`apps/food/docs/urs.md`) for a real-world example with 72 requirements across 17 areas, or the infrastructure URS (`docs/urs.md` at the project root) for a fully implemented example.

## External Integration & n8n

PAS has a REST API (`/api/*`) that external tools like n8n can use to read and write your app's data. This happens automatically — no extra code needed in your app.

### Your Data is Accessible

Any file your app writes via `services.data` is readable via `GET /api/data`:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:3100/api/data?userId=user1&appId=my-app&path=daily-notes/2026-03-19.md"
```

External tools can also write to your app's data directories via `POST /api/data`. If your app reads data files, consider that they may be written externally.

### Automatic Change Events

Every `write()`, `append()`, and `archive()` call on `services.data` automatically emits a `data:changed` event. The host can configure outbound webhooks in `pas.yaml` to notify n8n when data changes:

```yaml
webhooks:
  - id: n8n-data
    url: http://localhost:5678/webhook/pas-data
    events: ["data:changed"]
```

The event payload includes `{ operation, appId, userId, path, spaceId? }`.

### Custom Events

If your app needs to signal domain-specific events, declare `event-bus` in your manifest and emit custom events:

```typescript
// In your app code
services.eventBus.emit('my-app:item-created', { itemId: '123', name: 'New Item' });
```

Use the naming convention `{appId}:{action}` for custom events. The host can subscribe webhooks to your custom events the same way as built-in events.

### Structuring Data for External Consumption

To make your data easy for external tools to process:

- **Use YAML frontmatter** — see [Obsidian-Compatible Markdown](#obsidian-compatible-markdown) above for the write/read pattern
- **Use predictable file paths** — date-based paths like `daily-notes/2026-03-19.md` are easy to query programmatically
- **Use ISO 8601 dates** — `2026-03-19T14:30:00Z` instead of locale-specific formats
- **Consider JSON/YAML for machine-readable data** — markdown is great for notes, but structured data is easier to parse externally

For more details on the API endpoints and n8n integration patterns, see [`docs/n8n-integration.md`](n8n-integration.md).

## Sharing Your App

To share your app as a standalone git repo:

1. **Required files:** `manifest.yaml`, `package.json`, `tsconfig.json`, `src/index.ts`
2. **Include `pas_core_version`** in your manifest so the installer can check compatibility
3. **Push to a git host** (GitHub, GitLab, etc.)
4. **Others install with:** `pnpm install-app <git-url>`

### What the installer checks

- Manifest validates against the JSON Schema
- `pas_core_version` is compatible with the target PAS instance
- No banned imports (LLM SDKs, `child_process`)
- No symlinks in the repo

### Banned imports

Apps must not import LLM SDKs or dangerous modules directly. These are detected at install time:

- `@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama` — use `services.llm` instead
- `child_process`, `node:child_process` — not allowed

## Security

- **Apps run in-process.** There is no runtime sandbox. Static analysis catches accidental violations, not malicious intent.
- **Only install apps from people you trust.** The trust model is transparent about its limitations.
- **Services are injected.** Undeclared services are `undefined` — you can't access what you didn't declare.
- **Data access is scoped.** The `ScopedDataStore` prevents path traversal outside your declared paths.
- **LLM costs are tracked.** Per-app rate limits and monthly cost caps are enforced.

## Example Apps

- **Echo** (`apps/echo/`) — minimal example: echoes messages back. ~30 lines of code.
- **Notes** (`apps/notes/`) — practical example: save, list, and summarize notes. Demonstrates commands, intents, data storage, LLM, and user config.
- **Chatbot** (`apps/chatbot/`) — advanced example: conversational AI with context awareness, conversation history, and app metadata integration.
