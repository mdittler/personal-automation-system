# Phase R3: Data Boundaries, Scopes, and Path Containment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three medium-severity security findings: manifest data scopes not enforced (F3), manifest scope paths using wrong coordinate system (F7), and context store path traversal via `startsWith` (F8).

**Architecture:** F7 is fixed by normalizing three app manifests to use app-root-relative paths. F3 is fixed by passing `ManifestDataScope[]` into `ScopedStore`, adding `checkScope()` that validates path + access level on every operation, and adding `findMatchingScope()` to `paths.ts`. F8 is fixed by slugifying keys in `readEntry()` and replacing `startsWith` with `relative()`-based containment.

**Tech Stack:** TypeScript, Vitest, existing `resolveScopedPath` pattern

---

### Task 1: F7 — Fix manifest scope paths and docs

**Files:**
- Modify: `apps/echo/manifest.yaml:24-27`
- Modify: `apps/notes/manifest.yaml:34-36`
- Modify: `apps/chatbot/manifest.yaml:31-37`
- Modify: `docs/MANIFEST_REFERENCE.md:305`

- [ ] **Step 1: Fix echo manifest scope path**

In `apps/echo/manifest.yaml`, change line 25:

```yaml
# Before:
      - path: "echo/log.md"
# After:
      - path: "log.md"
```

- [ ] **Step 2: Fix notes manifest scope path**

In `apps/notes/manifest.yaml`, change line 35:

```yaml
# Before:
      - path: "notes/daily-notes/"
# After:
      - path: "daily-notes/"
```

- [ ] **Step 3: Fix chatbot manifest scope paths**

In `apps/chatbot/manifest.yaml`, change lines 33 and 36:

```yaml
# Before:
      - path: "chatbot/history.json"
        access: read-write
        description: "Conversation history for context continuity"
      - path: "chatbot/daily-notes/"
# After:
      - path: "history.json"
        access: read-write
        description: "Conversation history for context continuity"
      - path: "daily-notes/"
```

- [ ] **Step 4: Fix MANIFEST_REFERENCE.md example**

In `docs/MANIFEST_REFERENCE.md`, change line 305:

```yaml
# Before:
      - path: "notes/daily-notes/"
# After:
      - path: "daily-notes/"
```

- [ ] **Step 5: Commit**

```bash
git add apps/echo/manifest.yaml apps/notes/manifest.yaml apps/chatbot/manifest.yaml docs/MANIFEST_REFERENCE.md
git commit -m "$(cat <<'EOF'
fix(manifests): normalize scope paths to app-root-relative convention (F7)

Echo, notes, and chatbot manifests used {appId}/ prefixed paths (e.g.
echo/log.md) but ScopedStore.baseDir is already rooted at the app's
data directory. Normalized to app-root-relative paths matching the
food app convention and runtime usage.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: F3 — Add ScopeViolationError and findMatchingScope to paths.ts

**Files:**
- Modify: `core/src/services/data-store/paths.ts`
- Create: `core/src/services/data-store/__tests__/paths.test.ts`

- [ ] **Step 1: Write failing tests for findMatchingScope**

Create `core/src/services/data-store/__tests__/paths.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ManifestDataScope } from '../../../types/manifest.js';
import { ScopeViolationError, findMatchingScope, warnScopePathPrefix } from '../paths.js';

describe('findMatchingScope', () => {
	it('matches an exact file path', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'log.md', access: 'read-write', description: 'Log' },
		];
		const match = findMatchingScope('log.md', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('matches a file within a directory scope', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
		];
		const match = findMatchingScope('daily-notes/2026-04-11.md', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('returns undefined for a path outside all scopes', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'notes/', access: 'read-write', description: 'Notes' },
		];
		expect(findMatchingScope('test.md', scopes)).toBeUndefined();
	});

	it('returns undefined for empty scopes array', () => {
		expect(findMatchingScope('anything.md', [])).toBeUndefined();
	});

	it('matches the directory itself for list operations', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
		];
		// list('daily-notes') passes 'daily-notes' (no trailing slash)
		const match = findMatchingScope('daily-notes', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('normalizes backslashes to forward slashes', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'sub/dir/', access: 'read-write', description: 'Sub' },
		];
		const match = findMatchingScope('sub\\dir\\file.md', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('does not match a sibling directory with a shared prefix', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'notes/', access: 'read-write', description: 'Notes' },
		];
		// 'notes-archive/old.md' should NOT match 'notes/' scope
		expect(findMatchingScope('notes-archive/old.md', scopes)).toBeUndefined();
	});

	it('matches first matching scope when multiple scopes declared', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'history.json', access: 'read-write', description: 'History' },
			{ path: 'daily-notes/', access: 'read', description: 'Notes' },
		];
		expect(findMatchingScope('history.json', scopes)).toEqual(scopes[0]);
		expect(findMatchingScope('daily-notes/today.md', scopes)).toEqual(scopes[1]);
	});
});

