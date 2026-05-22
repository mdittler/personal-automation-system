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
// Returns HandlerResult: void / {handled: true} means handled;
// {handled: false} yields to the chatbot fallback (see below).
export const handleMessage: AppModule['handleMessage'] = async (ctx) => {
  await services.telegram.send(ctx.userId, `Got: ${ctx.text}`);
};

// Optional: handles /commands declared in your manifest.
export const handleCommand: AppModule['handleCommand'] = async (command, args, ctx) => {
  await services.telegram.send(ctx.userId, `Command: ${command}, args: ${args.join(' ')}`);
};

// Optional: handles photo messages (requires accepts_photos: true in manifest).
// export const handlePhoto: AppModule['handlePhoto'] = async (ctx) => { ... };

// Optional: handles inline keyboard button taps.
// The router strips the 'app:<appId>:' prefix before calling this.
// export const handleCallbackQuery: AppModule['handleCallbackQuery'] = async (data, ctx) => { ... };

// Optional: called on shutdown. Clean up resources.
// export const shutdown: AppModule['shutdown'] = async () => { ... };
```

### Handler Return Values

`handleMessage` returns `Promise<HandlerResult>`, where `HandlerResult` is
`void | { handled: boolean }` (defined in `core/src/types/handler-result.ts`):

- Return `void` (i.e. just `return;` or fall off the end) or `{ handled: true }`
  — the message was handled by your app; the router stops here.
- Return `{ handled: false }` — your app declined the message; the router
  **yields to the chatbot fallback** so the conversational AI can respond
  instead. Use this when a message was routed to you but, on inspection, isn't
  something your app should answer.

```typescript
export const handleMessage: AppModule['handleMessage'] = async (ctx) => {
  if (!looksLikeANoteCommand(ctx.text)) {
    return { handled: false }; // let the chatbot take it
  }
  await saveNote(ctx);
  // falling off the end is equivalent to { handled: true }
};
```

`handleCommand`, `handleCallbackQuery`, and `handleScheduledJob` return
`Promise<void>` — there is no fallback for those dispatch paths.

### MessageContext

Every message handler receives a `MessageContext`:

```typescript
interface MessageContext {
  userId: string;       // Telegram user ID
  text: string;         // Message text
  timestamp: Date;      // When the message was sent
  chatId: number;       // Telegram chat ID
  messageId: number;    // Telegram message ID
  spaceId?: string;     // Active space ID (set when user is in space mode)
  spaceName?: string;   // Active space display name (for labels in responses)
}
```

`spaceId` and `spaceName` are set by the router when the user has an active shared space (set via the `/space` command). If the user is not in a space, both are `undefined`. Use `spaceName` for user-facing labels; use `spaceId` with `services.data.forSpace(spaceId, userId)` to read/write space-scoped data.

#### Users, households, and spaces — what an app developer needs to know

PAS is multi-user. Three scoping concepts affect your app:

- **User** — every message has a `userId`. Per-user data lives at
  `data/users/<userId>/<appId>/` and is reached with `services.data.forUser(userId)`.
- **Household** — users belong to a household (the multi-user grouping for a
  deployment). Some data paths are household-scoped. You don't manage households
  yourself — the infrastructure resolves the household from the active user.
- **Space** — a named, opt-in membership group for sharing data between specific
  users (created/joined via the `/space` command). When a user has an active
  space, `ctx.spaceId` is set; use `services.data.forSpace(spaceId, userId)` for
  space-scoped data. `forSpace()` throws `SpaceMembershipError` if the user is
  not a member.

You almost never thread `userId` through service calls manually:
`services.config.get(...)` and other per-user behavior resolve the active user
automatically via the infrastructure's `requestContext` (see [User Config](#user-config)).
You only pass `userId` explicitly to the data store (`forUser` / `forSpace`),
because data scope is an intentional choice your app makes.

### PhotoContext

Apps declaring `accepts_photos: true` in the manifest receive a `PhotoContext`:

```typescript
interface PhotoContext {
  userId: string;       // Telegram user ID
  photo: Buffer;        // Raw photo bytes
  caption?: string;     // Optional caption attached to the photo
  mimeType: string;     // e.g. 'image/jpeg'
  timestamp: Date;      // When the photo was sent
  chatId: number;       // Telegram chat ID
  messageId: number;    // Telegram message ID
}
```

**Return value — feeding the conversation transcript.** `handlePhoto` returns
`Promise<undefined | PhotoHandlerResult>`. To make the photo visible to the
chatbot's conversation memory, return a `PhotoSummary`:

```typescript
interface PhotoSummary {
  userTurn: string;       // Synthetic user-side turn, e.g. '[Photo: receipt]'. Keep under 100 chars.
  assistantTurn: string;  // Sanitized assistant-side confirmation, with any structured detail inline as text.
}

