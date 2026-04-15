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
import { getCurrentUserId } from '../context/request-context.js';
import { HouseholdBoundaryError, UserBoundaryError } from '../household/index.js';

/**
 * Private capability token for bypassing the actor-vs-target check in
 * ContextStoreServiceImpl. Only infrastructure call-sites (scheduled jobs
 * under per-user dispatch, test fixtures) may import this symbol.
 *
 * Never export from a barrel or shared utility — referential equality is the
 * capability check.
 */
export const CONTEXT_INTERNAL_BYPASS = Symbol('pas.contextBypass');

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
		.slice(0, 100)
		.replace(/-+$/, '');
}

export interface ContextStoreOptions {
	dataDir: string;
	logger: Logger;
	/**
	 * Optional — when present, routes per-user context to the household layout
	 * (`data/households/<hh>/users/<userId>/context`). When wired and the user
	 * has no household, operations throw HouseholdBoundaryError (fail-closed).
	 * When absent, legacy `data/users/<userId>/context` is used (transitional).
	 */
	householdService?: { getHouseholdForUser(userId: string): string | null };
}

export class ContextStoreServiceImpl implements ContextStoreService {
	private readonly dataDir: string;
	private readonly systemDir: string;
	private readonly usersDir: string;
	private readonly logger: Logger;
	private readonly householdService?: { getHouseholdForUser(userId: string): string | null };

	constructor(options: ContextStoreOptions) {
		this.dataDir = options.dataDir;
		this.systemDir = resolve(join(options.dataDir, 'system', 'context'));
		this.usersDir = resolve(join(options.dataDir, 'users'));
		this.logger = options.logger;
		this.householdService = options.householdService;
	}

	/**
	 * Resolve the per-user context directory, household-aware when wired.
	 *
	 * - householdService wired + user has household → `households/<hh>/users/<u>/context`
	 * - householdService wired + user has no household → throws HouseholdBoundaryError
	 * - householdService absent → legacy `users/<u>/context`
	 */
	private userDir(userId: string): string {
		if (this.householdService) {
			const hh = this.householdService.getHouseholdForUser(userId);
			if (hh === null) {
				throw new HouseholdBoundaryError(
					null,
					null,
					`ContextStore: user "${userId}" has no household assigned`,
				);
			}
			return resolve(join(this.dataDir, 'households', hh, 'users', userId, 'context'));
		}
		return resolve(join(this.usersDir, userId, 'context'));
	}

	/**
	 * Actor-vs-target check. Throws UserBoundaryError when the current request
	 * context has a userId that differs from the target userId.
	 *
	 * Pass `CONTEXT_INTERNAL_BYPASS` as `bypass` to skip the check for
	 * infrastructure call-sites (scheduled jobs, test fixtures).
	 */
	private checkActor(userId: string, bypass?: symbol): void {
		if (bypass === CONTEXT_INTERNAL_BYPASS) return;
		const actorId = getCurrentUserId();
		if (actorId !== undefined && actorId !== userId) {
			throw new UserBoundaryError(actorId, userId);
		}
	}

	async get(key: string): Promise<string | null> {
		return this.readEntry(this.systemDir, key);
	}

	async search(query: string): Promise<ContextEntry[]> {
		return this.searchDir(this.systemDir, query);
	}

	async searchForUser(query: string, userId: string, _bypass?: symbol): Promise<ContextEntry[]> {
		if (!USER_ID_PATTERN.test(userId)) return [];
		this.checkActor(userId, _bypass);

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

	async getForUser(key: string, userId: string, _bypass?: symbol): Promise<string | null> {
		if (!USER_ID_PATTERN.test(userId)) return null;
		this.checkActor(userId, _bypass);

		const userContent = await this.readEntry(this.userDir(userId), key);
		if (userContent !== null) return userContent;
		return this.readEntry(this.systemDir, key);
	}

	async listForUser(userId: string, _bypass?: symbol): Promise<ContextEntry[]> {
		if (!USER_ID_PATTERN.test(userId)) return [];
		this.checkActor(userId, _bypass);
		return this.listDir(this.userDir(userId));
	}

	async save(userId: string, key: string, content: string, _bypass?: symbol): Promise<void> {
		if (!USER_ID_PATTERN.test(userId)) {
			throw new Error('Invalid userId format');
		}
		this.checkActor(userId, _bypass);
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

	async remove(userId: string, key: string, _bypass?: symbol): Promise<void> {
		if (!USER_ID_PATTERN.test(userId)) {
			throw new Error('Invalid userId format');
		}
		this.checkActor(userId, _bypass);
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
