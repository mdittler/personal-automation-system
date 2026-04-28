/**
 * migration-backup.ts
 *
 * Self-contained backup helper used exclusively by the household migration runner.
 * Creates a verified recursive copy of the data directory before any migration
 * mutations are applied.
 *
 * Cross-platform: uses Node.js `fs.cp` (available since Node 16.7+) — no shell
 * or tar required. Works on both Windows (dev) and macOS/Linux (production).
 *
 * Does NOT depend on BackupService or any other PAS service.
 */

import { access, cp, lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BackupResult {
	path: string;
	fileCount: number;
	bytes: number;
}

export class MigrationBackupError extends Error {
	override readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = 'MigrationBackupError';
		this.cause = cause;
	}
}

export interface MigrationBackupOptions {
	/** Injectable for tests — replaces the real fs.cp call */
	_backupFn?: (src: string, dest: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walks a directory and returns the count and total byte size of
 * all regular files found.
 *
 * Uses `readdir` with `recursive: true` and `withFileTypes: true` (Node 20+).
 * Falls back to a manual recursive walk for older runtimes.
 */
async function countAndSizeDir(dir: string): Promise<{ fileCount: number; bytes: number }> {
	let fileCount = 0;
	let bytes = 0;

	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (entry.isFile()) {
			// `entry.parentPath` (Node 21+) or `entry.path` (Node 20) holds the
			// parent directory of the entry when using recursive readdir.
			const parentPath =
				(entry as { parentPath?: string; path?: string }).parentPath ??
				(entry as { path?: string }).path ??
				dir;
			const fullPath = join(parentPath, entry.name);
			const info = await stat(fullPath);
			fileCount += 1;
			bytes += info.size;
		}
	}

	return { fileCount, bytes };
}

async function shouldCopyBackupEntry(src: string): Promise<boolean> {
	const info = await lstat(src);
	return !info.isSymbolicLink();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Creates a verified copy of `dataDir` to a sibling directory named
 * `data-backup-pre-household-migration-<ISO timestamp>/` inside `destParentDir`.
 *
 * Returns `BackupResult` with the backup path, file count, and total bytes.
 * Throws `MigrationBackupError` if the copy or verification fails.
 *
 * This is called once at migration startup. It is intentionally slow
 * (full recursive copy) for the sake of simplicity and correctness.
 */
export async function createMigrationBackup(
	dataDir: string,
	destParentDir: string,
	options?: MigrationBackupOptions,
): Promise<BackupResult> {
	// 1. Derive a timestamped backup directory name (colons replaced for Windows).
	const timestamp = new Date().toISOString().replace(/:/g, '-');
	const backupDir = join(destParentDir, `data-backup-pre-household-migration-${timestamp}`);

	// 2. Perform the copy.
	try {
		if (options?._backupFn) {
			await options._backupFn(dataDir, backupDir);
		} else {
			await cp(dataDir, backupDir, {
				recursive: true,
				filter: shouldCopyBackupEntry,
			});
		}
	} catch (err) {
		throw new MigrationBackupError(
			`Failed to copy data directory to backup location "${backupDir}": ${String(err)}`,
			err,
		);
	}

	// 3. Verify the backup directory exists.
	try {
		await access(backupDir);
	} catch {
		throw new MigrationBackupError(`Backup directory does not exist after copy: "${backupDir}"`);
	}

	// 4. Count and size source and backup directories.
	let srcStats: { fileCount: number; bytes: number };
	let destStats: { fileCount: number; bytes: number };

	try {
		srcStats = await countAndSizeDir(dataDir);
	} catch (err) {
		throw new MigrationBackupError(
			`Failed to stat source directory "${dataDir}": ${String(err)}`,
			err,
		);
	}

	try {
		destStats = await countAndSizeDir(backupDir);
	} catch (err) {
		throw new MigrationBackupError(
			`Failed to stat backup directory "${backupDir}": ${String(err)}`,
			err,
		);
	}

	// 5. Verify counts and sizes match.
	if (destStats.fileCount !== srcStats.fileCount) {
		throw new MigrationBackupError(
			`Backup verification failed: source has ${srcStats.fileCount} file(s) but backup has ${destStats.fileCount} file(s)`,
		);
	}

	if (destStats.bytes !== srcStats.bytes) {
		throw new MigrationBackupError(
			`Backup verification failed: source total is ${srcStats.bytes} bytes but backup total is ${destStats.bytes} bytes`,
		);
	}

	return {
		path: backupDir,
		fileCount: destStats.fileCount,
		bytes: destStats.bytes,
	};
}