describe('ScopeViolationError', () => {
	it('has correct name and message', () => {
		const err = new ScopeViolationError('secret.md', 'write', 'echo');
		expect(err.name).toBe('ScopeViolationError');
		expect(err.message).toContain('echo');
		expect(err.message).toContain('secret.md');
		expect(err.message).toContain('write');
		expect(err.attemptedPath).toBe('secret.md');
		expect(err.operation).toBe('write');
		expect(err.appId).toBe('echo');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/data-store/__tests__/paths.test.ts`
Expected: FAIL — `findMatchingScope` and `ScopeViolationError` do not exist.

- [ ] **Step 3: Implement ScopeViolationError and findMatchingScope**

In `core/src/services/data-store/paths.ts`, add the import and new code after the existing `isWithinDeclaredScopes` function:

```typescript
import type { ManifestDataScope } from '../../types/manifest.js';
```

Add at the end of the file (before the closing `PathTraversalError` class, or after it):

```typescript
/**
 * Error thrown when an app attempts an operation outside its declared data scopes.
 */
export class ScopeViolationError extends Error {
	constructor(
		public readonly attemptedPath: string,
		public readonly operation: string,
		public readonly appId: string,
	) {
		super(
			`Scope violation: app "${appId}" attempted ${operation} on "${attemptedPath}" outside declared scopes`,
		);
		this.name = 'ScopeViolationError';
	}
}

/**
 * Find the first declared scope that matches a given path.
 *
 * @param path - The file path to check (relative to app data root)
 * @param scopes - Declared scopes from the app's manifest
 * @returns The matching scope (with access level), or undefined if no match
 */
export function findMatchingScope(
	path: string,
	scopes: ManifestDataScope[],
): ManifestDataScope | undefined {
	if (scopes.length === 0) return undefined;

	const normalizedPath = path.replace(/\\/g, '/');

	return scopes.find((scope) => {
		const normalizedScope = scope.path.replace(/\\/g, '/');

		// Exact file match
		if (normalizedPath === normalizedScope) return true;

		// Directory scope: path is under the scope directory
		if (normalizedScope.endsWith('/')) {
			// Match files within the directory
			if (normalizedPath.startsWith(normalizedScope)) return true;
			// Match the directory itself (for list operations, which omit trailing slash)
			if (normalizedPath === normalizedScope.slice(0, -1)) return true;
		}

		return false;
	});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/data-store/__tests__/paths.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/data-store/paths.ts core/src/services/data-store/__tests__/paths.test.ts
git commit -m "$(cat <<'EOF'
feat(data-store): add ScopeViolationError and findMatchingScope (F3)

New error class for scope violations and a function that returns the
matching ManifestDataScope (with access level) for a given path.
These are the building blocks for ScopedStore enforcement.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: F3 — Wire scope enforcement into ScopedStore

**Files:**
- Modify: `core/src/services/data-store/scoped-store.ts`
- Modify: `core/src/services/data-store/__tests__/scoped-store.test.ts`

- [ ] **Step 1: Write failing tests for scope enforcement**

Add to `core/src/services/data-store/__tests__/scoped-store.test.ts`. First, add the import at the top:

```typescript
import type { ManifestDataScope } from '../../../types/manifest.js';
import { ScopeViolationError } from '../paths.js';
```

Then add a new describe block after the existing `data:changed events` block:

```typescript
	describe('scope enforcement', () => {
		let scopedStore: ScopedStore;

		beforeEach(() => {
			scopedStore = new ScopedStore({
				baseDir: join(tempDir, 'scoped'),
				appId: 'test-app',
				userId: 'user-123',
				changeLog,
				scopes: [
					{ path: 'notes/', access: 'read-write', description: 'Notes' },
					{ path: 'config.yaml', access: 'read', description: 'Config' },
					{ path: 'log.md', access: 'write', description: 'Log' },
				],
			});
		});

		it('allows write within declared read-write scope', async () => {
			await scopedStore.write('notes/today.md', 'content');
			expect(await scopedStore.read('notes/today.md')).toBe('content');
		});

		it('allows read within declared read-write scope', async () => {
			await scopedStore.write('notes/today.md', 'content');
			const content = await scopedStore.read('notes/today.md');
			expect(content).toBe('content');
		});

		it('allows list within declared read-write scope', async () => {
			await scopedStore.write('notes/a.md', 'a');
			await scopedStore.write('notes/b.md', 'b');
			const files = await scopedStore.list('notes');
			expect(files).toEqual(['a.md', 'b.md']);
		});

		it('rejects write outside declared scopes', async () => {
			await expect(scopedStore.write('secret.md', 'bad')).rejects.toThrow(
				ScopeViolationError,
			);
		});

		it('rejects read outside declared scopes', async () => {
			await expect(scopedStore.read('secret.md')).rejects.toThrow(ScopeViolationError);
		});

		it('rejects list outside declared scopes', async () => {
			await expect(scopedStore.list('private')).rejects.toThrow(ScopeViolationError);
		});

		it('allows read on read-only scope', async () => {
			// Config is read-only — read should work
			// (file won't exist, but should not throw scope error)
			const content = await scopedStore.read('config.yaml');
			expect(content).toBe('');
		});

		it('rejects write on read-only scope', async () => {
			await expect(scopedStore.write('config.yaml', 'bad')).rejects.toThrow(
				ScopeViolationError,
			);
		});

		it('rejects append on read-only scope', async () => {
			await expect(scopedStore.append('config.yaml', 'bad')).rejects.toThrow(
				ScopeViolationError,
			);
		});

		it('rejects archive on read-only scope', async () => {
			await expect(scopedStore.archive('config.yaml')).rejects.toThrow(
				ScopeViolationError,
			);
		});

		it('allows write on write-only scope', async () => {
			await scopedStore.write('log.md', 'entry');
			// No throw = success
		});

		it('rejects read on write-only scope', async () => {
			await expect(scopedStore.read('log.md')).rejects.toThrow(ScopeViolationError);
		});

		it('allows exists on read-only scope', async () => {
			// exists is a read operation
			const result = await scopedStore.exists('config.yaml');
			expect(result).toBe(false);
		});

		it('rejects exists on write-only scope', async () => {
			await expect(scopedStore.exists('log.md')).rejects.toThrow(ScopeViolationError);
		});

		it('skips enforcement when scopes is undefined', async () => {
			const unscoped = new ScopedStore({
				baseDir: join(tempDir, 'unscoped'),
				appId: 'test-app',
				userId: 'user-123',
				changeLog,
			});
			// No scopes = no enforcement — write anywhere
			await unscoped.write('anything.md', 'ok');
			expect(await unscoped.read('anything.md')).toBe('ok');
		});

		it('skips enforcement when scopes is empty array', async () => {
			const emptyScopes = new ScopedStore({
				baseDir: join(tempDir, 'empty-scopes'),
				appId: 'test-app',
				userId: 'user-123',
				changeLog,
				scopes: [],
			});
			await emptyScopes.write('anything.md', 'ok');
			expect(await emptyScopes.read('anything.md')).toBe('ok');
		});
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/data-store/__tests__/scoped-store.test.ts`
Expected: FAIL — `ScopedStoreOptions` does not have `scopes` field.

- [ ] **Step 3: Implement scope enforcement in ScopedStore**

In `core/src/services/data-store/scoped-store.ts`:

Add import:

```typescript
import type { ManifestDataScope } from '../../types/manifest.js';
import { ScopeViolationError, findMatchingScope, resolveScopedPath } from './paths.js';
```

(Remove the existing `import { resolveScopedPath } from './paths.js';` line since it's now included in the combined import.)

Add `scopes` to `ScopedStoreOptions`:

```typescript
export interface ScopedStoreOptions {
	/** Absolute path to the base directory for this scope. */
	baseDir: string;
	/** App ID for change log attribution. */
	appId: string;
	/** User ID for change log attribution (null for shared scope). */
	userId: string | null;
	/** Change log instance for recording operations. */
	changeLog: ChangeLog;
	/** Space ID for change log attribution (set for space-scoped stores). */
	spaceId?: string;
	/** Event bus for emitting data:changed events (optional). */
	eventBus?: EventBusService;
	/** Manifest-declared scopes. Undefined or empty = no enforcement (API trust). */
	scopes?: ManifestDataScope[];
}
```

Add `scopes` field and `checkScope` method to the class:

```typescript
export class ScopedStore implements ScopedDataStore {
	private readonly baseDir: string;
	private readonly appId: string;
	private readonly userId: string | null;
	private readonly changeLog: ChangeLog;
	private readonly spaceId?: string;
	private readonly eventBus?: EventBusService;
	private readonly scopes?: ManifestDataScope[];

	constructor(options: ScopedStoreOptions) {
		this.baseDir = options.baseDir;
		this.appId = options.appId;
		this.userId = options.userId;
		this.changeLog = options.changeLog;
		this.spaceId = options.spaceId;
		this.eventBus = options.eventBus;
		this.scopes = options.scopes;
	}

	/**
	 * Check that a path is within declared scopes and the operation is permitted.
	 * Skips enforcement when scopes are undefined or empty (API trust bypass).
	 */
	private checkScope(path: string, operation: 'read' | 'write'): void {
		if (!this.scopes || this.scopes.length === 0) return;

		const scope = findMatchingScope(path, this.scopes);
		if (!scope) {
			throw new ScopeViolationError(path, operation, this.appId);
		}

		if (operation === 'write' && scope.access === 'read') {
			throw new ScopeViolationError(path, operation, this.appId);
		}
		if (operation === 'read' && scope.access === 'write') {
			throw new ScopeViolationError(path, operation, this.appId);
		}
	}
```

Add `this.checkScope()` calls to each method:

```typescript
	async read(path: string): Promise<string> {
		this.checkScope(path, 'read');
		const fullPath = resolveScopedPath(this.baseDir, path);
		// ... rest unchanged
	}

	async write(path: string, content: string): Promise<void> {
		this.checkScope(path, 'write');
		const fullPath = resolveScopedPath(this.baseDir, path);
		// ... rest unchanged
	}

	async append(path: string, content: string, options?: { frontmatter?: string }): Promise<void> {
		this.checkScope(path, 'write');
		const fullPath = resolveScopedPath(this.baseDir, path);
		// ... rest unchanged
	}

	async exists(path: string): Promise<boolean> {
		this.checkScope(path, 'read');
		const fullPath = resolveScopedPath(this.baseDir, path);
		// ... rest unchanged
	}

	async list(directory: string): Promise<string[]> {
		this.checkScope(directory, 'read');
		const fullPath = resolveScopedPath(this.baseDir, directory);
		// ... rest unchanged
	}

	async archive(path: string): Promise<void> {
		this.checkScope(path, 'write');
		const fullPath = resolveScopedPath(this.baseDir, path);
		// ... rest unchanged
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/data-store/__tests__/scoped-store.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/data-store/scoped-store.ts core/src/services/data-store/__tests__/scoped-store.test.ts
git commit -m "$(cat <<'EOF'
feat(data-store): wire scope enforcement into ScopedStore (F3)

ScopedStore now accepts manifest-declared scopes and checks path +
access level on every operation. read/exists/list require read or
read-write access. write/append/archive require write or read-write.
Undefined or empty scopes skip enforcement (API trust bypass).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: F3 — Pass scopes from DataStoreServiceImpl to ScopedStore

**Files:**
- Modify: `core/src/services/data-store/index.ts`
- Modify: `core/src/services/data-store/__tests__/data-store-spaces.test.ts:393-410`

- [ ] **Step 1: Update DataStoreServiceImpl to store full scopes and pass to ScopedStore**

In `core/src/services/data-store/index.ts`:

Replace the class fields and constructor:

```typescript
export class DataStoreServiceImpl implements DataStoreService {
	private readonly dataDir: string;
	private readonly appId: string;
	private readonly userScopes: ManifestDataScope[];
	private readonly sharedScopes: ManifestDataScope[];
	private readonly changeLog: ChangeLog;
	private readonly spaceService?: SpaceService;
	private readonly eventBus?: EventBusService;

	constructor(options: DataStoreServiceOptions) {
		this.dataDir = options.dataDir;
		this.appId = options.appId;
		this.userScopes = options.userScopes;
		this.sharedScopes = options.sharedScopes;
		this.changeLog = options.changeLog;
		this.spaceService = options.spaceService;
		this.eventBus = options.eventBus;
	}
```

Update `forUser` to pass scopes:

```typescript
	forUser(userId: string): UserDataStore {
		const baseDir = join(this.dataDir, 'users', userId, this.appId);
		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId,
			changeLog: this.changeLog,
			eventBus: this.eventBus,
			scopes: this.userScopes,
		});
	}
```

Update `forShared` to pass scopes:

```typescript
	forShared(_scope: string): SharedDataStore {
		const baseDir = join(this.dataDir, 'users', 'shared', this.appId);
		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId: null,
			changeLog: this.changeLog,
			eventBus: this.eventBus,
			scopes: this.sharedScopes,
		});
	}
```

Update `forSpace` to pass scopes:

```typescript
	forSpace(spaceId: string, userId: string): ScopedDataStore {
		// Validate space ID format
		if (!SPACE_ID_PATTERN.test(spaceId)) {
			throw new SpaceMembershipError(spaceId, userId);
		}

		// Check membership via SpaceService
		if (!this.spaceService?.isMember(spaceId, userId)) {
			throw new SpaceMembershipError(spaceId, userId);
		}

		const baseDir = join(this.dataDir, 'spaces', spaceId, this.appId);
		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId,
			changeLog: this.changeLog,
			spaceId,
			eventBus: this.eventBus,
			scopes: this.sharedScopes,
		});
	}
```

Remove the advisory methods and update the import. Remove `isAllowedUserPath`, `isAllowedSharedPath`, and the `import { isWithinDeclaredScopes } from './paths.js';` line. Update the export line:

```typescript
export { ChangeLog } from './change-log.js';
export { PathTraversalError, ScopeViolationError } from './paths.js';
```

- [ ] **Step 2: Fix the spaces test that will break**

In `core/src/services/data-store/__tests__/data-store-spaces.test.ts`, change line 397:

```typescript
// Before:
			userScopes: [{ path: 'notes/', access: 'read-write' }],
// After:
			userScopes: [],
```

This test is about verifying `spaceId` is absent from non-space change log entries — it has nothing to do with scope enforcement.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/data-store/__tests__/data-store-spaces.test.ts core/src/services/data-store/__tests__/scoped-store.test.ts`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add core/src/services/data-store/index.ts core/src/services/data-store/__tests__/data-store-spaces.test.ts
git commit -m "$(cat <<'EOF'
feat(data-store): pass manifest scopes from DataStoreServiceImpl to ScopedStore (F3)

DataStoreServiceImpl now stores full ManifestDataScope[] (not just paths)
and passes them to ScopedStore. forUser passes userScopes, forShared
and forSpace pass sharedScopes. Removed advisory isAllowedUserPath/
isAllowedSharedPath methods — enforcement is now live in ScopedStore.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: F3 — Bundled app regression tests and API ScopeViolationError handling

**Files:**
- Modify: `core/src/services/data-store/__tests__/scoped-store.test.ts`
- Modify: `core/src/api/routes/data.ts`

- [ ] **Step 1: Add bundled app regression tests**

Add a new describe block to `core/src/services/data-store/__tests__/scoped-store.test.ts`:

```typescript
	describe('bundled app scope regression', () => {
		it('echo: append to log.md succeeds with declared scope', async () => {
			const echoStore = new ScopedStore({
				baseDir: join(tempDir, 'echo-app'),
				appId: 'echo',
				userId: 'user-1',
				changeLog,
				scopes: [{ path: 'log.md', access: 'read-write', description: 'Echo log' }],
			});
			await echoStore.append('log.md', '- [2026-04-11] hello\n');
			const content = await echoStore.read('log.md');
			expect(content).toContain('hello');
		});

		it('notes: write to daily-notes/<date>.md succeeds with declared scope', async () => {
			const notesStore = new ScopedStore({
				baseDir: join(tempDir, 'notes-app'),
				appId: 'notes',
				userId: 'user-1',
				changeLog,
				scopes: [
					{ path: 'daily-notes/', access: 'read-write', description: 'Daily notes' },
				],
			});
			await notesStore.append('daily-notes/2026-04-11.md', '- note\n');
			const content = await notesStore.read('daily-notes/2026-04-11.md');
			expect(content).toContain('note');
		});

		it('chatbot: write to history.json succeeds with declared scopes', async () => {
			const chatbotStore = new ScopedStore({
				baseDir: join(tempDir, 'chatbot-app'),
				appId: 'chatbot',
				userId: 'user-1',
				changeLog,
				scopes: [
					{ path: 'history.json', access: 'read-write', description: 'History' },
					{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
				],
			});
			await chatbotStore.write('history.json', '[]');
			expect(await chatbotStore.read('history.json')).toBe('[]');
		});

		it('chatbot: append to daily-notes/<date>.md succeeds', async () => {
			const chatbotStore = new ScopedStore({
				baseDir: join(tempDir, 'chatbot-app2'),
				appId: 'chatbot',
				userId: 'user-1',
				changeLog,
				scopes: [
					{ path: 'history.json', access: 'read-write', description: 'History' },
					{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
				],
			});
			await chatbotStore.append('daily-notes/2026-04-11.md', '- note\n');
			const content = await chatbotStore.read('daily-notes/2026-04-11.md');
			expect(content).toContain('note');
		});

		it('chatbot: list daily-notes succeeds', async () => {
			const chatbotStore = new ScopedStore({
				baseDir: join(tempDir, 'chatbot-app3'),
				appId: 'chatbot',
				userId: 'user-1',
				changeLog,
				scopes: [
					{ path: 'history.json', access: 'read-write', description: 'History' },
					{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
				],
			});
			await chatbotStore.write('daily-notes/a.md', 'a');
			const files = await chatbotStore.list('daily-notes');
			expect(files).toEqual(['a.md']);
		});

		it('chatbot: rejects write to undeclared path', async () => {
			const chatbotStore = new ScopedStore({
				baseDir: join(tempDir, 'chatbot-app4'),
				appId: 'chatbot',
				userId: 'user-1',
				changeLog,
				scopes: [
					{ path: 'history.json', access: 'read-write', description: 'History' },
					{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
				],
			});
			await expect(chatbotStore.write('sneaky.md', 'bad')).rejects.toThrow(
				ScopeViolationError,
			);
		});
	});
```

- [ ] **Step 2: Add ScopeViolationError handling to API data route**

In `core/src/api/routes/data.ts`, add the import:

```typescript
import { PathTraversalError, ScopeViolationError } from '../../services/data-store/paths.js';
```

(Remove the existing `import { PathTraversalError } from '../../services/data-store/paths.js';` line.)

Add a catch clause after the existing `PathTraversalError` check (around line 126):

```typescript
			if (err instanceof PathTraversalError) {
				return reply.status(400).send({ ok: false, error: 'Invalid path: traversal detected.' });
			}
			if (err instanceof ScopeViolationError) {
				return reply.status(403).send({ ok: false, error: 'Path not within declared scopes.' });
			}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/data-store/__tests__/scoped-store.test.ts`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add core/src/services/data-store/__tests__/scoped-store.test.ts core/src/api/routes/data.ts
git commit -m "$(cat <<'EOF'
test(data-store): add bundled app scope regression tests + API ScopeViolationError handling (F3)

Regression tests verify echo, notes, and chatbot legitimate operations
work under scope enforcement with the corrected manifest paths from F7.
API data route catches ScopeViolationError as defense-in-depth.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: F7 — Add manifest scope path prefix validation warning

**Files:**
- Modify: `core/src/services/data-store/paths.ts`
- Modify: `core/src/services/data-store/__tests__/paths.test.ts`
- Modify: `core/src/services/app-registry/loader.ts`

- [ ] **Step 1: Write failing tests for warnScopePathPrefix**

Add to `core/src/services/data-store/__tests__/paths.test.ts`:

```typescript
describe('warnScopePathPrefix', () => {
	it('returns warnings for paths starting with appId/', () => {
		const warnings = warnScopePathPrefix('echo', [
			{ path: 'echo/log.md', access: 'read-write', description: 'Log' },
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('echo/log.md');
	});

	it('returns empty array for correctly scoped paths', () => {
		const warnings = warnScopePathPrefix('echo', [
			{ path: 'log.md', access: 'read-write', description: 'Log' },
		]);
		expect(warnings).toHaveLength(0);
	});

	it('does not warn for paths that merely contain the appId', () => {
		const warnings = warnScopePathPrefix('notes', [
			{ path: 'release-notes/', access: 'read-write', description: 'Release notes' },
		]);
		expect(warnings).toHaveLength(0);
	});

	it('handles empty scopes array', () => {
		expect(warnScopePathPrefix('echo', [])).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/data-store/__tests__/paths.test.ts`
Expected: FAIL — `warnScopePathPrefix` does not exist.

- [ ] **Step 3: Implement warnScopePathPrefix**

Add to `core/src/services/data-store/paths.ts`:

```typescript
/**
 * Check for scope paths that incorrectly use the {appId}/ prefix.
 * Returns human-readable warning strings for each offending path.
 */
export function warnScopePathPrefix(appId: string, scopes: ManifestDataScope[]): string[] {
	const prefix = `${appId}/`;
	return scopes
		.filter((s) => s.path.startsWith(prefix))
		.map(
			(s) =>
				`Scope path "${s.path}" starts with "${prefix}" — paths should be relative to the app data directory, which is already rooted at <dataDir>/<userId>/${appId}/.`,
		);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/data-store/__tests__/paths.test.ts`
Expected: All PASS.

- [ ] **Step 5: Wire warning into app loader**

In `core/src/services/app-registry/loader.ts`, add the import at the top:

```typescript
import { warnScopePathPrefix } from '../data-store/paths.js';
```

In the `loadManifest()` method, after `return result.manifest;` (line 99), add the warning check. Replace the return statement:

```typescript
		const manifest = result.manifest;

		// Warn about scope paths using the {appId}/ prefix convention
		const appId = manifest.app.id;
		const userScopes = manifest.requirements?.data?.user_scopes ?? [];
		const sharedScopes = manifest.requirements?.data?.shared_scopes ?? [];
		const scopeWarnings = [
			...warnScopePathPrefix(appId, userScopes),
			...warnScopePathPrefix(appId, sharedScopes),
		];
		for (const warning of scopeWarnings) {
			this.logger.warn({ appId, path: manifestPath }, warning);
		}

		return manifest;
```

- [ ] **Step 6: Run tests to verify no regressions**

Run: `pnpm vitest run core/src/services/data-store/__tests__/paths.test.ts core/src/services/app-registry/__tests__/loader.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/services/data-store/paths.ts core/src/services/data-store/__tests__/paths.test.ts core/src/services/app-registry/loader.ts
git commit -m "$(cat <<'EOF'
feat(manifests): warn when scope paths use {appId}/ prefix (F7)

warnScopePathPrefix() detects manifest scope paths that start with
the declaring app's ID. The app loader logs warnings at manifest load
time. This catches future regressions after the F7 manifest fixes.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: F8 — Fix context store path containment

**Files:**
- Modify: `core/src/services/context-store/index.ts`
- Modify: `core/src/services/context-store/__tests__/context-store.test.ts`

- [ ] **Step 1: Write failing tests for sibling directory escape and slugified reads**

Add to `core/src/services/context-store/__tests__/context-store.test.ts`. Add `mkdir` to the existing import from `node:fs/promises` (it's already imported).

Add a new describe block:

```typescript
	describe('path containment (F8)', () => {
		it('get() reads via slugified key', async () => {
			await writeFile(join(contextDir, 'my-notes.md'), 'Found via slug\n');

			const result = await store.get('My Notes');
			expect(result).toBe('Found via slug\n');
		});

		it('getForUser() reads via slugified key', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'my-notes.md'), 'User notes\n');

			const result = await store.getForUser('My Notes', 'user1');
			expect(result).toBe('User notes\n');
		});

		it('get() returns null for ../context2/secret even when sibling exists', async () => {
			const siblingDir = join(tempDir, 'system', 'context2');
			await mkdir(siblingDir, { recursive: true });
			await writeFile(join(siblingDir, 'secret.md'), 'SECRET\n');

			const result = await store.get('../context2/secret');
			expect(result).toBeNull();
		});

		it('getForUser() returns null for ../context2/secret even when sibling exists', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			const siblingDir = join(tempDir, 'users', 'user1', 'context2');
			await mkdir(siblingDir, { recursive: true });
			await writeFile(join(siblingDir, 'secret.md'), 'SECRET\n');

			const result = await store.getForUser('../context2/secret', 'user1');
			expect(result).toBeNull();
		});

		it('save() containment uses relative() check (defense-in-depth)', async () => {
			// "../context2/evil" slugifies to "context2-evil" — safe, but startsWith would miss it
			await store.save('user1', '../context2/evil', 'attempt');
			const result = await store.getForUser('context2-evil', 'user1');
			expect(result).toBe('attempt');
		});

		it('remove() containment uses relative() check (defense-in-depth)', async () => {
			await store.save('user1', 'test-entry', 'content');
			// slugifyKey('../test-entry') = 'test-entry', so this removes the entry
			await store.remove('user1', '../test-entry');
			const result = await store.getForUser('test-entry', 'user1');
			expect(result).toBeNull();
		});
	});
