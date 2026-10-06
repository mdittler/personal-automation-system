/**
 * `--archive-cache` (REQ-REG-027). Moves the whole cache directory to
 * `<cacheDir>-archive/<ISO-stamp>/` and recreates an empty cache dir.
 * PAS never deletes history; archiving keeps old grades inspectable while
 * guaranteeing the GUI cannot surface them as current results.
 */
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function archiveCache(cacheDir: string, now: Date): Promise<string | null> {
	if (!existsSync(cacheDir)) return null;
	const stamp = now.toISOString().replace(/[:.]/g, '-');
	const dest = join(dirname(cacheDir), `${basename(cacheDir)}-archive`, stamp);
	await mkdir(dirname(dest), { recursive: true });
	await rename(cacheDir, dest);
	await mkdir(cacheDir, { recursive: true });
	return dest;
}
