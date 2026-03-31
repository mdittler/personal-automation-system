/**
 * Change log for data store operations.
 *
 * Tracks all file modifications with timestamps, operation type, paths,
 * app ID, and user ID. Written as JSONL (one JSON object per line) to
 * data/system/change-log.jsonl.
 *
 * Used by the daily diff (Phase 7) to generate summaries (URS-DIFF-003).
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeLogEntry } from '../../types/data-store.js';
import { toISO } from '../../utils/date.js';
import { ensureDir } from '../../utils/file.js';

export type ChangeOperation = 'read' | 'write' | 'append' | 'archive';

export class ChangeLog {
	private readonly logPath: string;
	private initialized = false;

	constructor(private readonly dataDir: string) {
		this.logPath = join(dataDir, 'system', 'change-log.jsonl');
	}

	/**
	 * Record a data store operation in the change log.
	 */
	async record(
		operation: ChangeOperation,
		filePath: string,
		appId: string,
		userId: string | null,
		spaceId?: string,
	): Promise<void> {
		if (!this.initialized) {
			await ensureDir(join(this.dataDir, 'system'));
			this.initialized = true;
		}

		const entry: ChangeLogEntry = {
			timestamp: toISO(),
			operation,
			path: filePath,
			appId,
			userId: userId ?? 'system',
		};

		if (spaceId) {
			entry.spaceId = spaceId;
		}

		const line = `${JSON.stringify(entry)}\n`;
		await appendFile(this.logPath, line, 'utf-8');
	}

	/**
	 * Get the path to the change log file (for use by daily diff).
	 */
	getLogPath(): string {
		return this.logPath;
	}
}
