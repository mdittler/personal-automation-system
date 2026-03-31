import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inferFrontmatter, migrate } from '../migrate-frontmatter.js';

describe('inferFrontmatter', () => {
	it('identifies daily-diff files', () => {
		const meta = inferFrontmatter('system/daily-diff/2026-03-19.md', '2026-03-19.md');
		expect(meta).toMatchObject({
			type: 'diff',
			date: '2026-03-19',
			tags: ['pas/daily-diff'],
			source: 'pas-daily-diff',
		});
	});

	it('identifies report history files', () => {
		const meta = inferFrontmatter(
			'system/report-history/weekly-review/2026-03-19_09-00-00.md',
			'2026-03-19_09-00-00.md',
		);
		expect(meta).toMatchObject({
			type: 'report',
			tags: ['pas/report', 'pas/report/weekly-review'],
		});
	});

	it('identifies alert history files', () => {
		const meta = inferFrontmatter(
			'system/alert-history/low-stock/2026-03-19_09-00-00.md',
			'2026-03-19_09-00-00.md',
		);
		expect(meta).toMatchObject({
			type: 'alert',
			tags: ['pas/alert', 'pas/alert/low-stock'],
		});
	});

	it('identifies model journal files', () => {
		const meta = inferFrontmatter(
			'model-journal/anthropic-claude-sonnet.md',
			'anthropic-claude-sonnet.md',
		);
		expect(meta).toMatchObject({
			type: 'journal',
			tags: ['pas/journal', 'pas/model/anthropic-claude-sonnet'],
		});
	});

	it('identifies daily notes files', () => {
		const meta = inferFrontmatter('users/user1/chatbot/daily-notes/2026-03-19.md', '2026-03-19.md');
		expect(meta).toMatchObject({
			type: 'daily-note',
			user: 'user1',
			app: 'chatbot',
			date: '2026-03-19',
		});
	});

	it('identifies echo log files', () => {
		const meta = inferFrontmatter('users/user1/echo/log.md', 'log.md');
		expect(meta).toMatchObject({
			type: 'log',
			user: 'user1',
			app: 'echo',
		});
	});

	it('returns null for unrecognized paths', () => {
		const meta = inferFrontmatter('random/unknown/file.md', 'file.md');
		expect(meta).toBeNull();
	});

	it('identifies model journal archive files', () => {
		const meta = inferFrontmatter(
			'model-journal-archive/anthropic-claude-sonnet/2026-03.md',
			'2026-03.md',
		);
		expect(meta).toMatchObject({
			type: 'journal',
			tags: ['pas/journal', 'pas/model/anthropic-claude-sonnet'],
		});
	});

	it('handles space-scoped daily notes', () => {
		// Space paths: data/spaces/<spaceId>/<appId>/... — not under users/
		const meta = inferFrontmatter('spaces/family/notes/grocery.md', 'grocery.md');
		expect(meta).toBeNull(); // Not a recognized pattern
	});
});

describe('migrate', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `pas-migrate-${randomBytes(6).toString('hex')}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it('adds frontmatter to files without it', async () => {
		const diffDir = join(testDir, 'system', 'daily-diff');
		await mkdir(diffDir, { recursive: true });
		await writeFile(join(diffDir, '2026-03-19.md'), '# Daily Diff\nContent\n');

		const result = await migrate(testDir);
		expect(result.migrated).toBe(1);

		const content = await readFile(join(diffDir, '2026-03-19.md'), 'utf-8');
		expect(content).toMatch(/^---\n/);
		expect(content).toContain('type: diff');
		expect(content).toContain('# Daily Diff');
	});

	it('skips files that already have frontmatter', async () => {
		const diffDir = join(testDir, 'system', 'daily-diff');
		await mkdir(diffDir, { recursive: true });
		await writeFile(join(diffDir, '2026-03-19.md'), '---\ntitle: Test\n---\n# Content\n');

		const result = await migrate(testDir);
		expect(result.migrated).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it('skips llm-usage.md', async () => {
		const sysDir = join(testDir, 'system');
		await mkdir(sysDir, { recursive: true });
		await writeFile(join(sysDir, 'llm-usage.md'), '| Col 1 | Col 2 |\n');

		const result = await migrate(testDir);
		expect(result.skipped).toBe(1);
		expect(result.migrated).toBe(0);
	});

	it('reports unrecognized files', async () => {
		const unknownDir = join(testDir, 'random');
		await mkdir(unknownDir, { recursive: true });
		await writeFile(join(unknownDir, 'mystery.md'), 'some content');

		const result = await migrate(testDir);
		expect(result.unrecognized).toHaveLength(1);
	});

	it('dry run does not modify files', async () => {
		const diffDir = join(testDir, 'system', 'daily-diff');
		await mkdir(diffDir, { recursive: true });
		const originalContent = '# Daily Diff\nContent\n';
		await writeFile(join(diffDir, '2026-03-19.md'), originalContent);

		const result = await migrate(testDir, { dryRun: true });
		expect(result.migrated).toBe(1);

		const content = await readFile(join(diffDir, '2026-03-19.md'), 'utf-8');
		expect(content).toBe(originalContent); // Unchanged
	});

	it('handles empty data directory', async () => {
		const result = await migrate(testDir);
		expect(result.migrated).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.unrecognized).toHaveLength(0);
	});

	it('handles multiple file types in one run', async () => {
		// Create various file types
		const diffDir = join(testDir, 'system', 'daily-diff');
		const journalDir = join(testDir, 'model-journal');
		const notesDir = join(testDir, 'users', 'user1', 'notes', 'daily-notes');

		await mkdir(diffDir, { recursive: true });
		await mkdir(journalDir, { recursive: true });
		await mkdir(notesDir, { recursive: true });

		await writeFile(join(diffDir, '2026-03-19.md'), '# Diff\n');
		await writeFile(join(journalDir, 'test-model.md'), '# Journal\n');
		await writeFile(join(notesDir, '2026-03-19.md'), '- Note\n');

		const result = await migrate(testDir);
		expect(result.migrated).toBe(3);
	});
});
