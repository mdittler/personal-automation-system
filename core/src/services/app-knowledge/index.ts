/**
 * App knowledge base service.
 *
 * Indexes help files from app directories (help.md, docs/*.md) and
 * infrastructure docs from core/docs/help/. Provides keyword search
 * with per-user app enable/disable filtering.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { AppKnowledgeBaseService, KnowledgeEntry } from '../../types/app-knowledge.js';
import type { SystemConfig } from '../../types/config.js';
import type { AppRegistry } from '../app-registry/index.js';
import type { AppToggleStore } from '../app-toggle/index.js';

/** Max entries returned from a single search. */
const MAX_RESULTS = 5;

/** Max content length per entry (chars). Prevents prompt bloat. */
const MAX_CONTENT_LENGTH = 2000;

/** Infrastructure app ID for core docs. */
const INFRA_APP_ID = 'infrastructure';

export interface AppKnowledgeBaseOptions {
	registry: AppRegistry;
	appToggle: AppToggleStore;
	config: SystemConfig;
	infraDocsDir: string;
	logger: Logger;
}

/**
 * Inputs for the module-level `loadIndexedEntries` helper. Mirrors the slice of
 * `AppKnowledgeBaseOptions` required to produce the truncated knowledge
 * entries the chatbot's runtime search sees. Extracted from
 * `AppKnowledgeBase.init()` so the doc-coverage gate (Batch 1F) and any
 * future caller can exercise exactly the same indexing pipeline without
 * instantiating the full service.
 */
export interface LoadIndexedEntriesOptions {
	/** Absolute path to `core/docs/help/`. */
	infraDocsDir: string;
	/** App descriptors to index. Mirrors `AppRegistry.getAll()` shape. */
	apps: Array<{ appId: string; appDir: string }>;
	/** Optional logger; only `warn` is consumed for read failures. */
	logger?: Pick<Logger, 'warn'>;
}

/**
 * Loads infrastructure docs + every app's `help.md` and `docs/*.md`, applying
 * the same `MAX_CONTENT_LENGTH` truncation as `AppKnowledgeBase`. Shared with
 * the doc-coverage test so the gate validates against the same indexed content
 * the runtime search sees.
 */
export async function loadIndexedEntries(
	opts: LoadIndexedEntriesOptions,
): Promise<KnowledgeEntry[]> {
	const [infraEntries, perApp] = await Promise.all([
		loadDocsFromDir(INFRA_APP_ID, opts.infraDocsDir, opts.logger),
		Promise.all(
			opts.apps.map(async (app) => {
				const [helpEntry, docsEntries] = await Promise.all([
					loadSingleFile(app.appId, join(app.appDir, 'help.md'), 'help.md', opts.logger),
					loadDocsFromDir(app.appId, join(app.appDir, 'docs'), opts.logger),
				]);
				return helpEntry ? [helpEntry, ...docsEntries] : docsEntries;
			}),
		),
	]);

	return [...infraEntries, ...perApp.flat()];
}

export class AppKnowledgeBase implements AppKnowledgeBaseService {
	private readonly registry: AppRegistry;
	private readonly appToggle: AppToggleStore;
	private readonly config: SystemConfig;
	private readonly infraDocsDir: string;
	private readonly logger: Logger;
	private entries: KnowledgeEntry[] = [];

	constructor(options: AppKnowledgeBaseOptions) {
		this.registry = options.registry;
		this.appToggle = options.appToggle;
		this.config = options.config;
		this.infraDocsDir = resolve(options.infraDocsDir);
		this.logger = options.logger;
	}

	/**
	 * Index all app docs and infrastructure docs.
	 * Call after registry.loadAll() so all app dirs are known.
	 */
	async init(): Promise<void> {
		const apps = this.registry.getAll().map((app) => ({
			appId: app.manifest.app.id,
			appDir: app.appDir,
		}));

		const entries = await loadIndexedEntries({
			infraDocsDir: this.infraDocsDir,
			apps,
			logger: this.logger,
		});

		// Recompute the infra count from the loaded entries so the log line
		// preserves the original observable behavior.
		const infraCount = entries.filter((e) => e.appId === INFRA_APP_ID).length;

		this.entries = entries;
		this.logger.info({ count: entries.length, infra: infraCount }, 'App knowledge base indexed');
	}

	/** Snapshot of indexed entries — the truncated content the runtime search uses. */
	public getEntries(): ReadonlyArray<KnowledgeEntry> {
		return this.entries;
	}

	async search(query: string, userId?: string): Promise<KnowledgeEntry[]> {
		if (!query.trim()) return [];

		const lowerQuery = query.toLowerCase();
		const words = lowerQuery.split(/\s+/).filter((w) => w.length > 2);
		if (words.length === 0) return [];

		// Score entries by keyword match count
		const scored: Array<{ entry: KnowledgeEntry; score: number }> = [];

		for (const entry of this.entries) {
			// Filter by enabled apps when userId provided
			if (userId && entry.appId !== INFRA_APP_ID) {
				const user = this.config.users.find((u) => u.id === userId);
				const defaultEnabled = user?.enabledApps ?? [];
				const enabled = await this.appToggle.isEnabled(userId, entry.appId, defaultEnabled);
				if (!enabled) continue;
			}

			const lowerContent = entry.content.toLowerCase();
			const lowerSource = entry.source.toLowerCase();
			let score = 0;

			for (const word of words) {
				if (lowerContent.includes(word)) score++;
				if (lowerSource.includes(word)) score += 0.5;
			}

			if (score > 0) {
				scored.push({ entry, score });
			}
		}

		// Sort by score descending, take top N
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, MAX_RESULTS).map((s) => s.entry);
	}
}

/** Load all .md files from a directory (module-level for reuse by tests). */
async function loadDocsFromDir(
	appId: string,
	dir: string,
	logger?: Pick<Logger, 'warn'>,
): Promise<KnowledgeEntry[]> {
	const entries: KnowledgeEntry[] = [];

	let files: string[];
	try {
		files = await readdir(dir);
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') return [];
		logger?.warn({ dir, error }, 'Failed to read docs directory');
		return [];
	}

	for (const file of files) {
		if (!file.endsWith('.md')) continue;

		const filePath = join(dir, file);

		// Skip directories
		try {
			const fileStat = await stat(filePath);
			if (!fileStat.isFile()) continue;
		} catch {
			continue;
		}

		const entry = await loadSingleFile(appId, filePath, file, logger);
		if (entry) entries.push(entry);
	}

	return entries;
}

/** Load and truncate a single markdown file (module-level for reuse by tests). */
async function loadSingleFile(
	appId: string,
	filePath: string,
	source: string,
	logger?: Pick<Logger, 'warn'>,
): Promise<KnowledgeEntry | null> {
	try {
		let content = await readFile(filePath, 'utf-8');
		if (content.length > MAX_CONTENT_LENGTH) {
			content = content.slice(0, MAX_CONTENT_LENGTH);
		}
		return { appId, source, content };
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') return null;
		logger?.warn({ appId, filePath, error }, 'Failed to read knowledge base file');
		return null;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
