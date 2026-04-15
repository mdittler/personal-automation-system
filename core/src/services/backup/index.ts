/**
 * BackupService — creates timestamped tar.gz archives of data and config directories.
 *
 * Uses the system `tar` command (Unix/macOS only). On Windows, backup is a no-op
 * with a logged warning. Enforces a rolling retention window by deleting the oldest
 * archives after each successful backup.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

export class BackupService {
	constructor(
		private readonly opts: {
			/** Absolute path to data directory. */
			dataDir: string;
			/** Absolute path to config directory. */
			configDir: string;
			/** Absolute path for backup output. */
			backupPath: string;
			/** Number of most-recent backups to keep. */
			retentionCount: number;
			logger: Logger;
		},
	) {}

	/**
	 * Create a new backup archive.
	 *
	 * Returns the absolute path to the created archive, or an empty string on
	 * platforms where backup is unsupported (Windows).
	 */
	async createBackup(): Promise<string> {
		if (process.platform === 'win32') {
			this.opts.logger.warn('Backup not supported on Windows — skipping');
			return '';
		}

		// 1. Ensure backup directory exists
		await mkdir(this.opts.backupPath, { recursive: true });

		// 2. Generate timestamped filename (ISO 8601, colons and dots replaced for FS safety)
		const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const filename = `pas-backup-${ts}.tar.gz`;
		const dest = join(this.opts.backupPath, filename);

		// 3. Create tarball: bundle data dir and config dir using absolute paths
		//    tar -czf <dest> -C <parentOfData> <dataBasename> -C <parentOfConfig> <configBasename>
		await execFileAsync('tar', [
			'-czf',
			dest,
			'-C',
			dirname(this.opts.dataDir),
			basename(this.opts.dataDir),
			'-C',
			dirname(this.opts.configDir),
			basename(this.opts.configDir),
		]);

		// 4. Verify output exists with nonzero size
		const stats = await stat(dest);
		if (stats.size === 0) {
			throw new Error(`Backup created but is empty: ${dest}`);
		}

		// 5. Clean up old backups
		await this.cleanupOldBackups();

		this.opts.logger.info({ dest, bytes: stats.size }, 'Backup completed');
		return dest;
	}

	/**
	 * Delete oldest backup archives beyond the retention window.
	 *
	 * Archives are identified by the `pas-backup-*.tar.gz` naming pattern and
	 * sorted lexicographically (which is chronological given the ISO timestamp prefix).
	 */
	async cleanupOldBackups(): Promise<void> {
		let files: string[];
		try {
			const entries = await readdir(this.opts.backupPath);
			files = entries
				.filter((f) => f.startsWith('pas-backup-') && f.endsWith('.tar.gz'))
				.sort() // lexicographic = chronological due to ISO timestamp format
				.map((f) => join(this.opts.backupPath, f));
		} catch {
			// Directory doesn't exist yet — nothing to clean
			return;
		}

		const toDelete = files.slice(0, Math.max(0, files.length - this.opts.retentionCount));
		for (const f of toDelete) {
			await rm(f, { force: true });
		}
	}
}