```

- [ ] **Step 2: Run tests to verify the sibling escape test fails**

Run: `pnpm vitest run core/src/services/context-store/__tests__/context-store.test.ts`
Expected: The `get() reads via slugified key` test fails (readEntry doesn't slugify), and the sibling directory tests may pass or fail depending on filesystem state.

- [ ] **Step 3: Fix readEntry to slugify keys and use relative() containment**

In `core/src/services/context-store/index.ts`:

Add `relative` and `sep` to the path import:

```typescript
import { join, relative, resolve, sep } from 'node:path';
```

Replace the `readEntry` method:

```typescript
	private async readEntry(dir: string, key: string): Promise<string | null> {
		const slug = slugifyKey(key);
		if (!slug || !SLUG_PATTERN.test(slug)) {
			this.logger.warn({ key }, 'Context store key failed slug validation');
			return null;
		}

		const filePath = resolve(join(dir, `${slug}.md`));
		const rel = relative(dir, filePath);
		if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
			this.logger.warn({ key }, 'Context store key attempted path traversal');
			return null;
		}

		try {
			return await readFile(filePath, 'utf-8');
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return null;
			}
			this.logger.error({ key, error }, 'Failed to read context entry');
			return null;
		}
	}
```

- [ ] **Step 4: Harden save() — replace startsWith with relative() check**

Replace the path containment check in `save()`:

```typescript
		const filePath = resolve(join(dir, `${slug}.md`));
		const rel = relative(dir, filePath);
		if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
			throw new Error('Path traversal detected');
		}
