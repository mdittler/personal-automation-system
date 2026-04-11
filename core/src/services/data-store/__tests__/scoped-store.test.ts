import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataChangedPayload } from '../../../types/data-events.js';
import type { EventBusService } from '../../../types/events.js';
import type { ManifestDataScope } from '../../../types/manifest.js';
import { ChangeLog } from '../change-log.js';
import { PathTraversalError, ScopeViolationError } from '../paths.js';
import { ScopedStore } from '../scoped-store.js';

let tempDir: string;
let dataDir: string;
let changeLog: ChangeLog;
let store: ScopedStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-test-'));
	dataDir = join(tempDir, 'data');
	changeLog = new ChangeLog(dataDir);
	store = new ScopedStore({
		baseDir: join(tempDir, 'store'),
		appId: 'test-app',
		userId: 'user-123',
		changeLog,
	});
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('ScopedStore', () => {
	describe('write + read', () => {
		it('writes and reads a file', async () => {
			await store.write('notes.md', '# My Notes\nHello world');
			const content = await store.read('notes.md');
			expect(content).toBe('# My Notes\nHello world');
		});

		it('creates parent directories when writing', async () => {
			await store.write('sub/dir/file.md', 'content');
			const content = await store.read('sub/dir/file.md');
			expect(content).toBe('content');
		});

		it('overwrites existing file', async () => {
			await store.write('file.md', 'first');
			await store.write('file.md', 'second');
			const content = await store.read('file.md');
			expect(content).toBe('second');
		});

		it('returns empty string when reading non-existent file', async () => {
			const content = await store.read('does-not-exist.md');
			expect(content).toBe('');
		});
	});

	describe('append', () => {
		it('appends to an existing file', async () => {
			await store.write('log.md', 'line1\n');
			await store.append('log.md', 'line2\n');
			const content = await store.read('log.md');
			expect(content).toBe('line1\nline2\n');
		});

		it('creates file if it does not exist', async () => {
			await store.append('new-file.md', 'first line\n');
			const content = await store.read('new-file.md');
			expect(content).toBe('first line\n');
		});

		it('creates parent directories when appending', async () => {
			await store.append('deep/path/log.md', 'entry\n');
			const content = await store.read('deep/path/log.md');
			expect(content).toBe('entry\n');
		});

		it('concurrent appends do not lose data', async () => {
			const count = 10;
			await Promise.all(
				Array.from({ length: count }, (_, i) => store.append('concurrent.md', `line${i}\n`)),
			);
			const content = await store.read('concurrent.md');
			const lines = content.trim().split('\n');
			expect(lines).toHaveLength(count);
			// All lines should be present (order may vary)
			for (let i = 0; i < count; i++) {
				expect(content).toContain(`line${i}`);
			}
		});
	});

	describe('exists', () => {
		it('returns false for non-existent file', async () => {
			expect(await store.exists('nope.md')).toBe(false);
		});

		it('returns true for existing file', async () => {
			await store.write('file.md', 'content');
			expect(await store.exists('file.md')).toBe(true);
		});

		it('returns true for existing directory', async () => {
			await store.write('dir/file.md', 'content');
			expect(await store.exists('dir')).toBe(true);
		});
	});

	describe('list', () => {
		it('returns empty array for non-existent directory', async () => {
			const files = await store.list('no-dir');
			expect(files).toEqual([]);
		});

		it('lists files in a directory (sorted)', async () => {
			await store.write('mydir/b.md', 'b');
			await store.write('mydir/a.md', 'a');
			await store.write('mydir/c.md', 'c');
			const files = await store.list('mydir');
			expect(files).toEqual(['a.md', 'b.md', 'c.md']);
		});

		it('lists files at root level', async () => {
			await store.write('alpha.md', 'a');
			await store.write('beta.md', 'b');
			const files = await store.list('.');
			expect(files).toEqual(['alpha.md', 'beta.md']);
		});
	});

	describe('archive', () => {
		it('moves a file to an archive name with timestamp', async () => {
			await store.write('list.md', 'items here');

			await store.archive('list.md');

			// Original file should no longer exist
			expect(await store.exists('list.md')).toBe(false);

			// An archive file should exist in the same directory
			const files = await store.list('.');
			expect(files.length).toBe(1);
			expect(files[0]).toMatch(/^list\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/);
		});

		it('preserves content in the archive file', async () => {
			await store.write('data.md', 'important data');
			await store.archive('data.md');

			const files = await store.list('.');
			const archiveName = files[0] ?? '';
			const archiveContent = await store.read(archiveName);
			expect(archiveContent).toBe('important data');
		});

		it('does nothing for non-existent file', async () => {
			// Should not throw
			await store.archive('ghost.md');
		});
	});

	describe('data:changed events', () => {
		let mockEventBus: EventBusService;
		let storeWithEvents: ScopedStore;

		beforeEach(() => {
			mockEventBus = {
				emit: vi.fn(),
				on: vi.fn(),
				off: vi.fn(),
			};
			storeWithEvents = new ScopedStore({
				baseDir: join(tempDir, 'store-events'),
				appId: 'test-app',
				userId: 'user-123',
				changeLog,
				eventBus: mockEventBus,
			});
		});

		it('emits data:changed on write', async () => {
			await storeWithEvents.write('file.md', 'content');
			expect(mockEventBus.emit).toHaveBeenCalledWith('data:changed', {
				operation: 'write',
				appId: 'test-app',
				userId: 'user-123',
				path: 'file.md',
			});
		});

		it('emits data:changed on append', async () => {
			await storeWithEvents.append('log.md', 'entry\n');
			expect(mockEventBus.emit).toHaveBeenCalledWith('data:changed', {
				operation: 'append',
				appId: 'test-app',
				userId: 'user-123',
				path: 'log.md',
			});
		});

		it('emits data:changed on archive', async () => {
			await storeWithEvents.write('data.md', 'content');
			(mockEventBus.emit as ReturnType<typeof vi.fn>).mockClear();
			await storeWithEvents.archive('data.md');
			expect(mockEventBus.emit).toHaveBeenCalledWith('data:changed', {
				operation: 'archive',
				appId: 'test-app',
				userId: 'user-123',
				path: 'data.md',
			});
		});

		it('does NOT emit on read', async () => {
			await storeWithEvents.write('file.md', 'content');
			(mockEventBus.emit as ReturnType<typeof vi.fn>).mockClear();
			await storeWithEvents.read('file.md');
			expect(mockEventBus.emit).not.toHaveBeenCalled();
		});

		it('does NOT emit on list', async () => {
			await storeWithEvents.write('dir/file.md', 'content');
			(mockEventBus.emit as ReturnType<typeof vi.fn>).mockClear();
			await storeWithEvents.list('dir');
			expect(mockEventBus.emit).not.toHaveBeenCalled();
		});

		it('does NOT emit on exists', async () => {
			await storeWithEvents.write('file.md', 'content');
			(mockEventBus.emit as ReturnType<typeof vi.fn>).mockClear();
			await storeWithEvents.exists('file.md');
			expect(mockEventBus.emit).not.toHaveBeenCalled();
		});

		it('succeeds without eventBus (backward compat)', async () => {
			// The default store has no eventBus
			await store.write('file.md', 'content');
			await store.append('log.md', 'entry\n');
			// No error thrown
		});

		it('includes spaceId when present', async () => {
			const spaceStore = new ScopedStore({
				baseDir: join(tempDir, 'store-space'),
				appId: 'test-app',
				userId: 'user-123',
				changeLog,
				spaceId: 'family',
				eventBus: mockEventBus,
			});
			await spaceStore.write('shared.md', 'data');
			const payload = (mockEventBus.emit as ReturnType<typeof vi.fn>).mock
				.calls[0][1] as DataChangedPayload;
			expect(payload.spaceId).toBe('family');
		});

		it('does not emit on archive of non-existent file', async () => {
			await storeWithEvents.archive('ghost.md');
			expect(mockEventBus.emit).not.toHaveBeenCalled();
		});

		it('emits userId: null for shared scope (forShared)', async () => {
			const sharedStore = new ScopedStore({
				baseDir: join(tempDir, 'store-shared'),
				appId: 'test-app',
				userId: null,
				changeLog,
				eventBus: mockEventBus,
			});
			await sharedStore.write('shared-file.md', 'shared data');
			expect(mockEventBus.emit).toHaveBeenCalledWith('data:changed', {
				operation: 'write',
				appId: 'test-app',
				userId: null,
				path: 'shared-file.md',
			});
		});

		it('write succeeds even if eventBus.emit throws', async () => {
			const throwingEventBus: EventBusService = {
				emit: vi.fn(() => {
					throw new Error('subscriber exploded');
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			const throwingStore = new ScopedStore({
				baseDir: join(tempDir, 'store-throw'),
				appId: 'test-app',
				userId: 'user-123',
				changeLog,
				eventBus: throwingEventBus,
			});
			// Write should succeed despite emit throwing
			await throwingStore.write('file.md', 'content');
			const content = await throwingStore.read('file.md');
			expect(content).toBe('content');
		});

		it('concurrent writes each emit their own event', async () => {
			await Promise.all([
				storeWithEvents.write('a.md', 'alpha'),
				storeWithEvents.write('b.md', 'beta'),
			]);
			const calls = (mockEventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
			const payloads = calls.map((c) => c[1] as DataChangedPayload);
			expect(payloads).toHaveLength(2);
			expect(payloads.find((p) => p.path === 'a.md')).toBeDefined();
			expect(payloads.find((p) => p.path === 'b.md')).toBeDefined();
		});
	});

	describe('path traversal protection', () => {
		it('rejects path with .. traversal', async () => {
			await expect(store.read('../../etc/passwd')).rejects.toThrow(PathTraversalError);
		});

		it('rejects write with .. traversal', async () => {
			await expect(store.write('../escape.md', 'bad')).rejects.toThrow(PathTraversalError);
		});

		it('rejects append with .. traversal', async () => {
			await expect(store.append('../../bad.md', 'bad')).rejects.toThrow(PathTraversalError);
		});

		it('rejects exists with .. traversal', async () => {
			await expect(store.exists('../../../.env')).rejects.toThrow(PathTraversalError);
		});

		it('rejects list with .. traversal', async () => {
			await expect(store.list('../../')).rejects.toThrow(PathTraversalError);
		});

		it('rejects archive with .. traversal', async () => {
			await expect(store.archive('../../secret.md')).rejects.toThrow(PathTraversalError);
		});

		it('rejects backslash traversal (..\\\\)', async () => {
			await expect(store.read('..\\..\\secret.md')).rejects.toThrow(PathTraversalError);
		});

		it('allows nested paths within scope', async () => {
			// These should NOT throw
			await store.write('sub/dir/file.md', 'ok');
			const content = await store.read('sub/dir/file.md');
			expect(content).toBe('ok');
		});
	});

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
			// Config is read-only — read should work (file won't exist, but should not throw scope error)
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
});
