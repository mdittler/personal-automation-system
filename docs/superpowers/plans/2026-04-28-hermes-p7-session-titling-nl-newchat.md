# Hermes P7 — Session Auto-Titling + Natural-Language /newchat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session auto-titling (fast-tier LLM, fire-and-forget after first exchange), manual `/title` command, and natural-language `/newchat` intent classifier (keyword pre-filter + fast-tier LLM with grey-zone confirmation buttons) to the existing Hermes session pipeline.

**Architecture:** Two independently shippable chunks. Chunk A adds title generation + persistence: a `TitleService` wraps `ChatSessionStore.setTitle` (frontmatter) + `ChatTranscriptIndex.updateTitle` (SQLite); auto-titling fires fire-and-forget after `appendExchange`; manual `/title` is a Router built-in. Chunk B adds an NL /newchat classifier inserted into `routeMessage` between the wizard intercept and parsed-command match: high-confidence (≥0.85) auto-dispatches, grey-zone (0.60–0.85) shows inline Telegram buttons backed by a purpose-built `PendingSessionControlStore`.

**Tech Stack:** Node.js 22 + TypeScript 5 (ESM); Vitest; better-sqlite3 (existing transcript index); Pino (logger); Telegram inline keyboards via `TelegramService.sendWithButtons` (existing); fast-tier LLM via `LLMService.complete` (existing).

**Spec:** `docs/superpowers/specs/2026-04-28-hermes-p7-session-titling-nl-newchat-design.md`

**Critical invariant:** REQ-CONV-MEMORY-012 — only the `title` field of session frontmatter ever changes. All other decoded fields and turns are semantically preserved (test by decoded comparison, not raw bytes).

---

## File Structure

### New files
| Path | Responsibility |
|---|---|
| `core/src/services/conversation-titling/title-generator.ts` | Pure function: generate a 3–7 word title from first exchange via fast-tier LLM with fenced untrusted input |
| `core/src/services/conversation-titling/title-service.ts` | `TitleService.applyTitle()` — wraps `setTitle` + `updateTitle` atomically (sequential, best-effort) |
| `core/src/services/conversation-titling/auto-title-hook.ts` | Fire-and-forget orchestrator: generate → applyTitle, all errors caught |
| `core/src/services/conversation-titling/index.ts` | Barrel export |
| `core/src/services/conversation-titling/__tests__/title-generator.test.ts` | Unit tests for generator (sanitization, rejection, error paths) |
| `core/src/services/conversation-titling/__tests__/title-service.test.ts` | Unit tests for TitleService |
| `core/src/services/conversation-titling/__tests__/auto-title-hook.test.ts` | Unit tests for fire-and-forget orchestrator |
| `core/src/services/conversation-retrieval/session-control-classifier.ts` | `sessionControlPreFilter` + `classifySessionControlIntent` |
| `core/src/services/conversation-retrieval/pending-session-control-store.ts` | TTL map with injectable clock + rng for grey-zone state |
| `core/src/services/conversation-retrieval/__tests__/session-control-classifier.test.ts` | Pre-filter and classifier tests |
| `core/src/services/conversation-retrieval/__tests__/pending-session-control-store.test.ts` | TTL store tests |
| `core/src/services/conversation/__tests__/auto-titling.persona.test.ts` | End-to-end persona tests for auto-title + manual /title |
| `core/src/services/conversation/__tests__/nl-newchat.persona.test.ts` | End-to-end persona tests for NL /newchat |

### Modified files
| Path | Change |
|---|---|
| `core/src/services/chat-transcript-index/chat-transcript-index.ts` | Add `updateTitle` to interface + impl |
| `core/src/services/conversation-session/chat-session-store.ts` | Add `setTitle` to interface + impl |
| `core/src/services/conversation/handle-message.ts` | Add `titleService?` to `HandleMessageDeps`; schedule auto-title hook after `appendExchange` |
| `core/src/services/conversation/conversation-service.ts` | Add `handleTitle(args, ctx)` method + accept `titleService` in deps |
| `core/src/services/router/index.ts` | Add `/title` to `BUILTIN_COMMAND_NAMES` + dispatch + extend union; insert NL /newchat hook |
| `core/src/compose-runtime.ts` | Construct + inject `TitleService`, `SessionControlClassifier`, `PendingSessionControlStore`, callback handler |
| `core/src/services/conversation/__tests__/conversation-service.test.ts` | Update `makeNullChatSessions()` mock + add handleTitle tests |
| `docs/urs.md` | Add REQ-CONV-TITLE-001..008 + REQ-CONV-NEWCHAT-001..008 |
| `docs/USER_GUIDE.md` (if exists) | Document `/title` |
| `core/docs/help/commands-and-routing.md` (if exists) | Document `/title` + NL /newchat |
| `docs/implementation-phases.md` | Add Hermes P7 row |
| `docs/open-items.md` | Close Hermes P7 line (carry-forward already added) |
| `CLAUDE.md` | Status update |

---

# Chunk A — Auto-Titling + Manual /title

## Task A1: Add `updateTitle` to ChatTranscriptIndex

**Files:**
- Modify: `core/src/services/chat-transcript-index/chat-transcript-index.ts`
- Test: `core/src/services/chat-transcript-index/__tests__/update-title.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `core/src/services/chat-transcript-index/__tests__/update-title.test.ts`:

```typescript
/**
 * Tests for ChatTranscriptIndex.updateTitle (Hermes P7).
 *
 * Covers:
 *  - Updates title for an existing session row
 *  - Returns { updated: false } for non-existent sessionId
 *  - Returns { updated: false } for wrong user_id
 *  - Empty title is accepted (TitleService rejects upstream; this layer is dumb)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatTranscriptIndex } from '../index.js';
import type { ChatTranscriptIndex } from '../chat-transcript-index.js';

describe('ChatTranscriptIndex.updateTitle', () => {
	let dir: string;
	let index: ChatTranscriptIndex;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'pas-cti-'));
		index = createChatTranscriptIndex(join(dir, 'cti.db'));
	});

	afterEach(() => {
		index.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('updates title for existing session', async () => {
		await index.upsertSession({
			id: 'sess-1',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2024-01-01T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: null,
		});
		const result = await index.updateTitle('u1', 'sess-1', 'Planning weekly groceries');
		expect(result).toEqual({ updated: true });
		const row = await index.getSessionMeta('sess-1');
		expect(row?.title).toBe('Planning weekly groceries');
	});

	it('returns { updated: false } for missing sessionId', async () => {
		const result = await index.updateTitle('u1', 'sess-nonexistent', 'whatever');
		expect(result).toEqual({ updated: false });
	});

	it('returns { updated: false } when user_id does not match the row', async () => {
		await index.upsertSession({
			id: 'sess-2',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2024-01-01T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: null,
		});
		const result = await index.updateTitle('u2', 'sess-2', 'cross-user attempt');
		expect(result).toEqual({ updated: false });
		const row = await index.getSessionMeta('sess-2');
		expect(row?.title).toBeNull();
	});

	it('overwrites an existing title', async () => {
		await index.upsertSession({
			id: 'sess-3',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2024-01-01T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: 'old title',
		});
		await index.updateTitle('u1', 'sess-3', 'new title');
		const row = await index.getSessionMeta('sess-3');
		expect(row?.title).toBe('new title');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/chat-transcript-index/__tests__/update-title.test.ts`
Expected: FAIL — `updateTitle` is not a function on `ChatTranscriptIndex`.

- [ ] **Step 3: Add `updateTitle` to the interface**

In `core/src/services/chat-transcript-index/chat-transcript-index.ts`, add to the `ChatTranscriptIndex` interface (alongside `upsertSession`, `endSession`, etc.). The schema already has a `title TEXT` column on `sessions` (see `schema.ts:6-15`), so no migration is required.

```typescript
updateTitle(userId: string, sessionId: string, title: string): { updated: boolean };
```

(Synchronous — `ChatTranscriptIndexImpl` is built on better-sqlite3 and other methods like `upsertSession` are synchronous as well. Match the existing style.)

- [ ] **Step 4: Implement `updateTitle` on `ChatTranscriptIndexImpl`**

In the same file, add the method body on `ChatTranscriptIndexImpl` (place near `upsertSession` for cohesion). Follow the existing prepared-statement pattern used in the file:

```typescript
updateTitle(userId: string, sessionId: string, title: string): { updated: boolean } {
	const result = this.db
		.prepare('UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?')
		.run(title, sessionId, userId);
	return { updated: result.changes > 0 };
}
```

(If the existing class wraps writes in a helper or transaction, mirror that. Read the actual class shape before adding the method — do not invent helpers like `withSqliteRetry` or `maybeCheckpoint` unless they already exist.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/chat-transcript-index/__tests__/update-title.test.ts`
Expected: PASS — all 4 tests green.

(Note: tests above use sync `index.close()` and the `createChatTranscriptIndex` factory. If your test discovers the impl is actually async, mirror the actual impl signature.)

- [ ] **Step 6: Commit**

```bash
git add core/src/services/chat-transcript-index/chat-transcript-index.ts core/src/services/chat-transcript-index/__tests__/update-title.test.ts
git commit -m "feat(hermes-p7): add ChatTranscriptIndex.updateTitle"
```

---

## Task A2: Add `setTitle` to ChatSessionStore

**Files:**
- Modify: `core/src/services/conversation-session/chat-session-store.ts`
- Test: `core/src/services/conversation-session/__tests__/set-title.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `core/src/services/conversation-session/__tests__/set-title.test.ts`:

```typescript
/**
 * Tests for ChatSessionStore.setTitle (Hermes P7).
 *
 * Covers all edge cases from spec table:
 *  - Missing session file → { updated: false } + warn
 *  - Corrupt YAML frontmatter → { updated: false } + warn
 *  - skipIfTitled: true with non-null existing title → { updated: false }
 *  - Empty / whitespace-only title → { updated: false }
 *  - Title > 80 chars → truncate
 *  - Title with newlines / control chars → strip
 *  - Normal write preserves all other frontmatter and turns (decoded comparison)
 */

import { describe, expect, it } from 'vitest';
import { makeStoreFixture } from './fixtures.js';

describe('ChatSessionStore.setTitle', () => {
	it('returns { updated: false } when session file is missing', async () => {
		const { store, warnings } = await makeStoreFixture();
		const result = await store.setTitle('u1', '20260101_120000_aaaaaaaa', 'Some title');
		expect(result).toEqual({ updated: false });
		expect(warnings.some((w) => /missing|not found/i.test(w))).toBe(true);
	});

	it('writes title to existing session and preserves all other fields', async () => {
		const { store, ensure, readDecoded } = await makeStoreFixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		const before = await readDecoded('u1', sessionId!);

		const result = await store.setTitle('u1', sessionId!, 'Weekly grocery planning');
		expect(result).toEqual({ updated: true });

		const after = await readDecoded('u1', sessionId!);
		expect(after.meta.title).toBe('Weekly grocery planning');
		// Semantic preservation — every other decoded field unchanged.
		expect(after.meta.id).toBe(before.meta.id);
		expect(after.meta.user_id).toBe(before.meta.user_id);
		expect(after.meta.household_id).toBe(before.meta.household_id);
		expect(after.meta.source).toBe(before.meta.source);
		expect(after.meta.model).toBe(before.meta.model);
		expect(after.meta.started_at).toBe(before.meta.started_at);
		expect(after.meta.ended_at).toBe(before.meta.ended_at);
		expect(after.meta.token_counts).toEqual(before.meta.token_counts);
		expect(after.meta.memory_snapshot).toEqual(before.meta.memory_snapshot);
		expect(after.turns).toEqual(before.turns);
	});

	it('skipIfTitled: true is a no-op when title is already non-null', async () => {
		const { store, ensure } = await makeStoreFixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		await store.setTitle('u1', sessionId!, 'Manual title');

		const result = await store.setTitle('u1', sessionId!, 'Auto title', { skipIfTitled: true });
		expect(result).toEqual({ updated: false });
	});

	it('skipIfTitled: true writes when title is null', async () => {
		const { store, ensure } = await makeStoreFixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		const result = await store.setTitle('u1', sessionId!, 'Auto title', { skipIfTitled: true });
		expect(result).toEqual({ updated: true });
	});

	it('rejects empty title', async () => {
		const { store, ensure } = await makeStoreFixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		expect(await store.setTitle('u1', sessionId!, '')).toEqual({ updated: false });
		expect(await store.setTitle('u1', sessionId!, '   ')).toEqual({ updated: false });
		expect(await store.setTitle('u1', sessionId!, '\n\t')).toEqual({ updated: false });
	});

	it('truncates title longer than 80 chars', async () => {
		const { store, ensure, readDecoded } = await makeStoreFixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		const long = 'a'.repeat(120);
		await store.setTitle('u1', sessionId!, long);
		const after = await readDecoded('u1', sessionId!);
		expect(after.meta.title).toBe('a'.repeat(80));
	});

	it('strips newlines and control characters', async () => {
		const { store, ensure, readDecoded } = await makeStoreFixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		await store.setTitle('u1', sessionId!, 'Line1\nLine2 trailing');
		const after = await readDecoded('u1', sessionId!);
		expect(after.meta.title).toBe('Line1 Line2 trailing');
		expect(after.meta.title).not.toContain('\n');
	});

	it('returns { updated: false } and warns on corrupt frontmatter', async () => {
		const { store, ensure, corruptSessionFile, warnings } = await makeStoreFixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		await corruptSessionFile('u1', sessionId!);
		const result = await store.setTitle('u1', sessionId!, 'doomed');
		expect(result).toEqual({ updated: false });
		expect(warnings.some((w) => /corrupt/i.test(w))).toBe(true);
	});
});
```

If `core/src/services/conversation-session/__tests__/fixtures.js` does not exist, also create it. Look at existing tests in `core/src/services/conversation-session/__tests__/` for the fixture pattern. The fixture should expose:
- `store: ChatSessionStore` — backed by an in-memory or temp-dir DataStore
- `ensure(opts)` — calls `ensureActiveSession` and returns `{ sessionId }`
- `readDecoded(userId, sessionId)` — calls the internal `decode()` helper or reads via `readSession` (since that returns decoded content already)
- `corruptSessionFile(userId, sessionId)` — overwrites the session file with malformed YAML
- `warnings: string[]` — captured `logger.warn` calls

**If a similar fixture already exists** (likely `make-test-store` or similar), reuse and extend it rather than duplicating.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation-session/__tests__/set-title.test.ts`
Expected: FAIL — `setTitle` is not a function.