interface PhotoHandlerResult {
  photoSummary?: PhotoSummary;
}
```

When you return `{ photoSummary }`, the infrastructure appends a synthetic
user/assistant turn pair to the active session transcript so later chatbot
turns can reference what the photo contained. Both strings are plain text —
`SessionTurn` does not preserve structured metadata, so inline any detail the
chatbot might need. Returning `undefined` means the photo was handled but
nothing is recorded in the transcript.

> **Sending non-photo proactive messages?** The same chatbot-visibility pattern
> applies to weekly summaries, scheduled reports, alerts, voting prompts, and
> batch-prep notifications. See [Proactive Messages and the Chatbot
> Bridge](#proactive-messages-and-the-chatbot-bridge) below for the
> `AppOutboundBridge` contract — call it alongside `services.telegram.send`
> the same way you return a `PhotoSummary` here.

### CallbackContext

Apps using inline keyboard buttons receive a `CallbackContext` in `handleCallbackQuery`:

```typescript
interface CallbackContext {
  userId: string;   // Telegram user ID who tapped the button
  chatId: number;   // Chat containing the message
  messageId: number; // The message the button was on (use with editMessage)
}
```

**Callback flow pattern:**

```typescript
import type { AppModule, CallbackContext } from '@pas/core/types';

// 1. Send a message with buttons
export const handleCommand: AppModule['handleCommand'] = async (command, _args, ctx) => {
  const sent = await services.telegram.sendWithButtons(ctx.userId, 'Delete this item?', [
    [{ text: 'Yes, delete', callbackData: 'app:my-app:delete:confirm' }],
    [{ text: 'Cancel',      callbackData: 'app:my-app:delete:cancel'  }],
  ]);
  // Optionally store sent.chatId/messageId to edit the message later
};

// 2. Handle the button tap
export const handleCallbackQuery: AppModule['handleCallbackQuery'] = async (data, ctx) => {
  // 'data' is the portion after 'app:my-app:' (router strips the prefix)
  if (data === 'delete:confirm') {
    await deleteItem();
    await services.telegram.editMessage(ctx.chatId, ctx.messageId, 'Item deleted.');
  } else if (data === 'delete:cancel') {
    await services.telegram.editMessage(ctx.chatId, ctx.messageId, 'Cancelled.');
  }
};
```

## Using CoreServices

You only receive the services declared in `requirements.services`. Undeclared services will be `undefined`. Five values are always provided regardless of declarations: `config`, `secrets`, `timezone`, `dataDir`, and `logger` (see [Always-Provided Services](MANIFEST_REFERENCE.md#always-provided-services)). `dataDir` is the absolute path to the data root — you rarely need it directly; use `services.data` for scoped access.

### Sending Messages

```typescript
// Send text (supports Telegram legacy Markdown: *bold*, _italic_, `code`)
await services.telegram.send(ctx.userId, 'Hello!');

// Send a photo with optional caption
await services.telegram.sendPhoto(ctx.userId, imageBuffer, 'Here is your image');

// Send with a simple option picker (returns the text of the selected option)
const choice = await services.telegram.sendOptions(ctx.userId, 'Choose one:', ['Option A', 'Option B']);

// Send with a custom inline keyboard (returns SentMessage for later editing)
import type { InlineButton, SentMessage } from '@pas/core/types';

const sent: SentMessage = await services.telegram.sendWithButtons(ctx.userId, 'Confirm?', [
  [{ text: 'Yes', callbackData: 'app:my-app:confirm:yes' }],
  [{ text: 'No',  callbackData: 'app:my-app:confirm:no'  }],
]);

