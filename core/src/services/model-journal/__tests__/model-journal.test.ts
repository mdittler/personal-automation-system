import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripFrontmatter } from '../../../utils/frontmatter.js';
import { type ModelJournalOptions, ModelJournalServiceImpl, slugifyModelId } from '../index.js';

describe('slugifyModelId', () => {
	it('passes through already-valid slugs', () => {
		expect(slugifyModelId('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
	});

	it('replaces slashes with hyphens', () => {
		expect(slugifyModelId('anthropic/claude-sonnet-4-20250514')).toBe(
			'anthropic-claude-sonnet-4-20250514',
		);
	});

	it('lowercases the input', () => {
		expect(slugifyModelId('Anthropic/Claude-Sonnet')).toBe('anthropic-claude-sonnet');
	});

	it('replaces dots and colons with hyphens', () => {
		expect(slugifyModelId('model.v2:latest')).toBe('model-v2-latest');
	});

	it('collapses consecutive hyphens', () => {
		expect(slugifyModelId('foo//bar')).toBe('foo-bar');
	});

	it('trims leading and trailing hyphens', () => {
		expect(slugifyModelId('/model/')).toBe('model');
	});

	it('handles empty string', () => {
		expect(slugifyModelId('')).toBe('');
	});
});

describe('ModelJournalService', () => {
	let tempDir: string;
	let dataDir: string;

	const mockLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	let svc: ModelJournalServiceImpl;
	const MODEL_SLUG = 'anthropic-claude-sonnet-4-20250514';

	beforeEach(async () => {
		vi.clearAllMocks();
		tempDir = await mkdtemp(join(tmpdir(), 'pas-journal-'));
		dataDir = join(tempDir, 'data');
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });

		svc = new ModelJournalServiceImpl({
			dataDir,
			timezone: 'UTC',
			logger: mockLogger,
		} as unknown as ModelJournalOptions);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('read', () => {
		it('returns empty string when no journal exists', async () => {
			const content = await svc.read(MODEL_SLUG);
			expect(content).toBe('');
		});

		it('returns journal content when file exists', async () => {
			const journalPath = join(dataDir, 'model-journal', `${MODEL_SLUG}.md`);
			await writeFile(journalPath, '# Journal \u2014 2026-03\n\nSome content\n', 'utf-8');

			const content = await svc.read(MODEL_SLUG);
			expect(content).toContain('Some content');
			expect(content).toContain('# Journal \u2014 2026-03');
		});

		it('returns empty string for invalid slug', async () => {
			const content = await svc.read('../etc/passwd');
			expect(content).toBe('');
		});
	});

	describe('append', () => {
		it('creates journal file with month header on first write', async () => {
			await svc.append(MODEL_SLUG, 'First entry');

			const raw = await svc.read(MODEL_SLUG);
			const content = stripFrontmatter(raw);
			expect(content).toMatch(/^# Journal \u2014 \d{4}-\d{2}\n/);
			expect(content).toContain('First entry');
		});

		it('appends entries with timestamp headers', async () => {
			await svc.append(MODEL_SLUG, 'Entry one');
			await svc.append(MODEL_SLUG, 'Entry two');

			const raw = await svc.read(MODEL_SLUG);
			const content = stripFrontmatter(raw);
			expect(content).toContain('Entry one');
			expect(content).toContain('Entry two');
			const separators = content.match(/^---$/gm);
			expect(separators).toHaveLength(2);
		});

		it('includes date and time in entry header', async () => {
			await svc.append(MODEL_SLUG, 'Timestamped entry');

			const content = await svc.read(MODEL_SLUG);
			expect(content).toMatch(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
		});

		it('skips empty content', async () => {
			await svc.append(MODEL_SLUG, '');
			const content = await svc.read(MODEL_SLUG);
			expect(content).toBe('');
		});

		it('skips whitespace-only content', async () => {
			await svc.append(MODEL_SLUG, '   \n\t  ');
			const content = await svc.read(MODEL_SLUG);
			expect(content).toBe('');
		});

		it('trims content before writing', async () => {
			await svc.append(MODEL_SLUG, '  trimmed content  ');

			const content = await svc.read(MODEL_SLUG);
			expect(content).toContain('trimmed content');
			expect(content).not.toContain('  trimmed');
		});

		it('creates model-journal directory if missing', async () => {
			const freshDataDir = join(tempDir, 'fresh-data');
			const freshSvc = new ModelJournalServiceImpl({
				dataDir: freshDataDir,
				timezone: 'UTC',
				logger: mockLogger,
			} as unknown as ModelJournalOptions);

			await freshSvc.append(MODEL_SLUG, 'Entry in new dir');
			const content = await freshSvc.read(MODEL_SLUG);
			expect(content).toContain('Entry in new dir');
		});

		it('does nothing for invalid slug', async () => {
			await svc.append('', 'Should not write');
			await svc.append('../traversal', 'Should not write');
			const models = await svc.listModels();
			expect(models).toHaveLength(0);
		});
	});

	describe('multi-model isolation', () => {
		it('each model reads only its own journal', async () => {
			await svc.append('model-a', 'Entry for A');
			await svc.append('model-b', 'Entry for B');

			const contentA = await svc.read('model-a');
			const contentB = await svc.read('model-b');

			expect(contentA).toContain('Entry for A');
			expect(contentA).not.toContain('Entry for B');
			expect(contentB).toContain('Entry for B');
			expect(contentB).not.toContain('Entry for A');
		});

		it('archives are independent per model', async () => {
			const pathA = join(dataDir, 'model-journal', 'model-a.md');
			await writeFile(
				pathA,
				'# Journal \u2014 2025-01\n\n---\n### 2025-01-15 10:30\n\nOld entry A\n\n',
				'utf-8',
			);

			await svc.append('model-a', 'New entry A');

			const archivesA = await svc.listArchives('model-a');
			expect(archivesA).toContain('2025-01.md');

			const archivesB = await svc.listArchives('model-b');
			expect(archivesB).toHaveLength(0);
		});
	});

	describe('archival', () => {
		it('archives journal when month differs from current', async () => {
			const journalPath = join(dataDir, 'model-journal', `${MODEL_SLUG}.md`);
			await writeFile(
				journalPath,
				'# Journal \u2014 2025-01\n\n---\n### 2025-01-15 10:30\n\nOld entry\n\n',
				'utf-8',
			);

			await svc.append(MODEL_SLUG, 'New entry');

			const archives = await svc.listArchives(MODEL_SLUG);
			expect(archives).toContain('2025-01.md');

			const archiveContent = await svc.readArchive(MODEL_SLUG, '2025-01.md');
			expect(archiveContent).toContain('Old entry');

			const current = await svc.read(MODEL_SLUG);
			expect(current).toContain('New entry');
			expect(current).not.toContain('Old entry');
		});

		it('does not archive when month matches current', async () => {
			await svc.append(MODEL_SLUG, 'First entry');
			await svc.append(MODEL_SLUG, 'Second entry');

			const archives = await svc.listArchives(MODEL_SLUG);
			expect(archives).toHaveLength(0);

			const content = await svc.read(MODEL_SLUG);
			expect(content).toContain('First entry');
			expect(content).toContain('Second entry');
		});

		it('creates archive directory if missing', async () => {
			const journalPath = join(dataDir, 'model-journal', `${MODEL_SLUG}.md`);
			await writeFile(journalPath, '# Journal \u2014 2024-06\n\nOld\n', 'utf-8');

			await svc.append(MODEL_SLUG, 'New');

			const archives = await svc.listArchives(MODEL_SLUG);
			expect(archives).toContain('2024-06.md');
		});

		it('skips archival when journal has no month header', async () => {
			const journalPath = join(dataDir, 'model-journal', `${MODEL_SLUG}.md`);
			await writeFile(journalPath, 'Some content without header\n', 'utf-8');

			await svc.append(MODEL_SLUG, 'New entry');

			const content = await svc.read(MODEL_SLUG);
			expect(content).toContain('Some content without header');
			expect(content).toContain('New entry');
		});
	});

	describe('listArchives', () => {
		it('returns empty array when no archive directory exists', async () => {
			const archives = await svc.listArchives(MODEL_SLUG);
			expect(archives).toEqual([]);
		});

		it('returns sorted archive filenames (newest first)', async () => {
			const archiveDir = join(dataDir, 'model-journal-archive', MODEL_SLUG);
			await mkdir(archiveDir, { recursive: true });
			await writeFile(join(archiveDir, '2025-06.md'), 'June', 'utf-8');
			await writeFile(join(archiveDir, '2025-01.md'), 'Jan', 'utf-8');
			await writeFile(join(archiveDir, '2025-11.md'), 'Nov', 'utf-8');

			const archives = await svc.listArchives(MODEL_SLUG);
			expect(archives).toEqual(['2025-11.md', '2025-06.md', '2025-01.md']);
		});

		it('filters out non-archive files', async () => {
			const archiveDir = join(dataDir, 'model-journal-archive', MODEL_SLUG);
			await mkdir(archiveDir, { recursive: true });
			await writeFile(join(archiveDir, '2025-06.md'), 'June', 'utf-8');
			await writeFile(join(archiveDir, 'notes.txt'), 'junk', 'utf-8');

			const archives = await svc.listArchives(MODEL_SLUG);
			expect(archives).toEqual(['2025-06.md']);
		});

		it('returns empty for invalid slug', async () => {
			const archives = await svc.listArchives('../traversal');
			expect(archives).toEqual([]);
		});
	});

	describe('readArchive', () => {
		it('returns archive content', async () => {
			const archiveDir = join(dataDir, 'model-journal-archive', MODEL_SLUG);
			await mkdir(archiveDir, { recursive: true });
			await writeFile(
				join(archiveDir, '2025-03.md'),
				'# Journal \u2014 2025-03\n\nArchived content\n',
				'utf-8',
			);

			const content = await svc.readArchive(MODEL_SLUG, '2025-03.md');
			expect(content).toContain('Archived content');
		});

		it('returns empty string for non-existent archive', async () => {
			const content = await svc.readArchive(MODEL_SLUG, '2020-01.md');
			expect(content).toBe('');
		});

		it('returns empty string for invalid filename (path traversal)', async () => {
			const content = await svc.readArchive(MODEL_SLUG, '../../etc/passwd');
			expect(content).toBe('');
		});

		it('returns empty string for filename not matching pattern', async () => {
			const content = await svc.readArchive(MODEL_SLUG, 'notes.md');
			expect(content).toBe('');
		});

		it('returns empty string for invalid model slug', async () => {
			const content = await svc.readArchive('../bad', '2025-03.md');
			expect(content).toBe('');
		});
	});

	describe('listModels', () => {
		it('returns empty array when no journals exist', async () => {
			const models = await svc.listModels();
			expect(models).toEqual([]);
		});

		it('returns slugs of models with journal files', async () => {
			await svc.append('model-a', 'Entry A');
			await svc.append('model-b', 'Entry B');

			const models = await svc.listModels();
			expect(models).toEqual(['model-a', 'model-b']);
		});

		it('filters out non-md files', async () => {
			await svc.append('model-a', 'Entry');
			await writeFile(join(dataDir, 'model-journal', 'readme.txt'), 'junk', 'utf-8');

			const models = await svc.listModels();
			expect(models).toEqual(['model-a']);
		});

		it('returns sorted slugs', async () => {
			await svc.append('zeta-model', 'Z');
			await svc.append('alpha-model', 'A');

			const models = await svc.listModels();
			expect(models).toEqual(['alpha-model', 'zeta-model']);
		});

		it('returns empty when model-journal directory does not exist', async () => {
			const freshSvc = new ModelJournalServiceImpl({
				dataDir: join(tempDir, 'nonexistent'),
				timezone: 'UTC',
				logger: mockLogger,
			} as unknown as ModelJournalOptions);
			const models = await freshSvc.listModels();
			expect(models).toEqual([]);
		});
	});

	describe('timezone', () => {
		it('uses configured timezone for month headers', async () => {
			const tzSvc = new ModelJournalServiceImpl({
				dataDir,
				timezone: 'America/New_York',
				logger: mockLogger,
			} as unknown as ModelJournalOptions);

			await tzSvc.append(MODEL_SLUG, 'Timezone test');
			const raw = await tzSvc.read(MODEL_SLUG);
			const content = stripFrontmatter(raw);
			expect(content).toMatch(/^# Journal \u2014 \d{4}-\d{2}/);
		});

		it('falls back to UTC for empty timezone', async () => {
			const tzSvc = new ModelJournalServiceImpl({
				dataDir,
				timezone: '',
				logger: mockLogger,
			} as unknown as ModelJournalOptions);

			await tzSvc.append(MODEL_SLUG, 'UTC test');
			const raw = await tzSvc.read(MODEL_SLUG);
			const content = stripFrontmatter(raw);
			expect(content).toMatch(/^# Journal \u2014 \d{4}-\d{2}/);
		});
	});

	describe('error handling', () => {
		it('logs warning and continues when archival rename fails', async () => {
			const journalPath = join(dataDir, 'model-journal', `${MODEL_SLUG}.md`);
			await writeFile(
				journalPath,
				'# Journal \u2014 2024-01\n\n---\n### 2024-01-15 10:00\n\nOld\n\n',
				'utf-8',
			);

			// Make archive dir a file so rename fails
			const archiveDir = join(dataDir, 'model-journal-archive', MODEL_SLUG);
			await mkdir(join(dataDir, 'model-journal-archive'), { recursive: true });
			await writeFile(archiveDir, 'not-a-dir', 'utf-8');

			await svc.append(MODEL_SLUG, 'New entry after failed archive');

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to archive'),
				expect.any(String),
				expect.anything(),
			);
			// Entry should still be appended to existing file
			const content = await svc.read(MODEL_SLUG);
			expect(content).toContain('New entry after failed archive');
		});

		it('handles ensureDir failure gracefully on first write', async () => {
			// Create a file where model-journal directory should be, making ensureDir fail
			const badDataDir = join(tempDir, 'bad-data');
			await writeFile(badDataDir, 'not-a-dir', 'utf-8');

			const badSvc = new ModelJournalServiceImpl({
				dataDir: badDataDir,
				timezone: 'UTC',
				logger: mockLogger,
			} as unknown as ModelJournalOptions);

			await expect(badSvc.append(MODEL_SLUG, 'Entry')).rejects.toThrow();
		});
	});

	describe('concurrency', () => {
		it('serializes concurrent appends for the same model', async () => {
			const promises = [];
			for (let i = 0; i < 5; i++) {
				promises.push(svc.append(MODEL_SLUG, `Concurrent entry ${i}`));
			}
			await Promise.all(promises);

			const content = await readFile(join(dataDir, 'model-journal', `${MODEL_SLUG}.md`), 'utf-8');

			// All entries present
			for (let i = 0; i < 5; i++) {
				expect(content).toContain(`Concurrent entry ${i}`);
			}

			// Only one month header (no duplicate from race)
			const headers = content.match(/^# Journal/gm);
			expect(headers).toHaveLength(1);
		});

		it('independent models can append concurrently without interference', async () => {
			const promises = [svc.append('model-x', 'Entry X'), svc.append('model-y', 'Entry Y')];
			await Promise.all(promises);

			const contentX = await svc.read('model-x');
			const contentY = await svc.read('model-y');
			expect(contentX).toContain('Entry X');
			expect(contentX).not.toContain('Entry Y');
			expect(contentY).toContain('Entry Y');
			expect(contentY).not.toContain('Entry X');
		});
	});
});
