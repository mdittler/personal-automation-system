/**
 * File system utilities.
 *
 * Provides atomic writes (temp + rename) and directory helpers.
 * All file operations in PAS should go through these for consistency.
 */

import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { appendFile as fsAppend, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
 * Uses O_EXCL for atomic create-or-append — no TOCTOU race.
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

	try {
		// O_WRONLY | O_CREAT | O_EXCL — atomically fails if file exists
		const handle = await open(filePath, 'wx');
		try {
			await handle.writeFile(frontmatter + content, 'utf-8');
		} finally {
			await handle.close();
		}
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
			// File already exists — just append (no frontmatter)
			await fsAppend(filePath, content, 'utf-8');
		} else {
			throw err;
		}
	}
}