// Edit a previously sent message (e.g. after handling a callback)
await services.telegram.editMessage(sent.chatId, sent.messageId, 'Done!');
```

**Callback data format:** prefix with `app:<appId>:` so the router strips the prefix before passing `data` to your `handleCallbackQuery`. Telegram limits the full `callbackData` payload to 64 bytes, including the `app:<appId>:` prefix.

**Message length:** Telegram limits messages to 4096 characters. If you send longer responses (e.g. LLM completions, data dumps), split them first:

```typescript
function splitMessage(text: string, maxLength = 3800): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    // Split at paragraph boundary, then line, then hard-cut
    let split = remaining.lastIndexOf('\n\n', maxLength);
    if (split === -1) split = remaining.lastIndexOf('\n', maxLength);
    if (split === -1) split = maxLength;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

const parts = splitMessage(longResponse);
for (const part of parts) {
  await services.telegram.send(ctx.userId, part);
}
```

See `core/src/services/conversation/telegram-format.ts` for the production `splitTelegramMessage()` implementation that the built-in chatbot uses.

### Proactive Messages and the Chatbot Bridge

When your app sends a message to a user outside of a direct user-to-bot turn —
weekly summaries, scheduled reports, alerts, voting prompts — call the
**AppOutboundBridge** in addition to `services.telegram.send` so the chatbot
can see what you sent. Users naturally follow up about messages they receive
("what was on the menu?"); the bridge gives the chatbot the context it needs.

This is the non-photo counterpart to the [`PhotoSummary` return value](#photocontext)
your `handlePhoto` handler uses. The mechanics are the same — a synthetic
user/assistant exchange is appended to the user's chat session transcript with
a header that lifts the per-turn truncation cap. The difference is that photo
summaries are returned synchronously from a photo handler, whereas the bridge
is called wherever your app initiates an outbound send.

**Required manifest declaration.** To receive `services.appOutboundBridge`,
declare the service in your manifest:

```yaml
requirements:
  services:
    - telegram
    - app-outbound-bridge
```

**Contract:**

```typescript
await services.telegram.send(userId, body);
await services.appOutboundBridge?.recordOutboundMessage({
  userId,
  appId: 'your-app-id',        // your app's manifest id; [a-z0-9_-]{1,32}
  kind: 'weekly-summary',      // short stable identifier; [a-z0-9_:-]{1,64}
  body,                         // exact text sent over Telegram
  buttons: inlineButtonRows,    // optional InlineButton[][] from sendWithButtons
});
```

The bridge is fail-open: a failure to record never throws into the caller, but
**only call it after `services.telegram.send` resolves**. If the send rejected,
the user did not see the message and it should not be recorded.

The user controls visibility via the `chat.app_message_bridge_enabled` setting
(default ON). Do not gate your own delivery on the bridge; just call it.

**Pair the send and the bridge call.**
Two separate calls (`telegram.send` then `appOutboundBridge.recordOutboundMessage`) is fragile — the next person adding a proactive message forgets the second one. Wrap the pair in one helper per app and route every proactive send through it.

The Food app's `sendProactiveMessage` is the reference implementation:
```typescript
// apps/food/src/utils/proactive-message.ts
export type FoodProactiveKind = 'weekly-menu' | 'nightly-rating-prompt' | /* ... */;