- [ ] **Step 3: Add `setTitle` to the `ChatSessionStore` interface**

In `core/src/services/conversation-session/chat-session-store.ts`, alongside `endActive` (around line 85), add:

```typescript
setTitle(
	userId: string,
	sessionId: string,
	title: string,
	opts?: { skipIfTitled?: boolean },
): Promise<{ updated: boolean }>;
```

- [ ] **Step 4: Implement `setTitle` on `DefaultChatSessionStore`**

Model the implementation on `endActive` (lines 352–396 of `chat-session-store.ts`). Add this method (place near `endActive`):

```typescript
async setTitle(
	userId: string,
	sessionId: string,
	title: string,
	opts: { skipIfTitled?: boolean } = {},
): Promise<{ updated: boolean }> {
	if (!SESSION_ID_RE.test(sessionId)) return { updated: false };

	const sanitized = sanitizeTitle(title);
	if (sanitized === null) return { updated: false };

	let updated = false;
	await withFileLock(`conversation-session-transcript:${userId}:${sessionId}`, async () => {
		const store = this.deps.data.forUser(userId);
		const path = `conversation/sessions/${sessionId}.md`;
		const raw = await store.read(path);
		if (raw === '') {
			this.deps.logger.warn({ sessionId }, 'conversation-session: setTitle on missing session file');
			return;
		}
		let decoded: { meta: ChatSessionFrontmatter; turns: SessionTurn[] };
		try {
			decoded = decode(raw);
		} catch (err) {
			if (err instanceof CorruptTranscriptError) {
				this.deps.logger.warn({ sessionId, err }, 'conversation-session: corrupt transcript on setTitle');
				return;
			}
			throw err;
		}
		if (opts.skipIfTitled && typeof decoded.meta.title === 'string' && decoded.meta.title.trim().length > 0) {
			return;
		}
		decoded.meta.title = sanitized;
		let next = encodeNew(decoded.meta);
		for (const t of decoded.turns) next = encodeAppend(next, t);
		await store.write(path, next);
		updated = true;
	});

	return { updated };
}
```

Add the `sanitizeTitle` helper (top of the same file, near other private helpers, or in a small section above the class):

```typescript
const TITLE_MAX_LEN = 80;

function sanitizeTitle(input: string): string | null {
	// Replace newlines/tabs and strip control chars (0x00–0x1F + 0x7F), preserve whitespace as space.
	const cleaned = input
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/[\x00-\x1F\x7F]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return null;
	return cleaned.slice(0, TITLE_MAX_LEN);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation-session/__tests__/set-title.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 6: Update all `ChatSessionStore` test mocks**

Search for test mocks of `ChatSessionStore`:

```bash
git grep -nE "(makeNull|fakeChatSessions|chatSessions:.*\{[^}]*peekActive)" core/
```

For each mock function (e.g. `makeNullChatSessions` in `core/src/services/conversation/__tests__/conversation-service.test.ts:13`), add the new method:

```typescript
setTitle: vi.fn().mockResolvedValue({ updated: false }),
```

If a mock returns a literal object satisfying `ChatSessionStore`, it must include `setTitle` to typecheck.

- [ ] **Step 7: Run the full test suite to verify no mock-related compile failures**

Run: `pnpm test`
Expected: PASS — no `Property 'setTitle' is missing` errors.

- [ ] **Step 8: Commit**

Stage explicit paths only — do NOT use `git add -u`. After Step 6's grep, list the test files that were edited and add them by name:

```bash
git add core/src/services/conversation-session/chat-session-store.ts \
        core/src/services/conversation-session/__tests__/set-title.test.ts \
        core/src/services/conversation-session/__tests__/fixtures.ts \
        core/src/services/conversation/__tests__/conversation-service.test.ts
# add any other test files the grep in Step 6 turned up; verify with `git status` first
git commit -m "feat(hermes-p7): add ChatSessionStore.setTitle with edge-case handling"
```

---

## Task A3: Build `title-generator.ts`

**Files:**
- Create: `core/src/services/conversation-titling/title-generator.ts`
- Create: `core/src/services/conversation-titling/__tests__/title-generator.test.ts`
- Create: `core/src/services/conversation-titling/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `core/src/services/conversation-titling/__tests__/title-generator.test.ts`:

```typescript
/**
 * Tests for title-generator.ts (Hermes P7, Chunk A).
 *
 * Covers:
 *  - Happy path: LLM returns valid JSON {"title": "..."} → string returned
 *  - Sanitization: Markdown stripped, control chars removed, length capped
 *  - Output rejection: empty / all punctuation / contains JSON braces / digits-only / UUID-like
 *  - LLM error → null
 *  - Invalid JSON → null
 *  - {"title": null} → null
 *  - Untrusted content fenced (test prompt construction does NOT inject role-like tags)
 */

import { describe, expect, it, vi } from 'vitest';
import { generateTitle } from '../title-generator.js';
import type { TitleGeneratorDeps } from '../title-generator.js';

function makeDeps(completion: string | (() => Promise<string> | string)): TitleGeneratorDeps {
	return {
		llm: {
			complete: vi.fn().mockImplementation(async () =>
				typeof completion === 'function' ? completion() : completion,
			),
		} as TitleGeneratorDeps['llm'],
		logger: { warn: vi.fn() },
	};
}

describe('generateTitle', () => {
	it('returns a clean title from valid JSON', async () => {
		const deps = makeDeps('{"title": "Weekly grocery planning"}');
		expect(await generateTitle('what should I buy this week?', 'Here is your list...', deps))
			.toBe('Weekly grocery planning');
	});

	it('strips Markdown and control chars from the title', async () => {
		const deps = makeDeps('{"title": "**Important** plan\\nfor _next_ week"}');
		const out = await generateTitle('q', 'a', deps);
		expect(out).toBe('Important plan for next week');
	});

	it('rejects titles longer than 7 words after sanitization', async () => {
		// 12 single-letter "words" — easily exceeds the 7-word cap.
		const long = 'one two three four five six seven eight nine ten eleven twelve';
		const deps = makeDeps(`{"title": "${long}"}`);
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects titles with fewer than 3 words after sanitization', async () => {
		const deps = makeDeps('{"title": "Groceries"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('strips ```json fences before parsing', async () => {
		const deps = makeDeps('```json\n{"title": "Weekly grocery planning"}\n```');
		expect(await generateTitle('q', 'a', deps)).toBe('Weekly grocery planning');
	});

	it('returns null on LLM error', async () => {
		const deps = makeDeps(() => {
			throw new Error('llm down');
		});
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('returns null on invalid JSON', async () => {
		const deps = makeDeps('not json at all');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('returns null when LLM returns {"title": null}', async () => {
		const deps = makeDeps('{"title": null}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects titles that are all punctuation', async () => {
		const deps = makeDeps('{"title": "!!! ??? ... !!!"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects titles containing curly braces (JSON bleed)', async () => {
		const deps = makeDeps('{"title": "{not really a fine title here}"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects digits-only titles', async () => {
		// Single-token digit string — also caught by word-count, but DIGITS_ONLY_RE fires first.
		const deps = makeDeps('{"title": "12345"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects UUID-shaped titles', async () => {
		const deps = makeDeps('{"title": "550e8400-e29b-41d4-a716-446655440000"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('strips < and > from untrusted user/assistant content before fencing', async () => {
		const completeMock = vi.fn().mockResolvedValue('{"title": "Topic discussion thread"}');
		const deps: TitleGeneratorDeps = {
			llm: { complete: completeMock } as TitleGeneratorDeps['llm'],
			logger: { warn: vi.fn() },
		};
		await generateTitle('user said <fake-tag>injected</fake-tag>', 'assistant said <other>stuff</other>', deps);
		const userPrompt = completeMock.mock.calls[0]?.[0] as string;
		expect(userPrompt).not.toContain('<fake-tag>');
		expect(userPrompt).not.toContain('</fake-tag>');
		expect(userPrompt).toContain('fake-taginjected');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation-titling/__tests__/title-generator.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `title-generator.ts`**

Create `core/src/services/conversation-titling/title-generator.ts`:

```typescript
import type { LLMService } from '../llm/index.js';

export interface TitleGeneratorDeps {
	llm: Pick<LLMService, 'complete'>;
	// Narrow logger shape — match the pattern used in recall-classifier.ts.
	// AppLogger lives at `../../types/app-module.js` if a wider type is ever needed.
	logger: { warn(obj: unknown, msg?: string): void };
}

const TITLE_MAX_LEN = 80;
const TITLE_MIN_WORDS = 3;
const TITLE_MAX_WORDS = 7;

// Note: the JSON output itself uses double quotes for the {"title": "..."} envelope,
// so we instruct the model not to put quote characters INSIDE the title value.
const SYSTEM_PROMPT = `You generate short titles for conversations. Read the user message and assistant reply, then return JSON of the form {"title": "..."} with a 3-7 word title in plain words. The title value must not contain any quote characters (no ' or " inside the title). No Markdown, no proper nouns unless central, present tense, no pronouns. If you cannot summarize, return {"title": null}. Output ONLY the JSON object — no Markdown fences.`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_ONLY_RE = /^\d+$/;

function fenceUntrusted(userContent: string, assistantContent: string): string {
	const stripTags = (s: string): string => s.replace(/[<>]/g, '');
	return `<conversation>\nUser: ${stripTags(userContent)}\nAssistant: ${stripTags(assistantContent)}\n</conversation>`;
}

function sanitizeOutput(raw: string): string | null {
	const cleaned = raw
		.replace(/[`#*_>]/g, '')
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/[\x00-\x1F\x7F]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return null;
	if (/^[\p{P}\s]+$/u.test(cleaned)) return null;
	if (cleaned.includes('{') || cleaned.includes('}')) return null;
	if (DIGITS_ONLY_RE.test(cleaned)) return null;
	if (UUID_RE.test(cleaned)) return null;
	const truncated = cleaned.slice(0, TITLE_MAX_LEN);
	// Enforce 3–7 word target post-truncation. A 1–2 word "title" is usually a fragment;
	// >7 is a runaway sentence. Reject so the caller falls back to the fire-and-forget no-op.
	const wordCount = truncated.split(/\s+/).filter(Boolean).length;
	if (wordCount < TITLE_MIN_WORDS || wordCount > TITLE_MAX_WORDS) return null;
	return truncated;
}

// Some fast-tier models wrap JSON in ```json fences despite instructions; strip them
// before JSON.parse. Mirrors the pattern in recall-classifier.ts.
function stripFences(raw: string): string {
	return raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
}

export async function generateTitle(
	userContent: string,
	assistantContent: string,
	deps: TitleGeneratorDeps,
): Promise<string | null> {
	const userPrompt = fenceUntrusted(userContent, assistantContent);
	let raw: string;
	try {
		raw = await deps.llm.complete(userPrompt, {
			tier: 'fast',
			systemPrompt: SYSTEM_PROMPT,
			maxTokens: 60,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'title-generator: LLM call failed');
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch {
		deps.logger.warn({ raw }, 'title-generator: LLM returned invalid JSON');
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const title = (parsed as { title?: unknown }).title;
	if (title === null || title === undefined) return null;
	if (typeof title !== 'string') return null;
	return sanitizeOutput(title);
}
```

Create `core/src/services/conversation-titling/index.ts`:

```typescript
export { generateTitle, type TitleGeneratorDeps } from './title-generator.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation-titling/__tests__/title-generator.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/conversation-titling/
git commit -m "feat(hermes-p7): add title-generator with fenced input + sanitized output"
```

---

## Task A4: Build TitleService

**Files:**
- Create: `core/src/services/conversation-titling/title-service.ts`
- Create: `core/src/services/conversation-titling/__tests__/title-service.test.ts`
- Modify: `core/src/services/conversation-titling/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `core/src/services/conversation-titling/__tests__/title-service.test.ts`:

```typescript
/**
 * Tests for TitleService.applyTitle (Hermes P7, Chunk A).
 *
 * Covers:
 *  - Happy path: setTitle + updateTitle both succeed
 *  - setTitle returns updated:false → updateTitle is NOT called
 *  - updateTitle returns updated:false → warning logged, no throw
 *  - setTitle throws → caught, logged, no throw
 *  - updateTitle throws → caught, logged, no throw
 *  - Logging responsibility lives in TitleService (not in updateTitle impl)
 */

import { describe, expect, it, vi } from 'vitest';
import { TitleService } from '../title-service.js';
import type { ChatSessionStore } from '../../conversation-session/index.js';
import type { ChatTranscriptIndex } from '../../chat-transcript-index/chat-transcript-index.js';

function makeDeps() {
	// updateTitle on ChatTranscriptIndex is sync (better-sqlite3); setTitle is async.
	const setTitle = vi.fn().mockResolvedValue({ updated: true });
	const updateTitle = vi.fn().mockReturnValue({ updated: true });
	const warn = vi.fn();
	const chatSessions = { setTitle } as unknown as ChatSessionStore;
	const chatTranscriptIndex = { updateTitle } as unknown as ChatTranscriptIndex;
	const logger = { warn };
	return { setTitle, updateTitle, warn, chatSessions, chatTranscriptIndex, logger };
}

describe('TitleService.applyTitle', () => {
	it('calls setTitle and then updateTitle on success and returns {updated:true,title}', async () => {
		const { chatSessions, chatTranscriptIndex, logger, setTitle, updateTitle } = makeDeps();
		const svc = new TitleService({ chatSessions, chatTranscriptIndex, logger });
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(setTitle).toHaveBeenCalledWith('u1', 'sess-1', 'My title', undefined);
		expect(updateTitle).toHaveBeenCalledWith('u1', 'sess-1', 'My title');
		expect(result).toEqual({ updated: true, title: 'My title' });
	});

	it('passes opts.skipIfTitled through to setTitle', async () => {
		const { chatSessions, chatTranscriptIndex, logger, setTitle } = makeDeps();
		const svc = new TitleService({ chatSessions, chatTranscriptIndex, logger });
		await svc.applyTitle('u1', 'sess-1', 'My title', { skipIfTitled: true });
		expect(setTitle).toHaveBeenCalledWith('u1', 'sess-1', 'My title', { skipIfTitled: true });
	});

	it('returns {updated:false} when setTitle returns updated:false (no updateTitle call)', async () => {
		const deps = makeDeps();
		deps.setTitle.mockResolvedValue({ updated: false });
		const svc = new TitleService(deps);
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.updateTitle).not.toHaveBeenCalled();
		expect(result).toEqual({ updated: false });
	});

	it('logs warn when updateTitle returns updated:false but still returns updated:true', async () => {
		const deps = makeDeps();
		deps.updateTitle.mockReturnValue({ updated: false });
		const svc = new TitleService(deps);
		// Markdown is the canonical source — Markdown succeeded, so applyTitle reports success.
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.warn).toHaveBeenCalled();
		expect(result).toEqual({ updated: true, title: 'My title' });
	});

	it('catches setTitle error, logs, returns {updated:false}', async () => {
		const deps = makeDeps();
		deps.setTitle.mockRejectedValue(new Error('disk full'));
		const svc = new TitleService(deps);
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.warn).toHaveBeenCalled();
		expect(result).toEqual({ updated: false });
	});

	it('catches updateTitle error, logs, returns {updated:true,title} (Markdown is canonical)', async () => {
		const deps = makeDeps();
		deps.updateTitle.mockImplementation(() => { throw new Error('db locked'); });
		const svc = new TitleService(deps);
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.warn).toHaveBeenCalled();
		expect(result).toEqual({ updated: true, title: 'My title' });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation-titling/__tests__/title-service.test.ts`
Expected: FAIL — `TitleService` does not exist.

- [ ] **Step 3: Create `title-service.ts`**

Create `core/src/services/conversation-titling/title-service.ts`:

```typescript
import type { ChatSessionStore } from '../conversation-session/index.js';
import type { ChatTranscriptIndex } from '../chat-transcript-index/chat-transcript-index.js';

export interface TitleServiceDeps {
	chatSessions: ChatSessionStore;
	chatTranscriptIndex: ChatTranscriptIndex;
	// Narrow logger shape — matches recall-classifier.ts. AppLogger import
	// (`../../types/app-module.js`) is available if a wider type is ever needed.
	logger: { warn(obj: unknown, msg?: string): void };
}

export interface ApplyTitleResult {
	/** True if the markdown frontmatter was rewritten with the new title. */
	updated: boolean;
	/** The sanitized title that was written, when updated === true. */
	title?: string;
}

/**
 * Best-effort sequential application: write Markdown frontmatter first (canonical),
 * then update the SQLite index (derived). The two steps are NOT atomic; an index
 * failure is logged but does not roll back the Markdown write. If the index drifts,
 * `pnpm chat-index-rebuild` is the recovery tool.
 */
export class TitleService {
	constructor(private readonly deps: TitleServiceDeps) {}

	async applyTitle(
		userId: string,
		sessionId: string,
		title: string,
		opts?: { skipIfTitled?: boolean },
	): Promise<ApplyTitleResult> {
		let setResult: { updated: boolean };
		try {
			setResult = await this.deps.chatSessions.setTitle(userId, sessionId, title, opts);
		} catch (err) {
			this.deps.logger.warn({ err, userId, sessionId }, 'title-service: setTitle failed');
			return { updated: false };
		}
		if (!setResult.updated) return { updated: false };

		try {
			// updateTitle is synchronous on ChatTranscriptIndexImpl (better-sqlite3),
			// but `await` on a non-Promise value is a no-op so this works for either signature.
			const idxResult = await this.deps.chatTranscriptIndex.updateTitle(userId, sessionId, title);
			if (!idxResult.updated) {
				this.deps.logger.warn(
					{ userId, sessionId },
					'title-service: chat-transcript-index updateTitle returned updated:false',
				);
			}
		} catch (err) {
			this.deps.logger.warn({ err, userId, sessionId }, 'title-service: chat-transcript-index updateTitle failed');
		}

		return { updated: true, title };
	}
}
```

Update `core/src/services/conversation-titling/index.ts`:

```typescript
export { generateTitle, type TitleGeneratorDeps } from './title-generator.js';
export { TitleService, type TitleServiceDeps } from './title-service.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation-titling/__tests__/title-service.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/conversation-titling/
git commit -m "feat(hermes-p7): add TitleService wrapping setTitle + updateTitle"
```

---

## Task A5: Build auto-title-hook.ts

**Files:**
- Create: `core/src/services/conversation-titling/auto-title-hook.ts`
- Create: `core/src/services/conversation-titling/__tests__/auto-title-hook.test.ts`
- Modify: `core/src/services/conversation-titling/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `core/src/services/conversation-titling/__tests__/auto-title-hook.test.ts`:

```typescript
/**
 * Tests for auto-title-hook (Hermes P7, Chunk A).
 *
 * Covers:
 *  - Calls generateTitle then titleService.applyTitle with skipIfTitled: true
 *  - Title null → applyTitle is NOT called
 *  - generateTitle throws → does not throw or call applyTitle
 *  - applyTitle throws → does not throw (orchestrator swallows)
 */

import { describe, expect, it, vi } from 'vitest';
import { runTitleAfterFirstExchange } from '../auto-title-hook.js';
import type { TitleService } from '../title-service.js';
import type { LLMService } from '../../llm/index.js';

vi.mock('../title-generator.js', () => ({
	generateTitle: vi.fn(),
}));

import { generateTitle as mockGenerateTitle } from '../title-generator.js';

function makeDeps() {
	const applyTitle = vi.fn().mockResolvedValue({ updated: true, title: 'A title' });
	const warn = vi.fn();
	return {
		titleService: { applyTitle } as unknown as TitleService,
		llm: { complete: vi.fn() } as unknown as LLMService,
		logger: { warn },
		applyTitle,
		warn,
	};
}

describe('runTitleAfterFirstExchange', () => {
	it('generates title and applies with skipIfTitled: true', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockResolvedValue('Planning groceries');
		const deps = makeDeps();
		await runTitleAfterFirstExchange(
			{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
			deps,
		);
		expect(deps.applyTitle).toHaveBeenCalledWith('u1', 'sess-1', 'Planning groceries', { skipIfTitled: true });
	});

	it('does nothing when generateTitle returns null', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const deps = makeDeps();
		await runTitleAfterFirstExchange(
			{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
			deps,
		);
		expect(deps.applyTitle).not.toHaveBeenCalled();
	});

	it('swallows generateTitle errors', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
		const deps = makeDeps();
		await expect(
			runTitleAfterFirstExchange(
				{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
				deps,
			),
		).resolves.toBeUndefined();
		expect(deps.warn).toHaveBeenCalled();
	});

	it('swallows applyTitle errors', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockResolvedValue('A title');
		const deps = makeDeps();
		deps.applyTitle.mockRejectedValue(new Error('boom'));
		await expect(
			runTitleAfterFirstExchange(
				{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
				deps,
			),
		).resolves.toBeUndefined();
		expect(deps.warn).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation-titling/__tests__/auto-title-hook.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `auto-title-hook.ts`**

Create `core/src/services/conversation-titling/auto-title-hook.ts`:

```typescript
import { generateTitle } from './title-generator.js';
import type { TitleService } from './title-service.js';
import type { LLMService } from '../llm/index.js';

export interface AutoTitleHookParams {
	userId: string;
	sessionId: string;
	userContent: string;
	assistantContent: string;
}

export interface AutoTitleHookDeps {
	titleService: TitleService;
	llm: LLMService;
	// Narrow logger shape — matches recall-classifier.ts.
	logger: { warn(obj: unknown, msg?: string): void };
}

export async function runTitleAfterFirstExchange(
	params: AutoTitleHookParams,
	deps: AutoTitleHookDeps,
): Promise<void> {
	let title: string | null;
	try {
		title = await generateTitle(params.userContent, params.assistantContent, {
			llm: deps.llm,
			logger: deps.logger,
		});
	} catch (err) {
		deps.logger.warn({ err, userId: params.userId, sessionId: params.sessionId }, 'auto-title-hook: generateTitle threw');
		return;
	}
	if (title === null) return;

	try {
		await deps.titleService.applyTitle(params.userId, params.sessionId, title, { skipIfTitled: true });
	} catch (err) {
		deps.logger.warn({ err, userId: params.userId, sessionId: params.sessionId }, 'auto-title-hook: applyTitle threw');
	}
}

/**
 * Fire-and-forget wrapper. Returns void synchronously after scheduling the work.
 * The promise is intentionally unawaited; all errors are caught inside `runTitleAfterFirstExchange`.
 */
export function scheduleTitleAfterFirstExchange(
	params: AutoTitleHookParams,
	deps: AutoTitleHookDeps,
): void {
	void runTitleAfterFirstExchange(params, deps);
}
```

Update `core/src/services/conversation-titling/index.ts`:

```typescript
export { generateTitle, type TitleGeneratorDeps } from './title-generator.js';
export { TitleService, type TitleServiceDeps } from './title-service.js';
export {
	runTitleAfterFirstExchange,
	scheduleTitleAfterFirstExchange,
	type AutoTitleHookParams,
	type AutoTitleHookDeps,
} from './auto-title-hook.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation-titling/__tests__/auto-title-hook.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/conversation-titling/
git commit -m "feat(hermes-p7): add auto-title-hook fire-and-forget orchestrator"
```

---

## Task A6: Wire auto-title into handle-message.ts AND handle-ask.ts

**Files:**
- Modify: `core/src/services/conversation/handle-message.ts`
- Modify: `core/src/services/conversation/handle-ask.ts`

**Why both:** `/ask` mints sessions and persists transcripts via the same `appendExchange` path. If we only wire handle-message, an `/ask` that creates a brand-new session never gets a title — the next user message wouldn't trigger auto-title either (because that turn is `sessionIsNew = false`).

- [ ] **Step 1: Write the failing integration test**

Create `core/src/services/conversation/__tests__/handle-message-auto-title.test.ts`:

```typescript
/**
 * Integration test: handle-message schedules auto-title hook after first exchange.
 *
 * Covers:
 *  - First exchange (sessionIsNew && turns.length === 0) → scheduleTitleAfterFirstExchange called
 *  - Subsequent exchanges → not called
 *  - When titleService is undefined in deps → not called (and no error)
 *  - Hook is scheduled AFTER appendExchange resolves
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../conversation-titling/auto-title-hook.js', () => ({
	scheduleTitleAfterFirstExchange: vi.fn(),
	runTitleAfterFirstExchange: vi.fn(),
}));

import { handleMessage } from '../handle-message.js';
import { scheduleTitleAfterFirstExchange } from '../../conversation-titling/auto-title-hook.js';
import { makeHandleMessageFixture } from './handle-message-fixture.js';

describe('handleMessage auto-title scheduling', () => {
	it('schedules auto-title when session is new and there are no prior turns', async () => {
		const f = makeHandleMessageFixture({
			ensureActiveSessionResult: { sessionId: 'sess-1', isNew: true, snapshot: undefined },
			loadRecentTurnsResult: [],
		});
		await handleMessage(f.ctx, f.deps);
		expect(scheduleTitleAfterFirstExchange).toHaveBeenCalledTimes(1);
		expect(scheduleTitleAfterFirstExchange).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: f.ctx.userId,
				sessionId: 'sess-1',
				userContent: f.ctx.text,
			}),
			expect.objectContaining({ titleService: f.deps.titleService, llm: f.deps.llm }),
		);
	});

	it('does NOT schedule when session is not new', async () => {
		const f = makeHandleMessageFixture({
			ensureActiveSessionResult: { sessionId: 'sess-1', isNew: false, snapshot: undefined },
			loadRecentTurnsResult: [],
		});
		await handleMessage(f.ctx, f.deps);
		expect(scheduleTitleAfterFirstExchange).not.toHaveBeenCalled();
	});

	it('does NOT schedule when prior turns exist (defensive)', async () => {
		const f = makeHandleMessageFixture({
			ensureActiveSessionResult: { sessionId: 'sess-1', isNew: true, snapshot: undefined },
			loadRecentTurnsResult: [
				{ role: 'user', content: 'old', timestamp: '2024-01-01T00:00:00.000Z' },
			],
		});
		await handleMessage(f.ctx, f.deps);
		expect(scheduleTitleAfterFirstExchange).not.toHaveBeenCalled();
	});

	it('does NOT schedule when titleService is undefined', async () => {
		const f = makeHandleMessageFixture({
			ensureActiveSessionResult: { sessionId: 'sess-1', isNew: true, snapshot: undefined },
			loadRecentTurnsResult: [],
			titleService: undefined,
		});
		await handleMessage(f.ctx, f.deps);
		expect(scheduleTitleAfterFirstExchange).not.toHaveBeenCalled();
	});

	it('schedules AFTER appendExchange resolves', async () => {
		const callOrder: string[] = [];
		const f = makeHandleMessageFixture({
			ensureActiveSessionResult: { sessionId: 'sess-1', isNew: true, snapshot: undefined },
			loadRecentTurnsResult: [],
			appendExchangeImpl: async () => {
				callOrder.push('appendExchange');
				return { sessionId: 'sess-1' };
			},
		});
		(scheduleTitleAfterFirstExchange as ReturnType<typeof vi.fn>).mockImplementation(() => {
			callOrder.push('scheduleTitle');
		});
		await handleMessage(f.ctx, f.deps);
		expect(callOrder).toEqual(['appendExchange', 'scheduleTitle']);
	});
});
```

If `handle-message-fixture.ts` does not exist, create it as a thin builder around the existing test setup pattern in the same directory.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation/__tests__/handle-message-auto-title.test.ts`
Expected: FAIL — `titleService` not in deps; hook not invoked.

- [ ] **Step 3: Add `titleService` to `HandleMessageDeps`**

In `core/src/services/conversation/handle-message.ts`, add an import at the top:

```typescript
import type { TitleService } from '../conversation-titling/title-service.js';
import { scheduleTitleAfterFirstExchange } from '../conversation-titling/auto-title-hook.js';
```

Add the field to `HandleMessageDeps` interface (around line 60):

```typescript
export interface HandleMessageDeps {
	// ... existing fields ...
	conversationRetrieval?: ConversationRetrievalService;
	/** TitleService — when present, auto-title fires after first exchange. */
	titleService?: TitleService;
}
```

- [ ] **Step 4: Schedule the hook after `appendExchange`**

Locate the `appendExchange` call (around line 245). Immediately after the `try { await deps.chatSessions.appendExchange(...) } catch { ... }` block, add:

```typescript
if (deps.titleService && sessionIsNew && turns.length === 0 && ensuredSessionId) {
	scheduleTitleAfterFirstExchange(
		{
			userId: ctx.userId,
			sessionId: ensuredSessionId,
			userContent: ctx.text,
			assistantContent: finalResponse,
		},
		{
			titleService: deps.titleService,
			llm: deps.llm,
			logger: deps.logger,
		},
	);
}
```

Place this AFTER the `appendExchange` try/catch block — never before. Order is: `sendSplitResponse` → `appendExchange` → `scheduleTitleAfterFirstExchange`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation/__tests__/handle-message-auto-title.test.ts`
Expected: PASS — all 5 tests green.

Run: `pnpm test`
Expected: PASS — no regressions.

- [ ] **Step 6: Apply the same wiring to handle-ask.ts**

In `core/src/services/conversation/handle-ask.ts`:

1. Add identical imports (`TitleService`, `scheduleTitleAfterFirstExchange`).
2. Add `titleService?: TitleService` to `HandleAskDeps` interface.
3. After the `appendExchange` try/catch (around line 268), add the same `if (deps.titleService && sessionIsNew && turns.length === 0 && ensuredSessionId)` block scheduling `scheduleTitleAfterFirstExchange({ userId: ctx.userId, sessionId: ensuredSessionId, userContent: question, assistantContent: responseWithConfirmations }, { titleService: deps.titleService, llm: deps.llm, logger: deps.logger })`.

Note: the user content for `/ask` is `question` (not `ctx.text`, which still has the `/ask` prefix); the assistant content is `responseWithConfirmations` (the post-config-set version).

- [ ] **Step 7: Add a focused handle-ask test**

Create `core/src/services/conversation/__tests__/handle-ask-auto-title.test.ts` mirroring the handle-message test. Just one happy-path case is enough — the orchestrator logic is exercised in handle-message tests.

```typescript
it('schedules auto-title for /ask when session is new and there are no prior turns', async () => {
	// reuse handle-ask-fixture.ts (create if missing); assert userContent === question (no '/ask ' prefix)
});
```

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run core/src/services/conversation/__tests__/handle-ask-auto-title.test.ts core/src/services/conversation/__tests__/handle-message-auto-title.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add core/src/services/conversation/handle-message.ts \
        core/src/services/conversation/handle-ask.ts \
        core/src/services/conversation/__tests__/handle-message-auto-title.test.ts \
        core/src/services/conversation/__tests__/handle-message-fixture.ts \
        core/src/services/conversation/__tests__/handle-ask-auto-title.test.ts \
        core/src/services/conversation/__tests__/handle-ask-fixture.ts
git commit -m "feat(hermes-p7): wire auto-title hook into handle-message + handle-ask after appendExchange"
```

---

## Task A7: Add `handleTitle` to ConversationService

**Files:**
- Modify: `core/src/services/conversation/conversation-service.ts`
- Modify: `core/src/services/conversation/__tests__/conversation-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `core/src/services/conversation/__tests__/conversation-service.test.ts`:

```typescript
describe('ConversationService.handleTitle', () => {
	it('replies "No active conversation yet." when there is no active session', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const titleService = { applyTitle: vi.fn() } as unknown as TitleService;
		const svc = makeConversationService({ chatSessions, telegram, titleService });

		await svc.handleTitle([], makeCtx());

		expect(telegram.send).toHaveBeenCalledWith('matt', 'No active conversation yet.');
		expect(titleService.applyTitle).not.toHaveBeenCalled();
	});

	it('with no args, replies with the current title read from readSession', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue('sess-1');
		// peekSnapshot returns MemorySnapshot which does NOT contain `title`. Read the
		// transcript frontmatter directly via readSession (returns {meta, turns}).
		(chatSessions.readSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			meta: {
				id: 'sess-1', user_id: 'matt', title: 'Planning groceries',
				source: 'telegram', household_id: null, model: null,
				parent_session_id: null, started_at: '2024-01-01T00:00:00.000Z', ended_at: null,
				token_counts: { input: 0, output: 0 },
			},
			turns: [],
		});
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const svc = makeConversationService({ chatSessions, telegram });
		await svc.handleTitle([], makeCtx());
		expect(telegram.send).toHaveBeenCalledWith('matt', 'Current title: Planning groceries');
	});

	it('with no args and null title, replies with "(none)"', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue('sess-1');
		(chatSessions.readSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			meta: {
				id: 'sess-1', user_id: 'matt', title: null,
				source: 'telegram', household_id: null, model: null,
				parent_session_id: null, started_at: '2024-01-01T00:00:00.000Z', ended_at: null,
				token_counts: { input: 0, output: 0 },
			},
			turns: [],
		});
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const svc = makeConversationService({ chatSessions, telegram });
		await svc.handleTitle([], makeCtx());
		expect(telegram.send).toHaveBeenCalledWith('matt', 'Current title: (none)');
	});

	it('with no args and readSession returns undefined (race / missing file), replies with "(none)"', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue('sess-1');
		(chatSessions.readSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const svc = makeConversationService({ chatSessions, telegram });
		await svc.handleTitle([], makeCtx());
		expect(telegram.send).toHaveBeenCalledWith('matt', 'Current title: (none)');
	});

	it('escapes Markdown special chars in the displayed title', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue('sess-1');
		(chatSessions.readSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			meta: {
				id: 'sess-1', user_id: 'matt', title: '*bold* and _italic_',
				source: 'telegram', household_id: null, model: null,
				parent_session_id: null, started_at: '2024-01-01T00:00:00.000Z', ended_at: null,
				token_counts: { input: 0, output: 0 },
			},
			turns: [],
		});
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const svc = makeConversationService({ chatSessions, telegram });
		await svc.handleTitle([], makeCtx());
		// escapeMarkdown escapes * and _
		expect(telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('\\*bold\\*'));
	});

	it('with args, calls TitleService.applyTitle and replies with the saved title', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue('sess-1');
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const applyTitle = vi.fn().mockResolvedValue({ updated: true, title: 'My New Title' });
		const titleService = { applyTitle } as unknown as TitleService;
		const svc = makeConversationService({ chatSessions, telegram, titleService });

		await svc.handleTitle(['My', 'New', 'Title'], makeCtx());

		expect(applyTitle).toHaveBeenCalledWith('matt', 'sess-1', 'My New Title', { skipIfTitled: false });
		expect(telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Title updated to'));
	});

	it('with args but applyTitle returns updated:false, replies with rejection message', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue('sess-1');
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const applyTitle = vi.fn().mockResolvedValue({ updated: false });
		const titleService = { applyTitle } as unknown as TitleService;
		const svc = makeConversationService({ chatSessions, telegram, titleService });
		await svc.handleTitle(['***'], makeCtx());
		expect(telegram.send).toHaveBeenCalledWith('matt', "Couldn't set that title — try a short plain-text phrase.");
	});

	it('with args but no titleService, replies error message', async () => {
		const chatSessions = makeNullChatSessions();
		(chatSessions.peekActive as ReturnType<typeof vi.fn>).mockResolvedValue('sess-1');
		const telegram = { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService;
		const svc = makeConversationService({ chatSessions, telegram, titleService: undefined });
		await svc.handleTitle(['Foo'], makeCtx());
		expect(telegram.send).toHaveBeenCalledWith('matt', 'Title updates are not configured.');
	});
});
```

`makeConversationService` is the existing test helper in this file; extend it to accept and pass `titleService` through to `new ConversationService({ ... })`.

`makeNullChatSessions()` (top of the same file, ~line 13) must also be extended to include both `setTitle` and `readSession`:

```typescript
setTitle: vi.fn().mockResolvedValue({ updated: false }),
readSession: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation/__tests__/conversation-service.test.ts -t handleTitle`
Expected: FAIL — `handleTitle` is not a method.

- [ ] **Step 3: Add `titleService` to ConversationService deps + add `handleTitle` method**

In `core/src/services/conversation/conversation-service.ts`:

1. Add imports at top:

```typescript
import type { TitleService } from '../conversation-titling/title-service.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
```

2. Add `titleService?: TitleService;` to the deps interface.

3. Pass `titleService` through to `handleMessage` and `handleAsk` deps wherever ConversationService builds them (look for the existing `handleMessage`/`handleAsk` calls and add `titleService: this.deps.titleService` to each deps object).

4. Add `handleTitle` method (next to `handleNewChat`, around line 60):

```typescript
async handleTitle(args: string[], ctx: MessageContext): Promise<void> {
	const sessionKey = resolveOrDefaultSessionKey(ctx);
	const sessionId = await this.deps.chatSessions.peekActive({ userId: ctx.userId, sessionKey });
	if (!sessionId) {
		await this.deps.telegram.send(ctx.userId, 'No active conversation yet.');
		return;
	}

	if (args.length === 0) {
		// Use readSession (returns {meta, turns}) — peekSnapshot returns a MemorySnapshot
		// which does NOT contain the frontmatter `title` field.
		const session = await this.deps.chatSessions.readSession(ctx.userId, sessionId);
		const title = session?.meta.title ?? null;
		const display = title ? escapeMarkdown(title) : '(none)';
		await this.deps.telegram.send(ctx.userId, `Current title: ${display}`);
		return;
	}

	if (!this.deps.titleService) {
		await this.deps.telegram.send(ctx.userId, 'Title updates are not configured.');
		return;
	}

	const newTitle = args.join(' ');
	const result = await this.deps.titleService.applyTitle(ctx.userId, sessionId, newTitle, { skipIfTitled: false });
	if (!result.updated) {
		await this.deps.telegram.send(ctx.userId, "Couldn't set that title — try a short plain-text phrase.");
		return;
	}
	const written = result.title ?? newTitle;
	await this.deps.telegram.send(ctx.userId, `Title updated to: ${escapeMarkdown(written)}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation/__tests__/conversation-service.test.ts -t handleTitle`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/conversation/conversation-service.ts core/src/services/conversation/__tests__/conversation-service.test.ts
git commit -m "feat(hermes-p7): add ConversationService.handleTitle"
```

---

## Task A8: Add `/title` to Router

**Files:**
- Modify: `core/src/services/router/index.ts`
- Modify: `core/src/services/router/__tests__/router-builtins.test.ts` (or equivalent existing built-ins test file)

- [ ] **Step 1: Write the failing tests**

In the existing built-ins test file (look at the existing tests for `/ask`, `/notes`, `/newchat` — likely `core/src/services/router/__tests__/router-conversation.test.ts` or `router-builtins.test.ts`), add a `/title` test block:

```typescript
describe('Router /title built-in', () => {
	it('routes /title to ConversationService.handleTitle', async () => {
		const conversationService = makeFakeConversationService();
		const { router, ctx } = makeRouterFixture({ conversationService });
		await router.routeMessage({ ...ctx, text: '/title' });
		expect(conversationService.handleTitle).toHaveBeenCalledWith([], expect.any(Object));
	});

	it('routes /title with args to handleTitle', async () => {
		const conversationService = makeFakeConversationService();
		const { router, ctx } = makeRouterFixture({ conversationService });
		await router.routeMessage({ ...ctx, text: '/title My Custom Title' });
		expect(conversationService.handleTitle).toHaveBeenCalledWith(['My', 'Custom', 'Title'], expect.any(Object));
	});

	it('routes /title@PASBot consistently with other built-ins', async () => {
		const conversationService = makeFakeConversationService();
		const { router, ctx } = makeRouterFixture({ conversationService, botUsername: 'PASBot' });
		await router.routeMessage({ ...ctx, text: '/title@PASBot Some title' });
		expect(conversationService.handleTitle).toHaveBeenCalledWith(['Some', 'title'], expect.any(Object));
	});

	it('treats /title as a built-in regardless of whether chatbot manifest has it', async () => {
		const conversationService = makeFakeConversationService();
		const { router, ctx } = makeRouterFixture({ conversationService, registryHasTitleCommand: false });
		await router.routeMessage({ ...ctx, text: '/title' });
		expect(conversationService.handleTitle).toHaveBeenCalled();
	});
});
```

If `makeFakeConversationService()` doesn't include `handleTitle`, extend it to: `handleTitle: vi.fn().mockResolvedValue(undefined)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/router/__tests__/ -t '/title'`
Expected: FAIL — `/title` falls through to chatbot fallback.

- [ ] **Step 3: Add `/title` to `BUILTIN_COMMAND_NAMES`**

In `core/src/services/router/index.ts`, line 711:

```typescript
const BUILTIN_COMMAND_NAMES = new Set(['/ask', '/edit', '/notes', '/newchat', '/reset', '/title']);
```

- [ ] **Step 4: Add `/title` dispatch branch**

In the same file, in the built-in conversation commands block (lines 501–521), add:

```typescript
if (parsed.command === '/title') {
	await this.dispatchConversationCommand('title', parsed.args, ctx);
	return;
}
```

- [ ] **Step 5: Extend `dispatchConversationCommand` union type and switch**

At line 651, change the union (note: it's `private async` and the field accesses use `this.conversationService` directly — the Router uses private readonly fields, NOT a `this.deps.X` shape):

```typescript
private async dispatchConversationCommand(
	name: 'ask' | 'edit' | 'notes' | 'newchat' | 'title',
	args: string[],
	ctx: MessageContext,
): Promise<void> {
```

In the `requestContext.run` body (lines 663–668), add:

```typescript
else if (name === 'title') await this.conversationService!.handleTitle(args, enrichedCtx);
```

(Place this branch before the `else await ... handleNotes` line so the order is: ask, edit, newchat, title, notes.)

- [ ] **Step 6: Update help text**

Search for `'/ask'` in the same file's help-text block (around line 700–706) and add an analogous `/title` line. Match the existing format exactly.

- [ ] **Step 7: Verify chatbot manifest filter**

If `routeForCommand` or any manifest-filter code references `/title` to filter it out (mirroring `/ask`/`/notes` behavior at lines 711–722), add `/title` to the filter list. Otherwise this step is a no-op.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/router/__tests__/ -t '/title'`
Expected: PASS — all 4 tests green.

Run: `pnpm test`
Expected: PASS — no regressions.

- [ ] **Step 9: Commit**

```bash
git add core/src/services/router/index.ts core/src/services/router/__tests__/
git commit -m "feat(hermes-p7): add /title router built-in (incl. /title@bot suffix)"
```

---

## Task A9: Wire TitleService in compose-runtime + URS + close Chunk A

**Files:**
- Modify: `core/src/compose-runtime.ts`
- Modify: `docs/urs.md`

- [ ] **Step 1: Wire TitleService in compose-runtime.ts**

In `core/src/compose-runtime.ts`, find where `chatSessions` and `chatTranscriptIndex` are constructed. The index is created via `createChatTranscriptIndex(chatTranscriptDbPath)` (sync, ~line 937); chatSessions is built via `composeChatSessionStore({...})` (~line 988). After both exist, before the `ConversationService` construction (~line 994):

```typescript
const titleService = new TitleService({
	chatSessions,
	chatTranscriptIndex,
	logger: createChildLogger(logger, { service: 'title-service' }),
});
```

Add `titleService` to the deps passed to `new ConversationService({ ... })`:

```typescript
const conversationService = new ConversationService({
	// ... existing fields ...
	conversationRetrieval: conversationRetrievalService,
	titleService,
});
```

Add the import at the top of compose-runtime.ts:

```typescript
import { TitleService } from './services/conversation-titling/index.js';
```

- [ ] **Step 2: Add URS REQ-CONV-TITLE-001..008**

In `docs/urs.md`, add a new section after REQ-CONV-MEMORY-012 (or in URS-numerical order). For each requirement, follow the existing format used for REQ-CONV-SESSION-* / REQ-CONV-MEMORY-* (description, source, test refs, status). Verbatim requirements (already finalized in spec):

```
REQ-CONV-TITLE-001 — Auto-title fires after the first user+assistant exchange via fire-and-forget; zero latency added to the chat reply.
REQ-CONV-TITLE-002 — Auto-title is scheduled only after appendExchange succeeds; it never runs before transcript persistence.
REQ-CONV-TITLE-003 — Auto-title uses a fast-tier LLM call with untrusted content fenced and sanitized; temperature: 0.
REQ-CONV-TITLE-004 — Generated titles are 3–7 words, plain text, no Markdown or control chars, max 80 chars; null on LLM failure or sanitization rejection.
REQ-CONV-TITLE-005 — setTitle(skipIfTitled: true) is a no-op if title is already non-null; manual /title always uses skipIfTitled: false.
REQ-CONV-TITLE-006 — /title <text> sets the active session title; /title (no args) replies with the current title or "(none)"; both reply "No active conversation yet." when no session is active.
REQ-CONV-TITLE-007 — All title writes change only the title field; all other decoded frontmatter fields and transcript turns are semantically preserved (REQ-CONV-MEMORY-012 maintained).
REQ-CONV-TITLE-008 — The chat-transcript-index SQLite row is updated with the new title on every successful setTitle; index-update failures are logged by TitleService and not propagated.
```

For test references, point at the test files created in Tasks A1–A7 (`update-title.test.ts`, `set-title.test.ts`, `title-generator.test.ts`, `title-service.test.ts`, `auto-title-hook.test.ts`, `handle-message-auto-title.test.ts`, `conversation-service.test.ts`).

- [ ] **Step 3: Add persona test for end-to-end auto-title + manual override**

Create `core/src/services/conversation/__tests__/auto-titling.persona.test.ts`:

```typescript
/**
 * Persona test (Hermes P7, Chunk A): auto-titling + manual /title override.
 *
 * Personas:
 *  P1: Send first message → wait → auto-title fills frontmatter + index
 *  P2: Manual /title BEFORE auto-title resolves → manual wins (skipIfTitled blocks auto-title)
 *  P3: /title without args after auto-title → echoes current title
 *  P4: /title BEFORE any session exists → "No active conversation yet."
 */

// Use the existing persona test pattern from `transcript-recall.persona.test.ts`.
// Wire a real ChatSessionStore (temp dir), real ChatTranscriptIndex (temp file SQLite),
// real TitleService, and a stubbed LLM that returns a deterministic title.
```

(The implementer should mirror the structure of `core/src/services/conversation/__tests__/transcript-recall.persona.test.ts`; this file already establishes the pattern for end-to-end persona tests.)

- [ ] **Step 4: Run the full test suite + build (typecheck)**

Run: `pnpm test`
Expected: PASS — zero failures.

Run: `pnpm lint`
Expected: PASS.

Run: `pnpm build` (this is the typecheck — there is no `pnpm typecheck` script in this repo; `build` runs `tsc` per workspace via `pnpm -r run build`).
Expected: PASS — no TS errors.

- [ ] **Step 5: Commit Chunk A**

```bash
git add core/src/compose-runtime.ts docs/urs.md core/src/services/conversation/__tests__/auto-titling.persona.test.ts
git commit -m "feat(hermes-p7-chunk-a): wire TitleService + URS REQ-CONV-TITLE-001..008 + persona test"
```

---

# Chunk B — Natural-Language /newchat

## Task B1: Build session-control-classifier

**Files:**
- Create: `core/src/services/conversation-retrieval/session-control-classifier.ts`
- Create: `core/src/services/conversation-retrieval/__tests__/session-control-classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Create the test file:

```typescript
/**
 * Tests for session-control-classifier (Hermes P7, Chunk B).
 *
 * Pre-filter:
 *  - Multi-word phrase substring match (e.g. "start over" matches "let's start over")
 *  - Single-word word-boundary match (e.g. "reset" matches "reset everything" but NOT "preset my alarm")
 *  - Slash command short-circuit
 *  - Length < 4 short-circuit
 *  - No alphabetic chars short-circuit
 *  - No vocabulary match short-circuit
 *  - Negative cases table
 *
 * Classifier:
 *  - Happy path: LLM returns valid JSON → verdict
 *  - LLM error → safe default { intent: 'none', confidence: 0 }
 *  - Invalid JSON → safe default
 *  - Missing fields → safe default
 *  - confidence outside [0,1] clamped to 0
 *  - intent not in {newchat, none} → safe default
 */

import { describe, expect, it, vi } from 'vitest';
import {
	sessionControlPreFilter,
	classifySessionControlIntent,
} from '../session-control-classifier.js';
import type { SessionControlClassifierDeps } from '../session-control-classifier.js';

describe('sessionControlPreFilter', () => {
	const cases: Array<[string, boolean, string]> = [
		// [input, shouldProceed (skip = false), description]
		["let's start over", true, 'multi-word phrase'],
		['can we start over from scratch', true, 'phrase substring'],
		['reset everything', true, 'single-word word-boundary'],
		['restart please', true, 'restart word-boundary'],
		['wipe the slate', true, 'wipe word-boundary'],
		['erase that please', true, 'erase word-boundary'],
		['new chat please', true, 'multi-word phrase'],
		['begin again', true, 'multi-word phrase'],
		['fresh start', true, 'multi-word phrase'],
		['forget our conversation', true, 'phrase'],
		['preset my alarm', false, 'preset is not reset (word-boundary)'],
		['restarted my computer', false, 'restarted not in vocabulary; restart word-boundary requires \\brestart\\b'],
		['start a new meal plan', false, 'no phrase or word match'],
		["let's chat about dinner", false, 'no match'],
		["let's begin the recipe", false, 'no match'],
		["don't forget milk", false, 'forget alone not in vocabulary'],
		['/help', false, 'slash command'],
		['/newchat', false, 'slash command'],
		['hi', false, 'too short'],
		['', false, 'empty'],
		['1234567', false, 'no alphabetic chars'],
		['new chat model', true, 'new chat phrase matches; LLM is second line'],
		["let's begin again with the grocery list", true, 'begin again phrase matches'],
	];

	for (const [input, shouldProceed, desc] of cases) {
		it(`${shouldProceed ? 'proceeds' : 'skips'}: ${JSON.stringify(input)} (${desc})`, () => {
			const result = sessionControlPreFilter(input);
			expect(result.skip).toBe(!shouldProceed);
		});
	}
});

describe('classifySessionControlIntent', () => {
	function makeDeps(completion: string | (() => Promise<string>)): SessionControlClassifierDeps {
		return {
			llm: {
				complete: vi.fn().mockImplementation(async () =>
					typeof completion === 'function' ? completion() : completion,
				),
			} as SessionControlClassifierDeps['llm'],
			logger: { warn: vi.fn() },
		};
	}

	it('returns valid verdict for valid LLM response', async () => {
		const deps = makeDeps('{"intent": "newchat", "confidence": 0.92}');
		expect(await classifySessionControlIntent("let's start over", deps))
			.toEqual({ intent: 'newchat', confidence: 0.92 });
	});

	it('safe-default on LLM error', async () => {
		const deps = makeDeps(async () => { throw new Error('llm down'); });
		expect(await classifySessionControlIntent('reset', deps))
			.toEqual({ intent: 'none', confidence: 0 });
	});

	it('safe-default on invalid JSON', async () => {
		const deps = makeDeps('garbage');
		expect(await classifySessionControlIntent('reset', deps))
			.toEqual({ intent: 'none', confidence: 0 });
	});

	it('safe-default on missing intent', async () => {
		const deps = makeDeps('{"confidence": 0.9}');
		expect(await classifySessionControlIntent('reset', deps))
			.toEqual({ intent: 'none', confidence: 0 });
	});

	it('safe-default on intent not in {newchat, none}', async () => {
		const deps = makeDeps('{"intent": "wat", "confidence": 0.9}');
		expect(await classifySessionControlIntent('reset', deps))
			.toEqual({ intent: 'none', confidence: 0 });
	});

	it('clamps confidence to 0 when out of range', async () => {
		const deps = makeDeps('{"intent": "newchat", "confidence": 1.5}');
		expect(await classifySessionControlIntent('reset', deps))
			.toEqual({ intent: 'none', confidence: 0 });
	});

	it('confidence missing → safe-default', async () => {
		const deps = makeDeps('{"intent": "newchat"}');
		expect(await classifySessionControlIntent('reset', deps))
			.toEqual({ intent: 'none', confidence: 0 });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation-retrieval/__tests__/session-control-classifier.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `session-control-classifier.ts`**

```typescript
import type { LLMService } from '../llm/index.js';

export interface SessionControlClassifierDeps {
	llm: Pick<LLMService, 'complete'>;
	// Narrow logger shape — matches recall-classifier.ts.
	logger: { warn(obj: unknown, msg?: string): void };
}

export interface SessionControlVerdict {
	intent: 'newchat' | 'none';
	confidence: number;
}

export interface PreFilterResult {
	skip: boolean;
	reason: string;
}

const MULTI_WORD_PHRASES = [
	'start over',
	'new chat',
	'new conversation',
	'new session',
	'clear history',
	'begin again',
	'fresh start',
	'clean slate',
	'forget this',
	'forget context',
	'forget our conversation',
];
const SINGLE_WORDS = ['reset', 'restart', 'wipe', 'erase'];

const SAFE_DEFAULT: SessionControlVerdict = { intent: 'none', confidence: 0 };

const SYSTEM_PROMPT = `You decide whether a user message is asking to END the current conversation and start a new one. Return JSON exactly of the form {"intent":"newchat"|"none","confidence":0.0..1.0}.

Intent is "newchat" only if the user clearly wants to RESET the chat: start over, wipe context, begin a new conversation. NOT just changing topic.

Counter-examples (intent should be "none"):
- "start a new meal plan" — they want to plan a meal, not reset chat
- "begin the recipe" — they want a recipe
- "new chat model" — they're talking about an AI model
- "let's chat about dinner" — they want to converse about a topic
- "don't forget milk" — they're adding to a list

Output ONLY the JSON object.`;

export function sessionControlPreFilter(message: string): PreFilterResult {
	const trimmed = message.trim();
	if (trimmed.startsWith('/')) return { skip: true, reason: 'slash-command' };
	if (trimmed.length < 4) return { skip: true, reason: 'too-short' };
	if (!/[a-zA-Z]/.test(trimmed)) return { skip: true, reason: 'no-text' };
	const lower = trimmed.toLowerCase();
	for (const phrase of MULTI_WORD_PHRASES) {
		if (lower.includes(phrase)) return { skip: false, reason: `phrase:${phrase}` };
	}
	for (const word of SINGLE_WORDS) {
		const re = new RegExp(`\\b${word}\\b`, 'i');
		if (re.test(lower)) return { skip: false, reason: `word:${word}` };
	}
	return { skip: true, reason: 'no-vocabulary-match' };
}

function sanitizeInput(message: string): string {
	return message.replace(/[<>]/g, '').slice(0, 500);
}

function stripFences(raw: string): string {
	return raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
}

function parseVerdict(raw: string, deps: SessionControlClassifierDeps): SessionControlVerdict {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch {
		deps.logger.warn({ raw }, 'session-control-classifier: invalid JSON');
		return SAFE_DEFAULT;
	}
	if (typeof parsed !== 'object' || parsed === null) return SAFE_DEFAULT;
	const obj = parsed as { intent?: unknown; confidence?: unknown };
	if (obj.intent !== 'newchat' && obj.intent !== 'none') return SAFE_DEFAULT;
	if (typeof obj.confidence !== 'number') return SAFE_DEFAULT;
	if (obj.confidence < 0 || obj.confidence > 1) return SAFE_DEFAULT;
	return { intent: obj.intent, confidence: obj.confidence };
}

export async function classifySessionControlIntent(
	message: string,
	deps: SessionControlClassifierDeps,
): Promise<SessionControlVerdict> {
	let raw: string;
	try {
		raw = await deps.llm.complete(sanitizeInput(message), {
			tier: 'fast',
			systemPrompt: SYSTEM_PROMPT,
			maxTokens: 80,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'session-control-classifier: LLM call failed');
		return SAFE_DEFAULT;
	}
	return parseVerdict(raw, deps);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation-retrieval/__tests__/session-control-classifier.test.ts`
Expected: PASS — all ~30 tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/conversation-retrieval/session-control-classifier.ts core/src/services/conversation-retrieval/__tests__/session-control-classifier.test.ts
git commit -m "feat(hermes-p7): add session-control-classifier (pre-filter + LLM)"
```

---

## Task B2: Build PendingSessionControlStore

**Files:**
- Create: `core/src/services/conversation-retrieval/pending-session-control-store.ts`
- Create: `core/src/services/conversation-retrieval/__tests__/pending-session-control-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * Tests for PendingSessionControlStore (Hermes P7, Chunk B).
 *
 * Covers:
 *  - add() returns deterministic ID with injected rng
 *  - resolve() returns entry within TTL
 *  - resolve() returns undefined after TTL expiry
 *  - resolve() removes entry on success (no double-resolve)
 *  - parseCallback() correctly parses sc:<id>:start / sc:<id>:keep / unknown
 *  - sweep() removes expired entries lazily on next read
 */

import { describe, expect, it } from 'vitest';
import {
	PendingSessionControlStore,
	parseSessionControlCallbackData,
} from '../pending-session-control-store.js';

function makeStore(initialNow = 1_700_000_000_000) {
	let now = initialNow;
	let counter = 0;
	const clock = { now: () => now };
	const rng = () => `id${counter++}`;
	const store = new PendingSessionControlStore({ clock, rng, ttlMs: 60_000 });
	return { store, advance: (ms: number) => { now += ms; }, clock };
}

describe('PendingSessionControlStore', () => {
	it('add returns the deterministic callback id from rng', () => {
		const { store } = makeStore();
		const id = store.add({ userId: 'u1', sessionKey: 'agent:main:tg:dm:u1', chatId: 100, messageId: 42 });
		expect(id).toBe('id0');
	});

	it('attach lets callers fill in chatId/messageId after the placeholder add', () => {
		const { store } = makeStore();
		const id = store.add({ userId: 'u1', sessionKey: 'k', chatId: 0, messageId: 0 });
		store.attach(id, { chatId: 100, messageId: 42 });
		const entry = store.get(id);
		expect(entry).toMatchObject({ chatId: 100, messageId: 42 });
	});

	it('get returns the entry without consuming it', () => {
		const { store } = makeStore();
		const id = store.add({ userId: 'u1', sessionKey: 'k', chatId: 100, messageId: 42 });
		expect(store.get(id)).toBeDefined();
		expect(store.get(id)).toBeDefined(); // still there
		expect(store.size()).toBe(1);
	});

	it('resolveForUser returns and consumes the entry on owner match', () => {
		const { store } = makeStore();
		const id = store.add({ userId: 'u1', sessionKey: 'k', chatId: 100, messageId: 42 });
		expect(store.resolveForUser(id, 'u1')).toBeDefined();
		expect(store.get(id)).toBeUndefined();
	});

	it('resolveForUser returns undefined and DOES NOT consume on owner mismatch', () => {
		const { store } = makeStore();
		const id = store.add({ userId: 'u1', sessionKey: 'k', chatId: 100, messageId: 42 });
		expect(store.resolveForUser(id, 'u2')).toBeUndefined();
		// Still resolvable by the real owner — wrong-user click must not eat the pending entry.
		expect(store.resolveForUser(id, 'u1')).toBeDefined();
	});

	it('resolveForUser returns undefined after TTL', () => {
		const { store, advance } = makeStore();
		const id = store.add({ userId: 'u1', sessionKey: 'k', chatId: 100, messageId: 42 });
		advance(61_000);
		expect(store.resolveForUser(id, 'u1')).toBeUndefined();
	});

	it('get returns undefined for unknown id (vs returns undefined for expired id) — caller can distinguish if needed via has()', () => {
		const { store, advance } = makeStore();
		const id = store.add({ userId: 'u1', sessionKey: 'k', chatId: 100, messageId: 42 });
		expect(store.has(id)).toBe(true);
		advance(61_000);
		expect(store.has(id)).toBe(false);
		expect(store.get('never-existed')).toBeUndefined();
	});

	it('sweeps expired entries from other users on read', () => {
		const { store, advance } = makeStore();
		store.add({ userId: 'u1', sessionKey: 'k1', chatId: 100, messageId: 1 });
		advance(61_000);
		const id2 = store.add({ userId: 'u2', sessionKey: 'k2', chatId: 200, messageId: 2 });
		expect(store.size()).toBeGreaterThanOrEqual(1);
		store.resolveForUser(id2, 'u2');
		expect(store.size()).toBe(0);
	});
});

describe('parseSessionControlCallbackData', () => {
	it('parses sc:<id>:start', () => {
		expect(parseSessionControlCallbackData('sc:abc123:start')).toEqual({ callbackId: 'abc123', action: 'start' });
	});

	it('parses sc:<id>:keep', () => {
		expect(parseSessionControlCallbackData('sc:abc123:keep')).toEqual({ callbackId: 'abc123', action: 'keep' });
	});

	it('returns null for non-sc prefix', () => {
		expect(parseSessionControlCallbackData('rv:abc:foo')).toBeNull();
	});

	it('returns null for unknown action', () => {
		expect(parseSessionControlCallbackData('sc:abc:nuke')).toBeNull();
	});

	it('returns null for malformed input', () => {
		expect(parseSessionControlCallbackData('sc::start')).toBeNull();
		expect(parseSessionControlCallbackData('sc:abc')).toBeNull();
		expect(parseSessionControlCallbackData('')).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/conversation-retrieval/__tests__/pending-session-control-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `pending-session-control-store.ts`**

```typescript
export interface PendingSessionControl {
	userId: string;
	sessionKey: string;
	chatId: number;     // Telegram chat id, needed for editMessage to clear the inline keyboard
	messageId: number;  // Telegram message id of the prompt with buttons
	expiresAt: number;
}

export interface PendingSessionControlStoreDeps {
	clock?: { now: () => number };
	rng?: () => string;
	ttlMs?: number;
}

export type SessionControlAction = 'start' | 'keep';

export interface SessionControlCallbackParsed {
	callbackId: string;
	action: SessionControlAction;
}

const DEFAULT_TTL_MS = 60_000;

function defaultRng(): string {
	const arr = new Uint8Array(8);
	crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class PendingSessionControlStore {
	private readonly entries = new Map<string, PendingSessionControl>();
	private readonly clock: { now: () => number };
	private readonly rng: () => string;
	private readonly ttlMs: number;

	constructor(deps: PendingSessionControlStoreDeps = {}) {
		this.clock = deps.clock ?? { now: () => Date.now() };
		this.rng = deps.rng ?? defaultRng;
		this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
	}

	add(entry: Omit<PendingSessionControl, 'expiresAt'>): string {
		const id = this.rng();
		const expiresAt = this.clock.now() + this.ttlMs;
		this.entries.set(id, { ...entry, expiresAt });
		return id;
	}

	/** Update chatId / messageId after the prompt was actually sent. No-op if unknown. */
	attach(callbackId: string, fields: { chatId: number; messageId: number }): void {
		const entry = this.entries.get(callbackId);
		if (!entry) return;
		entry.chatId = fields.chatId;
		entry.messageId = fields.messageId;
	}

	/** Non-consuming read. Returns undefined if expired or unknown. */
	get(callbackId: string): PendingSessionControl | undefined {
		this.sweepExpired();
		return this.entries.get(callbackId);
	}

	/** Non-consuming presence check. */
	has(callbackId: string): boolean {
		this.sweepExpired();
		return this.entries.has(callbackId);
	}

	/**
	 * Consume the entry only if userId matches the owner. A wrong-user click returns
	 * undefined without deleting the entry, so the legitimate owner can still complete it.
	 */
	resolveForUser(callbackId: string, userId: string): PendingSessionControl | undefined {
		this.sweepExpired();
		const entry = this.entries.get(callbackId);
		if (!entry) return undefined;
		if (entry.userId !== userId) return undefined;
		this.entries.delete(callbackId);
		return entry;
	}

	/** Hard delete by id (used to clean up after a failed send). */
	remove(callbackId: string): void {
		this.entries.delete(callbackId);
	}

	size(): number {
		this.sweepExpired();
		return this.entries.size;
	}

	private sweepExpired(): void {
		const now = this.clock.now();
		for (const [id, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(id);
		}
	}
}

export function parseSessionControlCallbackData(data: string): SessionControlCallbackParsed | null {
	if (!data.startsWith('sc:')) return null;
	const parts = data.split(':');
	if (parts.length !== 3) return null;
	const [, callbackId, action] = parts;
	if (!callbackId || (action !== 'start' && action !== 'keep')) return null;
	return { callbackId, action };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/conversation-retrieval/__tests__/pending-session-control-store.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/conversation-retrieval/pending-session-control-store.ts core/src/services/conversation-retrieval/__tests__/pending-session-control-store.test.ts
git commit -m "feat(hermes-p7): add PendingSessionControlStore + callback parser"
```

---

## Task B3: Insert NL /newchat hook into Router

**Files:**
- Modify: `core/src/services/router/index.ts`

- [ ] **Step 1: Write the failing tests**

Add to the router test suite (e.g. `core/src/services/router/__tests__/router-nl-newchat.test.ts`, new file):

```typescript
/**
 * Tests for natural-language /newchat insertion in routeMessage (Hermes P7, Chunk B).
 *
 * Covers:
 *  - confidence ≥ 0.85 → handleNewChat dispatched immediately
 *  - 0.60 ≤ conf < 0.85 → telegram.sendWithButtons called; no handleNewChat yet
 *  - conf < 0.60 → falls through to IntentClassifier (no handleNewChat, no buttons)
 *  - Pre-filter skip → falls through (LLM not called)
 *  - Slash command bypasses NL classifier
 *  - LLM error → falls through (safe default)
 */

import { describe, expect, it, vi } from 'vitest';
// ... import router fixture, ConversationService mock, classifier stub ...
```

(The implementer should adapt the existing router test fixture to inject a `sessionControlClassifier` stub returning canned verdicts. Keep tests narrow: assert handler invocations, not deep transcript state.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/router/__tests__/router-nl-newchat.test.ts`
Expected: FAIL — no NL /newchat hook in routeMessage.

- [ ] **Step 3: Add classifier dep + pending store dep to Router**

In `core/src/services/router/index.ts`, extend the `RouterOptions` interface (line 138 — note: the Router uses `RouterOptions`, not `RouterDeps`):

```typescript
sessionControlClassifier?: {
	preFilter: (msg: string) => { skip: boolean; reason: string };
	classify: (msg: string, deps: { llm: LLMService; logger: { warn(o: unknown, m?: string): void } }) => Promise<{ intent: 'newchat' | 'none'; confidence: number }>;
};
pendingSessionControl?: PendingSessionControlStore;
```

Add matching `private readonly` fields on the Router class (lines 175–194 area, alongside the other `private readonly telegram`, `private readonly config`, etc.):

```typescript
private readonly sessionControlClassifier?: RouterOptions['sessionControlClassifier'];
private readonly pendingSessionControl?: PendingSessionControlStore;
```

In the constructor (line 200), assign them from `options`:

```typescript
this.sessionControlClassifier = options.sessionControlClassifier;
this.pendingSessionControl = options.pendingSessionControl;
```

(Wiring of these from compose-runtime happens in Task B4. They're optional so existing tests still work.)

- [ ] **Step 4: Insert the NL /newchat hook in routeMessage**

In `routeMessage` (line 251), between the wizard intercept (line 280) and the parsed-command check (line 290):

```typescript
// Hermes P7: natural-language /newchat detection (free text only)
if (
	parsed === null &&
	this.conversationService &&
	this.sessionControlClassifier
) {
	const pre = this.sessionControlClassifier.preFilter(ctx.text);
	if (!pre.skip) {
		const verdict = await this.sessionControlClassifier.classify(ctx.text, {
			llm: this.llm,
			logger: this.logger,
		});
		if (verdict.intent === 'newchat' && verdict.confidence >= 0.85) {
			// High-confidence: dispatch directly. Does NOT require the pending store.
			await this.dispatchConversationCommand('newchat', [], ctx);
			return;
		}
		if (
			verdict.intent === 'newchat' &&
			verdict.confidence >= 0.60 &&
			this.pendingSessionControl
		) {
			const sent = await this.sendNewChatConfirmation(ctx);
			if (sent) return;
			// If the prompt failed to send, fall through to normal routing rather than
			// dropping the message silently. Telegram's message goes through the regular path.
		}
	}
}
```

(Note: field accesses use `this.sessionControlClassifier` / `this.pendingSessionControl` / `this.llm` directly because Router uses private readonly fields, not a `this.deps.X` shape.)

- [ ] **Step 5: Add `sendNewChatConfirmation` private method**

Below `dispatchConversationCommand` (~line 672). Mirrors the RouteVerifier pattern (`route-verifier.ts:280–321`): store under one id, send with that id in callback data, then `attach` the real `chatId`/`messageId` post-send. **Do NOT delete and re-add the entry** — that creates a second id, leaving the original button pointing at a deleted entry.

```typescript
private async sendNewChatConfirmation(ctx: MessageContext): Promise<boolean> {
	if (!this.pendingSessionControl) return false;
	const sessionKey = (await this.resolveSession(ctx.userId)).sessionKey;
	const callbackId = this.pendingSessionControl.add({
		userId: ctx.userId,
		sessionKey,
		chatId: 0,
		messageId: 0,
	});
	let sent: SentMessage;
	try {
		sent = await this.telegram.sendWithButtons(
			ctx.userId,
			"It sounds like you might want to start over. What would you like to do?",
			[[
				{ text: 'Start new chat', callbackData: `sc:${callbackId}:start` },
				{ text: 'Keep current chat', callbackData: `sc:${callbackId}:keep` },
			]],
		);
	} catch (err) {
		this.logger.error({ err }, 'NL /newchat: failed to send inline buttons');
		this.pendingSessionControl.remove(callbackId);
		return false;
	}
	this.pendingSessionControl.attach(callbackId, { chatId: sent.chatId, messageId: sent.messageId });
	return true;
}
```

(`SentMessage` is the existing type in `core/src/services/telegram/index.ts`; its shape is `{ chatId: number; messageId: number }`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/router/__tests__/router-nl-newchat.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 7: Commit**

```bash
git add core/src/services/router/
git commit -m "feat(hermes-p7): insert NL /newchat hook into routeMessage"
```

---

## Task B4: Wire grey-zone callback in compose-runtime

**Files:**
- Modify: `core/src/compose-runtime.ts`

- [ ] **Step 1: Construct PendingSessionControlStore + classifier in compose-runtime**

In `core/src/compose-runtime.ts`, before the `Router` construction (around line 1040), add:

```typescript
const pendingSessionControl = new PendingSessionControlStore();
const sessionControlClassifier = {
	preFilter: sessionControlPreFilter,
	classify: classifySessionControlIntent,
};
```

Pass them into the Router constructor:

```typescript
const router = new Router({
	// ... existing deps ...
	sessionControlClassifier,
	pendingSessionControl,
});
```

Add imports at top of the file:

```typescript
import {
	PendingSessionControlStore,
	parseSessionControlCallbackData,
} from './services/conversation-retrieval/pending-session-control-store.js';
import {
	sessionControlPreFilter,
	classifySessionControlIntent,
} from './services/conversation-retrieval/session-control-classifier.js';
```

- [ ] **Step 2: Register callback handler for `sc:*` prefix**

The existing callback dispatcher in compose-runtime is `bot.on('callback_query:data', async (ctx) => {...})` (~line 1122) — grammy's API, NOT a method on `TelegramService`. It already has branches for `rv:` (RouteVerifier), `onboard:`, and `app:`. Add a parallel branch for `sc:*` inside that block. The grammy callback context exposes:
- `ctx.callbackQuery.data` — the raw callback string
- `ctx.from?.id` — the clicker's user id (number; coerce to string to match entry.userId)
- `ctx.answerCallbackQuery({ text? })` — clears the spinner
- Use `telegram.editMessage(chatId, messageId, text, [])` to clear inline buttons (passing `[]` as the buttons argument). There is NO `editMessageReplyMarkup` method on TelegramService.

```typescript
// Inside the existing bot.on('callback_query:data', async (ctx) => { ... }) handler:
const data = ctx.callbackQuery.data;
const parsed = parseSessionControlCallbackData(data);
if (parsed) {
	const clickerUserId = String(ctx.from?.id ?? '');

	// Use non-consuming get() first, so a wrong-user click can't burn the entry.
	const owner = pendingSessionControl.get(parsed.callbackId);
	if (!owner) {
		// Expired or unknown — same UX message either way (we don't expose internal state).
		await ctx.answerCallbackQuery({ text: 'This confirmation expired or is no longer available.' });
		return;
	}
	if (owner.userId !== clickerUserId) {
		// Silent rejection — entry stays alive for the real owner.
		await ctx.answerCallbackQuery({ text: 'Not for you.' });
		return;
	}

	// Owner confirmed — consume.
	const entry = pendingSessionControl.resolveForUser(parsed.callbackId, clickerUserId);
	if (!entry) {
		// Race: expired between get() and resolveForUser().
		await ctx.answerCallbackQuery({ text: 'This confirmation expired or is no longer available.' });
		return;
	}
	await ctx.answerCallbackQuery();

	// Clear the inline keyboard by editing the message with `[]` buttons.
	if (entry.chatId && entry.messageId) {
		const replacementText = parsed.action === 'start'
			? 'Starting a new chat...'
			: 'Keeping the current chat.';
		await telegram.editMessage(entry.chatId, entry.messageId, replacementText, []).catch((err: unknown) => {
			logger.warn({ err }, 'NL /newchat: failed to edit message to clear buttons');
		});
	}

	if (parsed.action === 'start') {
		const householdId = householdService?.getHouseholdForUser(entry.userId) ?? undefined;
		await requestContext.run({ userId: entry.userId, householdId, sessionId: undefined }, async () => {
			await conversationService.handleNewChat([], {
				userId: entry.userId,
				text: '',
				timestamp: new Date(),
				channel: 'telegram',
				route: undefined,
				sessionKey: entry.sessionKey,
				sessionId: undefined,
			} as MessageContext);
		});
	} else {
		// 'keep' — no extra send needed, the editMessage above carries the confirmation.
	}
	return;
}
```

(Place this branch alongside the existing `rv:` / `onboard:` / `app:` handling. The branch returns after handling, so it does not interfere with other callback prefixes.)

- [ ] **Step 3: Test the wiring (smoke test)**

Run: `pnpm test`
Expected: PASS — no regressions; all unit + integration tests still green.

- [ ] **Step 4: Add persona test for end-to-end NL /newchat**

Create `core/src/services/conversation/__tests__/nl-newchat.persona.test.ts`. Cover:
- "let's start over" → high-confidence dispatch → session ended
- "wipe the slate" → grey-zone → buttons sent → confirm → session ended
- Same → cancel → "OK, keeping your current conversation."
- Wait 61s, click button → "That session control prompt has expired."
- Different user clicks button → silent (no chat reply, but `answerCallbackQuery` called)

(Mirror the structure of `transcript-recall.persona.test.ts` and `auto-titling.persona.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add core/src/compose-runtime.ts core/src/services/conversation/__tests__/nl-newchat.persona.test.ts
git commit -m "feat(hermes-p7): wire NL /newchat grey-zone callback handler"
```

---

## Task B5: URS REQ-CONV-NEWCHAT-* + docs + close P7

**Files:**
- Modify: `docs/urs.md`
- Modify: `docs/USER_GUIDE.md` (if exists)
- Modify: `core/docs/help/commands-and-routing.md` (if exists)
- Modify: `docs/implementation-phases.md`
- Modify: `docs/open-items.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add URS REQ-CONV-NEWCHAT-001..008**

In `docs/urs.md`, in URS-numerical order (after REQ-CONV-TITLE-008), add the 8 requirements verbatim from the spec. Test references should point to:
- `session-control-classifier.test.ts` (REQ-001..003, 006, 008)
- `pending-session-control-store.test.ts` (REQ-005, 007)
- `router-nl-newchat.test.ts` (REQ-001, 004, 005, 006, 008)
- `nl-newchat.persona.test.ts` (REQ-004, 005, 006, 007)

- [ ] **Step 2: Update implementation-phases.md**

Add a row under "Hermes" section:

```markdown
| Hermes P7 | ✓ Complete (2026-04-XX) | Session auto-titling + manual /title + natural-language /newchat. ChatTranscriptIndex.updateTitle, ChatSessionStore.setTitle, TitleService, fire-and-forget hook after appendExchange, /title built-in, sessionControlPreFilter (word-boundary single + phrase substring), classifySessionControlIntent (fast-tier LLM, fail-closed), grey-zone confirmation with 60s TTL + answerCallbackQuery, REQ-CONV-TITLE-001..008, REQ-CONV-NEWCHAT-001..008. Spec: `docs/superpowers/specs/2026-04-28-hermes-p7-session-titling-nl-newchat-design.md`. Plan: `docs/superpowers/plans/2026-04-28-hermes-p7-session-titling-nl-newchat.md`. |
```

- [ ] **Step 3: Update open-items.md**

In `docs/open-items.md`, **delete** the line:

```
- **Hermes P7 — Auto-titling + natural-language /newchat intent** — Session auto-title generation. ...
```

(Carry-forward UX bucket entry stays.)

- [ ] **Step 4: Update CLAUDE.md status**

In `CLAUDE.md`, under "Implementation Status", add P7 to the list of completed Hermes phases. Update the "Current Priority" section to reflect that P7 is done; next options are P8 (now further unblocked) or LLM Enhancement #3.

- [ ] **Step 5: Update USER_GUIDE.md and core/docs/help/commands-and-routing.md if they exist**

Check for these files:
```bash
ls -la docs/USER_GUIDE.md core/docs/help/commands-and-routing.md 2>/dev/null
```

For each that exists, add documentation for `/title` and the natural-language `/newchat` behavior (mirror existing slash-command doc style).

- [ ] **Step 6: Run the full test suite + lint + build**

Run: `pnpm test`
Expected: PASS — zero failures.

Run: `pnpm lint`
Expected: PASS.

Run: `pnpm build` (typecheck — there is no `pnpm typecheck` script in this repo).
Expected: PASS — no TS errors.

- [ ] **Step 7: Final commit**

```bash
git add docs/urs.md docs/implementation-phases.md docs/open-items.md CLAUDE.md docs/USER_GUIDE.md core/docs/help/commands-and-routing.md
git commit -m "docs(hermes-p7): URS REQ-CONV-NEWCHAT-001..008 + phase entry + close P7"
```

---

## Task B6: End-to-end smoke + memory entry

**Files:**
- (Optional, outside repo) `C:\Users\matth\.claude\projects\C--Users-matth-Projects-Personal-Assistant\memory\MEMORY.md` — auto-memory index, NOT in this git repo

- [ ] **Step 1: Run the full test suite one more time**

Run: `pnpm test`
Expected: PASS — zero failures across the ~8593+ existing tests + the ~70 new P7 tests.

- [ ] **Step 2: Manual smoke test (only if a dev environment is available; skip in CI)**

Per the spec verification section:

1. Send first message → wait 1–2s → check `data/users/<userId>/chatbot/conversation/sessions/<sessionId>.md` — `title:` field should be non-null
2. `/title` → bot replies with current title
3. `/title My Custom Title` → overrides immediately. **In the same session**, wait several seconds — verify the delayed auto-title hook does NOT clobber the manual title (the `skipIfTitled: true` guard should prevent it). The next *new* session is expected to be auto-titled normally.
4. Type "let's start over" → bot replies "Started a new conversation. Previous session saved."
5. Type "begin a new meal plan" → routes to food handler (no session-control intercept)
6. Type "wipe the slate" → bot replies with two buttons → tap "Start new chat" → message edits to "Starting a new chat..." with no buttons → session ended
7. Type "wipe the slate" again → tap "Keep current chat" → message edits to "Keeping the current chat." with no buttons
8. Type "wipe the slate" → wait 61s → tap a button → callback toast: "This confirmation expired or is no longer available."

Verify SQLite index synchronization:
```bash
sqlite3 data/system/chat-state.db "SELECT id, title FROM sessions WHERE user_id = '<userId>' ORDER BY started_at DESC LIMIT 5;"
```

- [ ] **Step 3: Update auto-memory (optional — file lives OUTSIDE the repo)**

The auto-memory system writes to `C:\Users\matth\.claude\projects\C--Users-matth-Projects-Personal-Assistant\memory\` (per-user Claude memory), not to a file in this git repo. If you have access, append a `project_status.md`-style entry (mirroring the existing P5 entry):

```markdown
- **Hermes P7 complete (2026-04-XX) + post-merge corrections.** Session auto-titling (fast-tier LLM, fire-and-forget after appendExchange in BOTH handle-message and handle-ask), manual `/title` command (set/show via readSession, escapeMarkdown on display, no-active-session path), natural-language `/newchat` classifier (word-boundary single + phrase-substring multi pre-filter, fast-tier LLM with safe-default fail-closed and JSON-fence stripping, grey-zone 0.60–0.85 inline-button confirmation with 60s TTL, RouteVerifier-style attach pattern, non-consuming get() + resolveForUser() owner check, editMessage with `[]` buttons to clear keyboard). REQ-CONV-TITLE-001..008 + REQ-CONV-NEWCHAT-001..008. Critical invariant maintained: only `title` field of session frontmatter changes (REQ-CONV-MEMORY-012 prefix-cache safety). Carry-forward (streaming, typing indicator, UTF-16 truncation, clarify tool) tracked in `docs/open-items.md` as "Hermes P7 carry-forward — UX polish bucket".
```

If auto-memory access is unavailable, skip — it is NOT a blocker for closing P7.

- [ ] **Step 4: Final commit**

```bash
git add CLAUDE.md
git commit -m "chore(hermes-p7): close P7 phase"
# Do NOT attempt to commit auto-memory files — they live outside this repo.
# Do NOT push without explicit user confirmation per CLAUDE.md.
```

---

## Self-Review Notes

**Spec coverage:**
- REQ-CONV-TITLE-001 — Task A6 (Step 4 schedules fire-and-forget); persona test asserts zero blocking on reply
- REQ-CONV-TITLE-002 — Task A6 (Step 4 places hook AFTER appendExchange try/catch)
- REQ-CONV-TITLE-003 — Task A3 (title-generator uses `tier: 'fast'`, `temperature: 0`, fenced input)
- REQ-CONV-TITLE-004 — Task A3 (sanitizeOutput rejects/truncates)
- REQ-CONV-TITLE-005 — Task A2 (skipIfTitled edge case test); A6 passes `skipIfTitled: true`; A7 passes `skipIfTitled: false`
- REQ-CONV-TITLE-006 — Task A7 (handleTitle three branches + no-session)
- REQ-CONV-TITLE-007 — Task A2 (decoded comparison test asserts all other fields preserved)
- REQ-CONV-TITLE-008 — Tasks A1, A4 (TitleService calls updateTitle after setTitle; warns on failure)
- REQ-CONV-NEWCHAT-001 — Task B3 (`parsed === null` guard)
- REQ-CONV-NEWCHAT-002 — Task B1 (pre-filter vocabulary table)
- REQ-CONV-NEWCHAT-003 — Task B1 (safe-default verdict)
- REQ-CONV-NEWCHAT-004 — Task B3 (`>= 0.85` branch)
- REQ-CONV-NEWCHAT-005 — Task B3 (`>= 0.60` branch sends buttons)
- REQ-CONV-NEWCHAT-006 — Task B3 (no return on `< 0.60`, falls through)
- REQ-CONV-NEWCHAT-007 — Tasks B2, B4 (TTL + answerCallbackQuery + wrong-user)
- REQ-CONV-NEWCHAT-008 — Task B3 (insertion before `if (parsed)`, after wizard intercept)

**Type consistency check:**
- `setTitle(userId, sessionId, title, opts)` — used identically in Tasks A2, A4, A7
- `applyTitle(userId, sessionId, title, opts)` — used identically in Tasks A4, A5, A7
- `runTitleAfterFirstExchange(params, deps)` / `scheduleTitleAfterFirstExchange(params, deps)` — used identically in Tasks A5, A6
- `parseSessionControlCallbackData` — used identically in Tasks B2, B4
- Callback data format `sc:<id>:start` / `sc:<id>:keep` — consistent in Tasks B2, B3, B4

**Open question for executor (decide during implementation):** Edit-away inline buttons after action requires a `TelegramService.editMessageReplyMarkup` method. If it doesn't exist, Task B4 Step 2 notes the degraded fallback. Confirm method exists before implementing.
