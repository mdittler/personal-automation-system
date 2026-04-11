/**
 * Context store service.
 *
 * Two-tier markdown knowledge base:
 * - Per-user: data/users/<userId>/context/
 * - System-wide: data/system/context/
 *
 * Per-user entries take priority when keys collide.
 */

import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type { ContextEntry, ContextStoreService } from '../../types/context-store.js';
import { atomicWrite } from '../../utils/file.js';

const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Common English stop words filtered from search queries. */
const STOP_WORDS = new Set([
	'a',
	'an',
	'the',
	'is',
	'are',
	'was',
	'were',
	'am',
	'be',
	'been',
	'being',
	'do',
	'does',
	'did',
	'doing',
	'have',
	'has',
	'had',
	'having',
	'will',
	'would',
	'shall',
	'should',
	'may',
	'might',
	'can',
	'could',
	'must',
	'i',
	'me',
	'my',
	'we',
	'our',
	'you',
	'your',
	'he',
	'she',
	'it',
	'they',
	'them',
	'their',
	'its',
	'what',
	'which',
	'who',
	'whom',
	'this',
	'that',
	'these',
	'those',
	'in',
	'on',
	'at',
	'to',
	'for',
	'of',
	'with',
	'by',
	'from',
	'about',
	'like',
	'how',
	'when',
	'where',
	'why',
	'not',
	'no',
	'nor',
	'so',
	'if',
	'or',
	'and',
	'but',
	'up',
	'out',
	'off',
	'over',
	'under',
	'again',
	'then',
	'just',
	'also',
	'very',
	'too',
	'really',
	'much',
]);

/**
 * Extract meaningful keywords from text, filtering stop words and short tokens.
 */
export function extractKeywords(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Convert a human-readable name to a filesystem-safe slug.
 * "Food Preferences" → "food-preferences"
 * "My Doctor's Notes!" → "my-doctors-notes"
 */
export function slugifyKey(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 100);
}

export interface ContextStoreOptions {
	dataDir: string;
	logger: Logger;
}

export class ContextStoreServiceImpl implements ContextStoreService {
	private readonly systemDir: string;
	private readonly usersDir: string;
	private readonly logger: Logger;

	constructor(options: ContextStoreOptions) {
		this.systemDir = resolve(join(options.dataDir, 'system', 'context'));
		this.usersDir = resolve(join(options.dataDir, 'users'));
		this.logger = options.logger;
	}

	private userDir(userId: string): string {
		return resolve(join(this.usersDir, userId, 'context'));
	}

	async get(key: string): Promise<string | null> {
		return this.readEntry(this.systemDir, key);
	}

	async search(query: string): Promise<ContextEntry[]> {
		return this.searchDir(this.systemDir, query);
	}

	async searchForUser(query: string, userId: string): Promise<ContextEntry[]> {
		if (!USER_ID_PATTERN.test(userId)) return [];

		const userEntries = await this.searchDir(this.userDir(userId), query);
		const systemEntries = await this.searchDir(this.systemDir, query);

		// Dedup: user entries win over system entries with same key
		const seen = new Set(userEntries.map((e) => e.key));
		const merged = [...userEntries];
		for (const entry of systemEntries) {
			if (!seen.has(entry.key)) {
				merged.push(entry);
			}
		}
		return merged;
	}

	async getForUser(key: string, userId: string): Promise<string | null> {
		if (!USER_ID_PATTERN.test(userId)) return null;

		const userContent = await this.readEntry(this.userDir(userId), key);
		if (userContent !== null) return userContent;
		return this.readEntry(this.systemDir, key);
	}

	async listForUser(userId: string): Promise<ContextEntry[]> {
		if (!USER_ID_PATTERN.test(userId)) return [];
		return this.listDir(this.userDir(userId));
	}

