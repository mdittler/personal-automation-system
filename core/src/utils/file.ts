/**
 * File system utilities.
 *
 * Provides atomic writes (temp + rename) and directory helpers.
 * All file operations in PAS should go through these for consistency.
 */

import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { appendFile as fsAppend, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { withFileLock } from './file-mutex.js';

/**
 * Ensure a directory exists, creating it and any parents if needed.
 */
export async function ensureDir(dirPath: string): Promise<void> {
	await mkdir(dirPath, { recursive: true });
}

/**
 * Write a file atomically: write to a temp file first, then rename.
 * This prevents partial reads of in-progress writes.
 *
 * On Windows, rename() can fail with EPERM/EACCES when another
 * process has the target file open. Retries with short delays
 * handle this race condition.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
	const dir = dirname(filePath);
	await ensureDir(dir);

	const tmpSuffix = randomBytes(6).toString('hex');
	const tmpPath = join(dir, `.tmp-${tmpSuffix}`);

	await writeFile(tmpPath, content, 'utf-8');

	// Retry rename on Windows EPERM/EACCES (concurrent file access)
	const maxRetries = process.platform === 'win32' ? 3 : 0;
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmpPath, filePath);
			return;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (attempt < maxRetries && (code === 'EPERM' || code === 'EACCES')) {
				await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
				continue;
			}
			throw err;
		}
	}
}

/**
 * Append content to a file, prepending frontmatter only if the file is newly created.
 *
 * Concurrency: serialized via the in-process FileMutex keyed on the absolute
 * path. PAS is a single-process deployment, so the mutex is sufficient to
 * prevent the create-vs-append race. Within the lock we use a stat-then-write
 * pattern: if the file is missing we write `frontmatter + content` in one
 * `writeFile` call; otherwise we append `content` only.
 *
 * Why not the previous `wx`-open + EEXIST-fallback dance? Because there is a
 * window between `open(..., 'wx')` succeeding and `writeFile` finishing where
 * a concurrent caller's `wx` open fails with EEXIST and falls into the append
 * branch — appending raw content to a still-empty file BEFORE the frontmatter
 * is written. The mutex closes that window deterministically.
 *
 * @param filePath - The file to append to.
 * @param content - The content to append.
 * @param frontmatter - YAML frontmatter block (including delimiters) to prepend on file creation.
 */
export async function appendWithFrontmatter(
	filePath: string,
	content: string,
	frontmatter: string,
): Promise<void> {
	await ensureDir(dirname(filePath));

	// Canonicalize the mutex key so two callers passing equivalent path
	// spellings (e.g. ./x.md and /abs/x.md, or paths through symlinks)
	// share the same lock. After ensureDir the parent directory always
	// exists, so realpath(dirname) cannot ENOENT under normal conditions.
	// Fall back to resolve() if realpath unexpectedly throws.
	let lockKey: string;
	try {
		lockKey = join(await realpath(dirname(filePath)), basename(filePath));
	} catch {
		lockKey = resolve(filePath);
	}

	await withFileLock(lockKey, async () => {
		let exists = true;
		try {
			await stat(filePath);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				exists = false;
			} else {
				throw err;
			}
		}

		if (!exists) {
			await writeFile(filePath, frontmatter + content, 'utf-8');
		} else {
			await fsAppend(filePath, content, 'utf-8');
		}
	});
}
