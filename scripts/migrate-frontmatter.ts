#!/usr/bin/env tsx
/**
 * Migration script: Add YAML frontmatter to existing markdown files in data/.
 *
 * Walks data/ recursively, identifies .md files by path pattern,
 * and prepends Obsidian-compatible frontmatter to files that don't have it.
 *
 * Usage: pnpm migrate-frontmatter [--dry-run]
 *
 * Safe to run multiple times — files with existing frontmatter are skipped.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { atomicWrite } from '../core/src/utils/file.js';
import { generateFrontmatter, hasFrontmatter } from '../core/src/utils/frontmatter.js';
import type { FrontmatterMeta } from '../core/src/utils/frontmatter.js';

const DATA_DIR = join(import.meta.dirname ?? '.', '..', 'data');

/** Files to skip (not notes). */
const SKIP_FILES = new Set(['llm-usage.md']);

interface MigrationResult {
	migrated: number;
	skipped: number;
	unrecognized: string[];
	errors: string[];
}

/**
 * Determine frontmatter metadata from file path relative to data/.
 * Returns null if the file type can't be determined.
 */
export function inferFrontmatter(relPath: string, fileName: string): FrontmatterMeta | null {
	const parts = relPath.split(/[\\/]/);

	// Extract date from filename if present (YYYY-MM-DD.md or YYYY-MM-DD_*.md)
	const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})/);
	const dateStr = dateMatch?.[1];

	// data/system/daily-diff/YYYY-MM-DD.md
	if (parts.includes('daily-diff') && parts.includes('system')) {
		return {
			title: `Daily Diff - ${dateStr ?? fileName.replace('.md', '')}`,
			date: dateStr,
			tags: ['pas/daily-diff'],
			type: 'diff',
			source: 'pas-daily-diff',
		};
	}

	// data/system/report-history/<reportId>/YYYY-MM-DD_*.md
	if (parts.includes('report-history') && parts.includes('system')) {
		const reportIdIdx = parts.indexOf('report-history') + 1;
		const reportId = parts[reportIdIdx] ?? 'unknown';
		return {
			title: `Report: ${reportId}`,
			date: dateStr,
			tags: ['pas/report', `pas/report/${reportId}`],
			type: 'report',
			source: 'pas-reports',
		};
	}

	// data/system/alert-history/<alertId>/YYYY-MM-DD_*.md
	if (parts.includes('alert-history') && parts.includes('system')) {
		const alertIdIdx = parts.indexOf('alert-history') + 1;
		const alertId = parts[alertIdIdx] ?? 'unknown';
		return {
			title: `Alert: ${alertId}`,
			date: dateStr,
			tags: ['pas/alert', `pas/alert/${alertId}`],
			type: 'alert',
			source: 'pas-alerts',
		};
	}

	// data/model-journal/<model-slug>.md
	if (parts.includes('model-journal') && !parts.includes('model-journal-archive')) {
		const modelSlug = fileName.replace('.md', '');
		return {
			title: `Model Journal - ${modelSlug}`,
			tags: ['pas/journal', `pas/model/${modelSlug}`],
			type: 'journal',
			source: 'pas-model-journal',
		};
	}

	// data/model-journal-archive/<model-slug>/YYYY-MM.md
	if (parts.includes('model-journal-archive')) {
		const archiveIdx = parts.indexOf('model-journal-archive');
		const modelSlug = parts[archiveIdx + 1] ?? 'unknown';
		return {
			title: `Model Journal Archive - ${modelSlug}`,
			date: dateStr,
			tags: ['pas/journal', `pas/model/${modelSlug}`],
			type: 'journal',
			source: 'pas-model-journal',
		};
	}

	// data/users/<userId>/<appId>/daily-notes/YYYY-MM-DD.md
	if (parts.includes('daily-notes') && parts.includes('users')) {
		const usersIdx = parts.indexOf('users');
		const userId = parts[usersIdx + 1] ?? 'unknown';
		const appId = parts[usersIdx + 2] ?? 'unknown';
		return {
			title: `Daily Notes - ${dateStr ?? fileName.replace('.md', '')}`,
			date: dateStr,
			tags: ['pas/daily-note', `pas/${appId}`],
			type: 'daily-note',
			user: userId,
			app: appId,
			source: `pas-${appId}`,
		};
	}

	// data/users/<userId>/echo/log.md
	if (parts.includes('users') && fileName === 'log.md') {
		const usersIdx = parts.indexOf('users');
		const userId = parts[usersIdx + 1] ?? 'unknown';
		const appId = parts[usersIdx + 2] ?? 'unknown';
		return {
			title: `${appId} Log`,
			tags: ['pas/log', `pas/${appId}`],
			type: 'log',
			user: userId,
			app: appId,
			source: `pas-${appId}`,
		};
	}

	return null;
}

/** Recursively find all .md files in a directory. */
async function findMarkdownFiles(dir: string): Promise<string[]> {
	const results: string[] = [];

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const s = await stat(fullPath).catch(() => null);
		if (!s) continue;

		if (s.isDirectory()) {
			const sub = await findMarkdownFiles(fullPath);
			results.push(...sub);
		} else if (s.isFile() && entry.endsWith('.md')) {
			results.push(fullPath);
		}
	}

	return results;
}

/** Run the migration. */
export async function migrate(
	dataDir: string,
	options?: { dryRun?: boolean },
): Promise<MigrationResult> {
	const dryRun = options?.dryRun ?? false;
	const result: MigrationResult = { migrated: 0, skipped: 0, unrecognized: [], errors: [] };

	const files = await findMarkdownFiles(dataDir);

	for (const filePath of files) {
		const fileName = basename(filePath);
		const relPath = relative(dataDir, filePath);

		// Skip non-note files
		if (SKIP_FILES.has(fileName)) {
			result.skipped++;
			continue;
		}

		try {
			const content = await readFile(filePath, 'utf-8');

			// Skip files that already have frontmatter
			if (hasFrontmatter(content)) {
				result.skipped++;
				continue;
			}

			// Determine what frontmatter to add
			const meta = inferFrontmatter(relPath, fileName);
			if (!meta) {
				result.unrecognized.push(relPath);
				continue;
			}

			if (!dryRun) {
				const frontmatter = generateFrontmatter(meta);
				await atomicWrite(filePath, frontmatter + content);
			}
			result.migrated++;
		} catch (err) {
			result.errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return result;
}

// CLI entry point
if (process.argv[1]?.includes('migrate-frontmatter')) {
	const dryRun = process.argv.includes('--dry-run');

	migrate(DATA_DIR, { dryRun }).then((result) => {
		if (result.unrecognized.length > 0) {
			for (const _path of result.unrecognized) {
			}
		}
		if (result.errors.length > 0) {
			for (const _err of result.errors) {
			}
		}
	});
}
