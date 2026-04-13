import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextEntry, ContextStoreService } from '../../../types/context-store.js';
import type { ChangeLog } from '../../data-store/change-log.js';
import { type CollectorDeps, collectSection, resolveDateTokens } from '../section-collector.js';

const logger = pino({ level: 'silent' });
const timezone = 'America/New_York';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-section-test-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeChangeLog(logPath: string): ChangeLog {
	return { getLogPath: () => logPath } as ChangeLog;
}

function makeContextStore(entries: ContextEntry[] = []): ContextStoreService {
	return {
		get: vi.fn().mockResolvedValue(null),
		search: vi.fn().mockResolvedValue(entries),
	};
}

function makeDeps(overrides: Partial<CollectorDeps> = {}): CollectorDeps {
	return {
		changeLog: makeChangeLog(join(tempDir, 'change-log.jsonl')),
		dataDir: tempDir,
		contextStore: makeContextStore(),
		timezone,
		logger,
		...overrides,
	};
}

describe('collectSection — changes', () => {
	it('collects changes from change log', async () => {
		const logPath = join(tempDir, 'change-log.jsonl');
		const entry = {
			timestamp: new Date().toISOString(),
			appId: 'notes',
			userId: '123',
			operation: 'write',
			path: 'daily-notes/2026-03-14.md',
		};
		await writeFile(logPath, `${JSON.stringify(entry)}\n`);

		const deps = makeDeps({ changeLog: makeChangeLog(logPath) });
		const result = await collectSection(
			{ type: 'changes', label: 'Recent Changes', config: { lookback_hours: 1 } },
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toContain('notes');
		expect(result.content).toContain('daily-notes/2026-03-14.md');
	});

	it('returns empty when no changes exist', async () => {
		const deps = makeDeps();
		const result = await collectSection({ type: 'changes', label: 'Changes', config: {} }, deps);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('No changes');
	});

	it('filters by app when app_filter specified', async () => {
		const logPath = join(tempDir, 'change-log.jsonl');
		const entries = [
			{
				timestamp: new Date().toISOString(),
				appId: 'notes',
				userId: '123',
				operation: 'write',
				path: 'a.md',
			},
			{
				timestamp: new Date().toISOString(),
				appId: 'echo',
				userId: '123',
				operation: 'write',
				path: 'b.md',
			},
		];
		await writeFile(logPath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);

		const deps = makeDeps({ changeLog: makeChangeLog(logPath) });
		const result = await collectSection(
			{ type: 'changes', label: 'Changes', config: { app_filter: ['notes'] } },
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toContain('notes');
		expect(result.content).not.toContain('echo');
	});

	it('returns empty when filter matches no apps', async () => {
		const logPath = join(tempDir, 'change-log.jsonl');
		const entry = {
			timestamp: new Date().toISOString(),
			appId: 'notes',
			userId: '123',
			operation: 'write',
			path: 'a.md',
		};
		await writeFile(logPath, `${JSON.stringify(entry)}\n`);

		const deps = makeDeps({ changeLog: makeChangeLog(logPath) });
		const result = await collectSection(
			{ type: 'changes', label: 'Changes', config: { app_filter: ['unknown-app'] } },
			deps,
		);

		expect(result.isEmpty).toBe(true);
	});

	it('uses default lookback hours when not specified', async () => {
		const logPath = join(tempDir, 'change-log.jsonl');
		// Entry from 48 hours ago — outside default 24h window
		const oldEntry = {
			timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
			appId: 'notes',
			userId: '123',
			operation: 'write',
			path: 'a.md',
		};
		await writeFile(logPath, `${JSON.stringify(oldEntry)}\n`);

		const deps = makeDeps({ changeLog: makeChangeLog(logPath) });
		const result = await collectSection({ type: 'changes', label: 'Changes', config: {} }, deps);

		expect(result.isEmpty).toBe(true);
	});
});

describe('collectSection — app-data', () => {
	it('reads an app data file', async () => {
		const userDir = join(tempDir, 'users', '123', 'notes');
		await mkdir(userDir, { recursive: true });
		await writeFile(join(userDir, 'file.md'), 'Note content here');

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Notes',
				config: { app_id: 'notes', user_id: '123', path: 'file.md' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toBe('Note content here');
	});

	it('returns file not found when file missing', async () => {
		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Notes',
				config: { app_id: 'notes', user_id: '123', path: 'missing.md' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('File not found');
	});

	it('rejects path traversal attempt', async () => {
		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Notes',
				config: { app_id: 'notes', user_id: '123', path: '../../etc/passwd' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('Invalid path');
	});

	it('rejects path that escapes via prefix match (e.g., notes-evil)', async () => {
		// Ensure a sibling directory with a prefix-matching name doesn't bypass the check
		const evilDir = join(tempDir, 'users', '123', 'notes-evil');
		await mkdir(evilDir, { recursive: true });
		await writeFile(join(evilDir, 'secret.md'), 'Stolen data');

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Notes',
				// This path resolves to the notes-evil directory via ../ from notes
				config: { app_id: 'notes', user_id: '123', path: '../notes-evil/secret.md' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('Invalid path');
	});

	it('resolves {today} date token', async () => {
		const today = new Date();
		const todayStr = today.toISOString().slice(0, 10); // approximate — timezone may differ

		const userDir = join(tempDir, 'users', '123', 'notes', 'daily-notes');
		await mkdir(userDir, { recursive: true });

		// Write file for UTC date (close enough for test)
		await writeFile(join(userDir, `${todayStr}.md`), 'Today content');

		const deps = makeDeps({ timezone: 'UTC' });
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Today Notes',
				config: { app_id: 'notes', user_id: '123', path: 'daily-notes/{today}.md' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toBe('Today content');
	});

	it('returns empty for empty file', async () => {
		const userDir = join(tempDir, 'users', '123', 'notes');
		await mkdir(userDir, { recursive: true });
		await writeFile(join(userDir, 'empty.md'), '');

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Data',
				config: { app_id: 'notes', user_id: '123', path: 'empty.md' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(true);
	});
});

describe('collectSection — app-data (directory)', () => {
	it('reads most recent file from a directory', async () => {
		const dir = join(tempDir, 'users', '123', 'notes', 'daily-notes');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'old.md'), 'old content');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 50));
		await writeFile(join(dir, 'new.md'), 'newest content');

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Latest',
				config: { app_id: 'notes', user_id: '123', path: 'daily-notes' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toBe('newest content');
	});

	it('returns empty for an empty directory', async () => {
		const dir = join(tempDir, 'users', '123', 'notes', 'empty-dir');
		await mkdir(dir, { recursive: true });

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Empty',
				config: { app_id: 'notes', user_id: '123', path: 'empty-dir' },
			},
			deps,
		);

		expect(result.isEmpty).toBe(true);
	});
});

describe('collectSection — context', () => {
	it('collects matching context entries', async () => {
		const contextStore = makeContextStore([
			{ key: 'preferences-coffee', content: 'Dark roast, no sugar', lastUpdated: new Date() },
			{ key: 'preferences-food', content: 'Vegetarian', lastUpdated: new Date() },
		]);

		const deps = makeDeps({ contextStore });
		const result = await collectSection(
			{ type: 'context', label: 'Prefs', config: { key_prefix: 'preferences' } },
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toContain('preferences-coffee');
		expect(result.content).toContain('Dark roast');
		expect(result.content).toContain('Vegetarian');
	});

	it('returns empty when no context entries match', async () => {
		const deps = makeDeps();
		const result = await collectSection(
			{ type: 'context', label: 'Ctx', config: { key_prefix: 'nonexistent' } },
			deps,
		);

		expect(result.isEmpty).toBe(true);
	});
});

describe('collectSection — custom', () => {
	it('returns custom text as-is', () => {
		const deps = makeDeps();
		const result = collectSection(
			{ type: 'custom', label: 'Intro', config: { text: 'Hello world' } },
			deps,
		);

		// collectSection returns a promise even for sync sections
		return result.then((r) => {
			expect(r.isEmpty).toBe(false);
			expect(r.content).toBe('Hello world');
		});
	});

	it('returns empty for whitespace-only text', async () => {
		const deps = makeDeps();
		const result = await collectSection(
			{ type: 'custom', label: 'Empty', config: { text: '   ' } },
			deps,
		);

		expect(result.isEmpty).toBe(true);
	});
});

describe('collectSection — error handling', () => {
	it('returns error message for unknown section type', async () => {
		const deps = makeDeps();
		const result = await collectSection({ type: 'unknown' as any, label: 'Bad', config: {} }, deps);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('Unknown section type');
	});

	it('catches errors and returns error message', async () => {
		// Create a context store that throws
		const contextStore: ContextStoreService = {
			get: vi.fn().mockRejectedValue(new Error('DB error')),
			search: vi.fn().mockRejectedValue(new Error('DB error')),
		};

		const deps = makeDeps({ contextStore });
		const result = await collectSection(
			{ type: 'context', label: 'Ctx', config: { key_prefix: 'test' } },
			deps,
		);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('Error collecting data');
	});
});

describe('resolveDateTokens', () => {
	it('resolves {date} token (alias for {today})', () => {
		const result = resolveDateTokens('log/{date}.md', 'UTC');
		const todayStr = new Date().toISOString().slice(0, 10);
		expect(result).toBe(`log/${todayStr}.md`);
	});

	it('resolves {today} token', () => {
		const result = resolveDateTokens('notes/{today}.md', 'UTC');
		const todayStr = new Date().toISOString().slice(0, 10);
		expect(result).toBe(`notes/${todayStr}.md`);
	});

	it('resolves {yesterday} token', () => {
		const result = resolveDateTokens('notes/{yesterday}.md', 'UTC');
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const yesterdayStr = yesterday.toISOString().slice(0, 10);
		expect(result).toBe(`notes/${yesterdayStr}.md`);
	});

	it('resolves multiple tokens in one path', () => {
		const result = resolveDateTokens('{today}/{yesterday}.md', 'UTC');
		expect(result).not.toContain('{today}');
		expect(result).not.toContain('{yesterday}');
	});

	it('leaves paths without tokens unchanged', () => {
		const result = resolveDateTokens('notes/fixed-file.md', 'UTC');
		expect(result).toBe('notes/fixed-file.md');
	});

	it('handles invalid timezone gracefully', () => {
		const result = resolveDateTokens('notes/{today}.md', 'Invalid/Zone');
		// Should fall back to ISO date
		expect(result).toMatch(/notes\/\d{4}-\d{2}-\d{2}\.md/);
	});
});
