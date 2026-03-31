/**
 * Scoped data store implementation.
 *
 * Provides file-based data access scoped to a specific base directory
 * (user/<userId>/<appId>/ or shared/<appId>/). All operations enforce
 * path traversal protection and log to the change log.
 */

import { appendFile as fsAppend, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataChangedPayload } from '../../types/data-events.js';
import type { ScopedDataStore } from '../../types/data-store.js';
import type { EventBusService } from '../../types/events.js';
import { toArchiveTimestamp } from '../../utils/date.js';
import { appendWithFrontmatter, atomicWrite, ensureDir } from '../../utils/file.js';
import type { ChangeLog } from './change-log.js';
import { resolveScopedPath } from './paths.js';

export interface ScopedStoreOptions {
	/** Absolute path to the base directory for this scope. */
	baseDir: string;
	/** App ID for change log attribution. */
	appId: string;
	/** User ID for change log attribution (null for shared scope). */
	userId: string | null;
	/** Change log instance for recording operations. */
	changeLog: ChangeLog;
	/** Space ID for change log attribution (set for space-scoped stores). */
	spaceId?: string;
	/** Event bus for emitting data:changed events (optional). */
	eventBus?: EventBusService;
}

export class ScopedStore implements ScopedDataStore {
	private readonly baseDir: string;
	private readonly appId: string;
	private readonly userId: string | null;
	private readonly changeLog: ChangeLog;
	private readonly spaceId?: string;
	private readonly eventBus?: EventBusService;

	constructor(options: ScopedStoreOptions) {
		this.baseDir = options.baseDir;
		this.appId = options.appId;
		this.userId = options.userId;
		this.changeLog = options.changeLog;
		this.spaceId = options.spaceId;
		this.eventBus = options.eventBus;
	}

	/** Emit a data:changed event (fire-and-forget). */
	private emitDataChanged(operation: DataChangedPayload['operation'], path: string): void {
		if (!this.eventBus) return;
		try {
			const payload: DataChangedPayload = {
				operation,
				appId: this.appId,
				userId: this.userId,
				path,
			};
			if (this.spaceId) {
				payload.spaceId = this.spaceId;
			}
			this.eventBus.emit('data:changed', payload);
		} catch {
			// Fire-and-forget: subscriber errors must not break data writes
		}
	}

	async read(path: string): Promise<string> {
		const fullPath = resolveScopedPath(this.baseDir, path);

		const fileExists = await stat(fullPath)
			.then((s) => s.isFile())
			.catch(() => false);

		if (!fileExists) return '';

		const content = await readFile(fullPath, 'utf-8');
		await this.changeLog.record('read', path, this.appId, this.userId, this.spaceId);
		return content;
	}

	async write(path: string, content: string): Promise<void> {
		const fullPath = resolveScopedPath(this.baseDir, path);
		await atomicWrite(fullPath, content);
		await this.changeLog.record('write', path, this.appId, this.userId, this.spaceId);
		this.emitDataChanged('write', path);
	}

	async append(path: string, content: string, options?: { frontmatter?: string }): Promise<void> {
		const fullPath = resolveScopedPath(this.baseDir, path);
		await ensureDir(join(fullPath, '..'));

		if (options?.frontmatter) {
			// Race-free: O_EXCL creates with frontmatter, EEXIST falls back to plain append
			await appendWithFrontmatter(fullPath, content, options.frontmatter);
		} else {
			// appendFile with default flags (O_WRONLY | O_CREAT | O_APPEND) creates
			// the file if missing and appends if it exists — no TOCTOU race.
			await fsAppend(fullPath, content, 'utf-8');
		}

		await this.changeLog.record('append', path, this.appId, this.userId, this.spaceId);
		this.emitDataChanged('append', path);
	}

	async exists(path: string): Promise<boolean> {
		const fullPath = resolveScopedPath(this.baseDir, path);

		return stat(fullPath)
			.then((s) => s.isFile() || s.isDirectory())
			.catch(() => false);
	}

	async list(directory: string): Promise<string[]> {
		const fullPath = resolveScopedPath(this.baseDir, directory);

		const dirExists = await stat(fullPath)
			.then((s) => s.isDirectory())
			.catch(() => false);

		if (!dirExists) return [];

		const entries = await readdir(fullPath);
		return entries.sort();
	}

	async archive(path: string): Promise<void> {
		const fullPath = resolveScopedPath(this.baseDir, path);

		const fileExists = await stat(fullPath)
			.then((s) => s.isFile())
			.catch(() => false);

		if (!fileExists) return;

		// Move to archive: same directory, append timestamp before extension
		const timestamp = toArchiveTimestamp();
		const dotIndex = path.lastIndexOf('.');
		const archivePath =
			dotIndex > 0
				? `${path.slice(0, dotIndex)}.${timestamp}${path.slice(dotIndex)}`
				: `${path}.${timestamp}`;

		const archiveFullPath = resolveScopedPath(this.baseDir, archivePath);
		await ensureDir(join(archiveFullPath, '..'));
		await rename(fullPath, archiveFullPath);

		await this.changeLog.record('archive', path, this.appId, this.userId, this.spaceId);
		this.emitDataChanged('archive', path);
	}
}