export async function sendProactiveMessage(
  services: CoreServices,
  opts: { userId: string; kind: FoodProactiveKind; body: string; buttons?: InlineButton[][] },
): Promise<SentMessage | undefined> {
  // 1. await telegram.send / sendWithButtons (the latter returns SentMessage)
  // 2. try { await services.appOutboundBridge?.recordOutboundMessage({...}) }
  //    catch (err) { logger.warn(...) }  -- fail-open
  // 3. return the SentMessage (callers needing messageId for callback resolution use it)
}
```

Properties enforced by the helper:
- **Typed `kind` union** — invalid `kind` literals fail compilation; all values must satisfy `KIND_RE: /^[a-z0-9_:-]{1,64}$/`.
- **Send-then-bridge ordering** — a rejected `telegram.send` skips the bridge (the user never saw the message; the transcript correctly has nothing to record).
- **Fail-open** — a bridge failure after a successful send logs and continues; an app delivery never depends on the chatbot transcript being writeable.
- **Raw body passthrough** — the body sent to Telegram is byte-identical to the body sent to the bridge. The bridge owns sanitization.
- **Return value preserved** — `SentMessage` is returned for the buttons path so callers needing `messageId` (callback resolution, message editing) keep working.

Apps with proactive sends SHOULD provide an equivalent `proactive-message.ts` wrapper and a static guard test (next subsection) so a future un-bridged proactive send fails CI.

**Automated guard.**
Pair the helper with a build-failing static guard so a developer who forgets to use the helper fails CI immediately. The Food app's guard is `apps/food/src/__tests__/proactive-send-guard.test.ts`, backed by the AST scanner `apps/food/src/testing/proactive-send-scan.ts`:

- Maintain a `PROACTIVE_ENTRYPOINTS` set of function names that are allowed to perform proactive Telegram sends.
- The scanner walks each `.ts` file (excluding `__tests__/`, `testing/`, and the helper itself), parses with the TypeScript compiler API, and flags any `*.telegram.send` / `*.telegram.sendWithButtons` call whose immediate enclosing function name is in `PROACTIVE_ENTRYPOINTS` (since after migration, those should ALL go through the helper).
- On failure the test emits a message naming the offending file/function/line and pointing the developer at the helper and this document.
- Adding a new proactive job means either (a) routing the send through the helper, or (b) explicitly adding the new entrypoint name to `PROACTIVE_ENTRYPOINTS` and routing it through the helper. The set is the deliberate audit point.

**When NOT to call it:**

- Direct replies to user input (handler return values) — those are already in
  the transcript via the normal user-bot turn path.
- Photo-handler results — return a `PhotoSummary` instead; see [PhotoContext](#photocontext).
- Internal `dispatch_message` plumbing — the synthesized message routes
  through another app's handler whose visible output, if any, is captured by
  that app's own bridge calls.
- Admin-only / operator notifications that aren't user-visible.
- Alert / warning text **appended to another message's body** is covered by that host message's bridge call. Don't bridge it separately — you'll double-record the same content in the transcript. Verified-reactive examples in the Food app today: budget alerts (text appended to the weekly-menu plan message in `index.ts` ~line 3148), the hosting planner (sends only in response to `/hosting plan` and NL hosting intents), child-tracker output (sends only via `/family` subcommand replies in `handlers/family.ts`), and grocery generation (sends only from message handlers and the post-vote `'generate-grocery'` callback in `index.ts` ~lines 1553 / 2897). None of these have `schedules:` entries in the manifest and none are reached from `handleScheduledJob` — they are user-initiated replies, already in the transcript via the normal user-turn path.

**Naming `kind`:**

- Use a short, stable identifier the chatbot can pattern-match on.
- Examples: `weekly-menu`, `weekly-nutrition`, `report:weekly-spend`,
  `alert:expiry-warning:telegram`, `batch-prep`.
- If you have a user-supplied name (e.g., an alert title), run it through
  `toAppMessageKind(name)` from `@pas/core/services/app-outbound-bridge` so
  invalid characters get slugged instead of silently rejected.
- Avoid timestamps or run IDs in `kind` — those go in `body`.

**Header format (visible to the chatbot):**

The bridge writes a synthetic user turn with the literal content
`[App: <appId>] <kind>`. The chatbot's system prompt explains this convention
to the LLM (`APP_MESSAGE_GUIDANCE`). Keep `appId` and `kind` stable across
releases — the chatbot may pattern-match on either field.

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
const shared = services.data.forShared('shared');

// Space-scoped data (scoped to data/spaces/<spaceId>/<appId>/)
// spaceId comes from MessageContext — only defined when user is in space mode
if (ctx.spaceId) {
  const spaceStore = services.data.forSpace(ctx.spaceId, ctx.userId);
  await spaceStore.write('shared-list.yaml', content);
} else {
  // Fall back to per-user data when not in a space
  const userStore = services.data.forUser(ctx.userId);
  await userStore.write('my-list.yaml', content);
}
// Note: forSpace() throws SpaceMembershipError if the user is not a member of that space.

// Archive a file by moving it to a timestamped filename in the same directory
await store.archive('items.md');
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

### Security Utilities

**Always escape user/stored data before sending Telegram messages. Always sanitize user input before LLM prompts.**

**Escaping for Telegram:**

```typescript
import { escapeMarkdown } from '@pas/core/utils/escape-markdown';

