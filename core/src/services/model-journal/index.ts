/**
 * Model journal service implementation.
 *
 * Manages per-model persistent markdown files the AI models can write to freely.
 * Each model gets its own journal at data/model-journal/{model-slug}.md
 * with archives at data/model-journal-archive/{model-slug}/YYYY-MM.md.
 * Entries are appended with timestamps. Monthly archival rotates old entries.
 */

import { appendFile as fsAppend, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { ModelJournalService } from '../../types/model-journal.js';
import { ensureDir } from '../../utils/file.js';
import {
	generateFrontmatter,
	parseFrontmatter,
	stripFrontmatter,
} from '../../utils/frontmatter.js';
import { slugifyModelId } from '../../utils/slugify.js';

export { slugifyModelId };

/** Pattern for valid archive filenames. */
export const ARCHIVE_FILENAME_PATTERN = /^\d{4}-\d{2}\.md$/;

/** Pattern for valid model slugs. */
export const MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ModelJournalOptions {
	dataDir: string;
	timezone: string;
	logger: Logger;
}

export class ModelJournalServiceImpl implements ModelJournalService {
	private readonly dataDir: string;
	private readonly timezone: string;
	private readonly logger: Logger;
	private readonly writeQueue = new Map<string, Promise<void>>();

	constructor(options: ModelJournalOptions) {
		this.dataDir = options.dataDir;
		this.timezone = options.timezone || 'UTC';
		this.logger = options.logger;
	}

	/** Serialize write operations per model slug to prevent TOCTOU races. */
	private enqueue(slug: string, fn: () => Promise<void>): Promise<void> {
		const prev = this.writeQueue.get(slug) ?? Promise.resolve();
		const next = prev.then(fn, fn).finally(() => {
			if (this.writeQueue.get(slug) === next) this.writeQueue.delete(slug);
		});
		this.writeQueue.set(slug, next);
		return next;
	}

	/** Get the journal file path for a model. */
	private getJournalPath(modelSlug: string): string {
		return join(this.dataDir, 'model-journal', `${modelSlug}.md`);
	}

	/** Get the archive directory for a model. */
	private getArchiveDir(modelSlug: string): string {
		return join(this.dataDir, 'model-journal-archive', modelSlug);
	}

	/** Validate a model slug. Returns false for invalid slugs. */
	private isValidSlug(modelSlug: string): boolean {
		return MODEL_SLUG_PATTERN.test(modelSlug);
	}

	async read(modelSlug: string): Promise<string> {
		if (!this.isValidSlug(modelSlug)) return '';
		try {
			const raw = await readFile(this.getJournalPath(modelSlug), 'utf-8');
			return stripFrontmatter(raw);
		} catch {
			return '';
		}
	}

	/** Read raw file content including frontmatter (for internal archival). */
	private async readRaw(modelSlug: string): Promise<string> {
		if (!this.isValidSlug(modelSlug)) return '';
		try {
			return await readFile(this.getJournalPath(modelSlug), 'utf-8');
		} catch {
			return '';
		}
	}

	async append(modelSlug: string, content: string): Promise<void> {
		if (!this.isValidSlug(modelSlug)) return;
		const trimmed = content.trim();
		if (!trimmed) return;

		return this.enqueue(modelSlug, async () => {
			const journalPath = this.getJournalPath(modelSlug);

			// Check if archival is needed before writing
			await this.archiveIfNeeded(modelSlug);

			const now = new Date();
			const dateStr = this.formatDate(now);
			const timeStr = this.formatTime(now);
			const header = this.getMonthHeader(now);

			// If file doesn't exist or is empty, write frontmatter + month header first
			const existing = await this.read(modelSlug);
			if (!existing) {
				await ensureDir(join(journalPath, '..'));
				const frontmatter = generateFrontmatter({
					title: `Model Journal - ${modelSlug}`,
					tags: ['pas/journal', `pas/model/${modelSlug}`],
					type: 'journal',
					source: 'pas-model-journal',
				});
				await fsAppend(journalPath, `${frontmatter}${header}\n\n`, 'utf-8');
			}

			const entry = `---\n### ${dateStr} ${timeStr}\n\n${trimmed}\n\n`;
			await fsAppend(journalPath, entry, 'utf-8');
		});
	}

	async listArchives(modelSlug: string): Promise<string[]> {
		if (!this.isValidSlug(modelSlug)) return [];
		try {
			const entries = await readdir(this.getArchiveDir(modelSlug));
			return entries
				.filter((name) => ARCHIVE_FILENAME_PATTERN.test(name))
				.sort()
				.reverse(); // newest first
		} catch {
			return [];
		}
	}

	async readArchive(modelSlug: string, filename: string): Promise<string> {
		if (!this.isValidSlug(modelSlug)) return '';
		if (!ARCHIVE_FILENAME_PATTERN.test(filename)) return '';

		try {
			const archivePath = join(this.getArchiveDir(modelSlug), filename);
			return await readFile(archivePath, 'utf-8');
		} catch {
			return '';
		}
	}

	async listModels(): Promise<string[]> {
		try {
			const journalDir = join(this.dataDir, 'model-journal');
			const entries = await readdir(journalDir);
			return entries
				.filter((name) => name.endsWith('.md'))
				.map((name) => name.slice(0, -3))
				.filter((slug) => this.isValidSlug(slug))
				.sort();
		} catch {
			return [];
		}
	}

	/**
	 * Check if a model's journal file belongs to a previous month.
	 * If so, move it to the model's archive directory.
	 */
	private async archiveIfNeeded(modelSlug: string): Promise<void> {
		const existing = await this.readRaw(modelSlug);
		if (!existing) return;

		// Extract month from header: "# Journal — YYYY-MM" (may be after frontmatter)
		const { content: bodyContent } = parseFrontmatter(existing);
		const match = bodyContent.match(/^# Journal — (\d{4}-\d{2})/);
		if (!match) return;

		const fileMonth = match[1];
		const currentMonth = this.getCurrentMonth();

		if (fileMonth === currentMonth) return;

		// Archive the file
		try {
			const archiveDir = this.getArchiveDir(modelSlug);
			await ensureDir(archiveDir);
			const archivePath = join(archiveDir, `${fileMonth}.md`);
			await rename(this.getJournalPath(modelSlug), archivePath);
			this.logger.info('Archived model journal for %s (%s)', modelSlug, fileMonth);
		} catch (error) {
			this.logger.warn('Failed to archive model journal for %s: %s', modelSlug, error);
		}
	}

	/** Get current month as YYYY-MM using configured timezone. */
	private getCurrentMonth(): string {
		const now = new Date();
		const yearFormatter = new Intl.DateTimeFormat('en-CA', {
			year: 'numeric',
			month: '2-digit',
			timeZone: this.timezone,
		});
		// en-CA gives YYYY-MM-DD format
		const parts = yearFormatter.format(now);
		return parts.slice(0, 7); // YYYY-MM
	}

	/** Get month header string for a date. */
	private getMonthHeader(date: Date): string {
		const yearFormatter = new Intl.DateTimeFormat('en-CA', {
			year: 'numeric',
			month: '2-digit',
			timeZone: this.timezone,
		});
		const month = yearFormatter.format(date).slice(0, 7);
		return `# Journal \u2014 ${month}`;
	}

	/** Format a date as YYYY-MM-DD using configured timezone. */
	private formatDate(date: Date): string {
		const formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone: this.timezone,
		});
		return formatter.format(date);
	}

	/** Format time as HH:MM using configured timezone. */
	private formatTime(date: Date): string {
		const formatter = new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			timeZone: this.timezone,
		});
		return formatter.format(date);
	}
}