```

- [ ] **Step 5: Harden remove() — replace startsWith with relative() check**

Replace the path containment check in `remove()`:

```typescript
		const filePath = resolve(join(dir, `${slug}.md`));
		const rel = relative(dir, filePath);
		if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
			throw new Error('Path traversal detected');
		}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/context-store/__tests__/context-store.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/services/context-store/index.ts core/src/services/context-store/__tests__/context-store.test.ts
git commit -m "$(cat <<'EOF'
fix(context-store): slugify readEntry keys and replace startsWith with relative() containment (F8)

readEntry() now slugifies keys before path resolution, aligning with
save/remove behavior and preventing the sibling-directory escape where
'context2' passed a startsWith check for 'context'. All three methods
(readEntry, save, remove) now use path.relative() for containment.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Update findings doc and run full test suite

**Files:**
- Modify: `docs/codebase-review-findings.md`

- [ ] **Step 1: Mark F3, F7, F8 as fixed**

In `docs/codebase-review-findings.md`:

Line 170: Change `- Status: open` to `- Status: fixed`
Line 207: Change `- Status: open` to `- Status: fixed`
Line 237: Change `- Status: open` to `- Status: fixed`

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass with no regressions.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Clean compile, no errors.

- [ ] **Step 4: Commit**

```bash
git add docs/codebase-review-findings.md
git commit -m "$(cat <<'EOF'
docs: mark F3, F7, F8 as fixed in codebase review findings

Phase R3 complete — data scope enforcement, manifest path normalization,
and context store path containment all fixed with tests.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```