// Escape user input or stored data before interpolating into Telegram Markdown
const title = escapeMarkdown(userProvidedTitle); // escapes *, _, [, ], (, ), etc.
await services.telegram.send(ctx.userId, `Your item: *${title}*`);
```

Without escaping, a user named "John *Smith*" would corrupt your message formatting — or worse, a malicious input could close/open formatting spans to inject bold or italic spans.

**Sanitizing for LLM prompts:**

When user text is interpolated into an LLM prompt, sanitize it first to prevent prompt injection (users trying to override your instructions by hiding commands inside their input):

```typescript
// Baseline sanitizer — truncates and neutralizes backtick sequences.
// Safe for most prompts where the user text is system-framed (not fence-delimited).
function sanitizeInput(text: string, maxLength = 10000): string {
  const truncated = text.length > maxLength ? text.slice(0, maxLength) : text;
  return truncated.replace(/[\u0060\uFF40]{3,}/g, '`');
}

const safeText = sanitizeInput(ctx.text);
const answer = await services.llm.complete(`Summarize: ${safeText}`, { tier: 'standard' });
```

For prompts that delimit the user section with fence sentinels (e.g. `--- BEGIN user input ---`), copy or adapt the hardened pattern from the food app (`apps/food/src/utils/sanitize.ts`), which also strips newlines and scrubs fence strings from user input. Do not import from another app at runtime.

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

### Programmatic Data Discovery

PAS maintains an internal **FileIndexService** (`core/src/services/file-index/`)
— a metadata index of markdown frontmatter across all apps, built at startup and
refreshed on `data:changed` events. It is **infrastructure-only**: it is not
exposed on `CoreServices`, so apps cannot call it directly.

The **app-facing** way to search data is `services.dataQuery` (declare the
`data-query` service). It runs natural-language queries over indexed data files
and is the surface the chatbot's `/ask` and `/edit` flows use. See the
[Other Available Services](#other-available-services) table above.

The index is derived and disposable — `.md` files are always the source of
truth, and the index can be rebuilt from them at any time.

**Why the conventions still matter:** Using wiki-links, hierarchical tags,
aliases, and Dataview-friendly frontmatter fields makes your data work in
Obsidian immediately *and* makes it discoverable by the file index and
`services.dataQuery`. Well-structured frontmatter is the input both rely on.

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

**Per-user propagation is automatic.** The infrastructure establishes the active user's context (via an internal `requestContext` AsyncLocalStorage) at every dispatch point — `handleMessage`, `handleCommand`, `handlePhoto`, `handleCallbackQuery`, `handleScheduledJob` (when `user_scope: all`), alert actions, API messages, and GUI simulated messages. Your app just calls `services.config.get(key)` and the returned value reflects the calling user's override (set in the management GUI) when one exists, otherwise the manifest default. You never need to pass a userId to `config.get(...)`.

**Scheduled jobs.** When a manifest schedule declares `user_scope: all`, the scheduler invokes your handler once per registered user and passes that user's id as the second argument:

```typescript
export const handleScheduledJob: AppModule['handleScheduledJob'] = async (
  jobId: string,
  userId?: string, // set for user_scope: all, undefined for shared/system jobs
) => {
  if (jobId === 'weekly-digest' && userId) {
    // services.config.get(...) returns userId's overrides automatically
    const style = await services.config.get<string>('digest_style');
    // ... build per-user digest
  }
};
```

For `user_scope: shared` or `system` jobs the handler runs once with `userId` undefined; cross-user iteration (if any) is your app's responsibility, but you can wrap each iteration in `services` calls normally — the scheduled-job context already has no user bound, so you get manifest defaults unless you iterate users explicitly.

### Other Available Services

These services are available to apps that declare them in `requirements.services`. See [MANIFEST_REFERENCE.md](MANIFEST_REFERENCE.md) for the manifest keys.

| Service | Manifest key | When to use |
|---------|-------------|------------|
| `services.audio` | `audio` | Text-to-speech via Piper TTS, optionally cast to Chromecast. `speak(text, device?)` for fire-and-forget delivery; `tts(text)` to get raw audio bytes. |
| `services.conditionEvaluator` | `condition-eval` | Programmatic evaluation of rule files (deterministic or fuzzy/LLM conditions). `evaluate(ruleId)` returns true/false. |
| `services.appMetadata` | `app-metadata` | Read-only metadata about installed apps. `getEnabledApps(userId)` returns apps enabled for a user; useful for building context-aware responses. |
| `services.appKnowledge` | `app-knowledge` | Full-text search over app help files and docs. `search(query, userId?)` — same index the `/ask` chatbot uses. |
| `services.modelJournal` | `model-journal` | Persistent per-model markdown files the LLM can write to. `append(modelSlug, content)` and `read(modelSlug)`. Useful for apps that want the AI to keep notes across sessions. |
| `services.systemInfo` | `system-info` | Read-only system introspection: `getTierAssignments()`, `getCostSummary()`, `getScheduledJobs()`, `getSystemStatus()`, `isUserAdmin(userId)`. Write: `setTierModel(tier, provider, model)`. |
| `services.dataQuery` | `data-query` | Natural-language queries over your app's indexed data files. The app-facing data-search surface. **Optional** — `services.dataQuery` is `undefined` unless declared. |
| `services.interactionContext` | `interaction-context` | Per-user in-memory buffer of recent file interactions, for building context-aware responses. **Optional** — `undefined` unless declared. |
| `services.editService` | `edit-service` | LLM-assisted file editing with a propose/confirm flow and a SHA-256 stale-write guard. Powers the built-in `/edit` command. **Optional** — `undefined` unless declared. |

The last three are optional services — guard for `undefined` before use, since
an app that forgets to declare the manifest key will not receive them. See the
type files (`core/src/types/data-query.ts`, `core/src/services/interaction-context/`,
`core/src/services/edit/`) for full method signatures.

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

## Testing Model Behavior with the Regression Suite

Vitest unit tests verify your app's *logic*. They don't tell you whether a
change of LLM model still routes and answers correctly — that needs real LLM
calls. PAS has a separate **regression suite** for that: a fixture-backed,
cached, real-LLM harness in the top-level `regression/` workspace. It is
deliberately excluded from `pnpm test` so it doesn't run on every push.

### What it does

The suite runs a set of *persona cases* through real classifiers/handlers and
grades the output with an oracle (a JSON-schema/assertion check, or an
LLM judge). Its main job is letting you **swap an LLM model and measure the
accuracy delta** before committing to the change.

Run it with:

```bash
pnpm test:regression                        # all cases, respects the cache
pnpm test:regression -- --dry-run            # list selected cases + estimated cost, no LLM calls
pnpm test:regression -- --list               # emit the case list (NDJSON), no dispatch
pnpm test:regression -- --bucket=routing     # one bucket only
pnpm test:regression -- --rerun <case-id>    # force a fresh dispatch for one case
pnpm test:regression -- --no-cache           # force fresh dispatch for every case
```

### Swapping a model

Point the suite at a different model with `--model-matrix` (overrides tier
models) and `--judge-model` (overrides the LLM-judge oracle's model):

```bash
# Positional: fast, standard, reasoning — in order
pnpm test:regression -- --model-matrix=anthropic/claude-haiku-4-5,anthropic/claude-sonnet-4-6