	async save(userId: string, key: string, content: string): Promise<void> {
		if (!USER_ID_PATTERN.test(userId)) {
			throw new Error('Invalid userId format');
		}
		const slug = slugifyKey(key);
		if (!slug || !SLUG_PATTERN.test(slug)) {
			throw new Error('Invalid name — must contain at least one letter or number');
		}

		const dir = this.userDir(userId);
		await mkdir(dir, { recursive: true });

		const filePath = resolve(join(dir, `${slug}.md`));
		// Unreachable given SLUG_PATTERN validation above; retained as defence-in-depth
		const rel = relative(dir, filePath);
		if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
			throw new Error('Path traversal detected');
		}

		await atomicWrite(filePath, content);
		this.logger.info({ userId, key: slug }, 'Context entry saved');
	}

	async remove(userId: string, key: string): Promise<void> {
		if (!USER_ID_PATTERN.test(userId)) {
			throw new Error('Invalid userId format');
		}
		const slug = slugifyKey(key);
		if (!slug || !SLUG_PATTERN.test(slug)) {
			throw new Error('Invalid name');
		}

		const dir = this.userDir(userId);
		const filePath = resolve(join(dir, `${slug}.md`));
		// Unreachable given SLUG_PATTERN validation above; retained as defence-in-depth
		const rel = relative(dir, filePath);
		if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
			throw new Error('Path traversal detected');
		}

		try {
			await unlink(filePath);
			this.logger.info({ userId, key }, 'Context entry removed');
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return; // Already gone
			}
			throw error;
		}
	}

	// --- Private helpers ---

	private async readEntry(dir: string, key: string): Promise<string | null> {
		const slug = slugifyKey(key);
		if (!slug || !SLUG_PATTERN.test(slug)) {
			this.logger.warn({ key }, 'Context store key failed slug validation');
			return null;
		}

		const filePath = resolve(join(dir, `${slug}.md`));
		// Unreachable given SLUG_PATTERN validation above; retained as defence-in-depth
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

	private async searchDir(dir: string, query: string): Promise<ContextEntry[]> {
		const queryWords = extractKeywords(query);
		if (queryWords.length === 0) return [];

		const scored: Array<ContextEntry & { _score: number }> = [];

		let files: string[];
		try {
			files = await readdir(dir);
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return [];
			}
			this.logger.error({ error, dir }, 'Failed to read context directory');
			return [];
		}

		for (const file of files) {
			if (!file.endsWith('.md')) continue;

			const filePath = join(dir, file);
			try {
				const content = await readFile(filePath, 'utf-8');
				const key = file.slice(0, -3);

				// Search both file content and filename/key
				const searchable = `${key.replace(/-/g, ' ')} ${content}`.toLowerCase();
				const matchCount = queryWords.filter((w) => searchable.includes(w)).length;

				if (matchCount > 0) {
					const fileStat = await stat(filePath);
					scored.push({
						key,
						content,
						lastUpdated: fileStat.mtime,
						_score: matchCount,
					});
				}
			} catch (error) {
				this.logger.warn({ file, error }, 'Failed to read context file during search');
			}
		}

		// Sort by relevance (most matching words first)
		scored.sort((a, b) => b._score - a._score);
		return scored.map(({ _score, ...entry }) => entry);
	}

	private async listDir(dir: string): Promise<ContextEntry[]> {
		const results: ContextEntry[] = [];

		let files: string[];
		try {
			files = await readdir(dir);
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return [];
			}
			this.logger.error({ error, dir }, 'Failed to list context directory');
			return [];
		}

		for (const file of files) {
			if (!file.endsWith('.md')) continue;

			const filePath = join(dir, file);
			try {
				const content = await readFile(filePath, 'utf-8');
				const fileStat = await stat(filePath);
				results.push({
					key: file.slice(0, -3),
					content,
					lastUpdated: fileStat.mtime,
				});
			} catch (error) {
				this.logger.warn({ file, error }, 'Failed to read context file during list');
			}
		}

		return results;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
