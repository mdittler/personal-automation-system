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
		const entries: KnowledgeEntry[] = [];

		// Load infrastructure docs
		const infraEntries = await this.loadDocsFromDir(INFRA_APP_ID, this.infraDocsDir);
		entries.push(...infraEntries);

		// Load per-app docs
		for (const app of this.registry.getAll()) {
			const appDir = app.appDir;
			const appId = app.manifest.app.id;

			// Check for help.md
			const helpPath = join(appDir, 'help.md');
			const helpEntry = await this.loadSingleFile(appId, helpPath, 'help.md');
			if (helpEntry) entries.push(helpEntry);

			// Check for docs/*.md
			const docsDir = join(appDir, 'docs');
			const docEntries = await this.loadDocsFromDir(appId, docsDir);
			entries.push(...docEntries);
		}

		this.entries = entries;
		this.logger.info(
			{ count: entries.length, infra: infraEntries.length },
			'App knowledge base indexed',
		);
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

	/** Load all .md files from a directory. */
	private async loadDocsFromDir(appId: string, dir: string): Promise<KnowledgeEntry[]> {
		const entries: KnowledgeEntry[] = [];

		let files: string[];
		try {
			files = await readdir(dir);
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') return [];
			this.logger.warn({ dir, error }, 'Failed to read docs directory');
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

			const entry = await this.loadSingleFile(appId, filePath, file);
			if (entry) entries.push(entry);
		}

		return entries;
	}

	/** Load and truncate a single markdown file. */
	private async loadSingleFile(
		appId: string,
		filePath: string,
		source: string,
	): Promise<KnowledgeEntry | null> {
		try {
			let content = await readFile(filePath, 'utf-8');
			if (content.length > MAX_CONTENT_LENGTH) {
				content = content.slice(0, MAX_CONTENT_LENGTH);
			}
			return { appId, source, content };
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') return null;
			this.logger.warn({ appId, filePath, error }, 'Failed to read knowledge base file');
			return null;
		}
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