# Named tiers (mix positional + named is allowed; named wins on conflict)
pnpm test:regression -- --model-matrix=fast=ollama/gemma3:12b,standard=anthropic/claude-sonnet-4-6

# Override just the judge model used by rubric oracles
pnpm test:regression -- --judge-model=anthropic/claude-haiku-4-5
```

The cache key is **model-ID-aware**: a different model ID produces a different
cache entry, so each model gets its own cached results and you can compare them
cleanly. (Known caveat, tracked in `docs/open-items.md`: the cache key is not
provider-qualified yet — the same model name under two different providers
would collide. Provider-qualified keys are deferred.)

The `/gui/regression` admin page wraps all of this in a UI: a model-override
form, a per-tier leaderboard, auto-generated weakness summaries, and
performance-over-time charts.

### Feeding your app's cases into the suite — current state

The suite's buckets are **fixed and core-level**: `routing`, `receipt`,
`chatbot`, and `recall`. There is **no generic per-app extension API** yet — an
app cannot register its own bucket or case directory.

The one concrete pattern available today is **food-specific**: the food app
contributes routing cases via shadow-classifier *personas*. Adding a label plus
accept-phrases to `apps/food/src/routing/__tests__/shadow-classifier.personas.ts`
auto-generates a routing regression case. See `regression/README.md`
("Adding a new routing case") for the mechanics.

If you are building an app that needs model-behavior regression coverage, this
is a known gap — see the *"generic per-app test discovery"* proposal in
`docs/open-items.md`.

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

### Context Store

The context store is a lightweight per-user + system knowledge base for storing preferences, facts, and notes that the chatbot and other apps can reference. Apps can read system context, search user + system context, and save/remove per-user entries.

```yaml
# manifest.yaml
requirements:
  services:
    - context-store
```

```typescript
// Save a user preference or fact
await services.contextStore.save(ctx.userId, 'preferred-units', 'metric');

// Read with user-first fallback (user override > system default)
const units = await services.contextStore.getForUser('preferred-units', ctx.userId);

// Search the knowledge base (returns entries matching the query)
const results = await services.contextStore.searchForUser('dietary restrictions', ctx.userId);
for (const entry of results) {
  // entry.key, entry.content, entry.lastUpdated
}

// Remove an entry
await services.contextStore.remove(ctx.userId, 'preferred-units');
```

Context store entries are short-lived facts ("user is vegetarian", "user prefers metric units"). For structured app data (lists, logs, configurations), use the data store instead.

### Dynamic Scheduling

For one-off delayed actions (reminders, follow-up messages, retry timers), use `services.scheduler`:

```yaml
# manifest.yaml
requirements:
  services:
    - scheduler
```

```typescript
// Schedule a one-off job
const runAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
await services.scheduler.scheduleOnce('my-app', 'reminder-123', runAt, 'reminder');
// The 4th argument is stored with the task for readability, but dispatch still
// calls your app's handleScheduledJob(jobId).

// Cancel a pending job (e.g. user cancelled the action)
await services.scheduler.cancelOnce('my-app', 'reminder-123');
```

When the job fires, the infrastructure runs it as system scope and calls `handleScheduledJob(jobId)` on your app. Use a unique `jobId` per instance (e.g. include the userId or item ID):

```typescript
export const handleScheduledJob: AppModule['handleScheduledJob'] = async (jobId) => {
  if (jobId.startsWith('reminder-')) {
    const userId = jobId.replace('reminder-', '');
    await services.telegram.send(userId, 'Reminder: check your items!');
  }
};
```

One-off jobs always run as system scope (no userId in context). For short in-process timers (< 1 minute, not needing persistence across restarts), `setTimeout` is simpler and sufficient.

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

**Emitting events** — declare `event-bus` in requirements and emit with the `{appId}:{action}` convention:

```typescript
// In your app code
services.eventBus.emit('my-app:item-created', { itemId: '123', name: 'New Item' });
```

**Subscribing to events** — declare subscriptions in your manifest and handle them in `init()`:

```yaml
# manifest.yaml
capabilities:
  events:
    emits:
      - id: my-app:item-created
        description: "Fired when a new item is created"
    subscribes:
      - event: other-app:data-ready
        handler: handleDataReady
        required: false  # false = optional dependency; app loads even if other-app is absent
```

```typescript
// src/index.ts
export const init: AppModule['init'] = async (s) => {
  services = s;

  // Wire up event subscriptions manually in init()
  services.eventBus.on('other-app:data-ready', async (payload) => {
    const data = payload as { userId: string; items: string[] };
    await processItems(data.userId, data.items);
  });
};
```

The `subscribes` manifest declaration is informational (documents dependencies) — you still wire up handlers manually in `init()`. The `required` flag is metadata for dependency intent; it is not currently enforced at runtime or install time.

**`data:changed` events** fire automatically on every `write()`, `append()`, and `archive()` call — your app does not need to emit these manually. See [Automatic Change Events](#automatic-change-events) for the payload shape.

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
- **Food** (`apps/food/`) — full-featured example: household food management with recipes, grocery lists, pantry tracking, photo (receipt) handling, scheduled jobs, and cost tracking. The most complete reference for a real-world app.

> The conversational AI fallback ("chatbot") is **not** an app — it is built
> into the infrastructure at `core/src/services/conversation/`. There is no
> `apps/chatbot/` directory.
