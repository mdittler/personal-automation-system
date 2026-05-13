/**
 * Atomic JSON write helper — shared by the regression `CacheStore`, the
 * regression `RunManifest` writer, and the GUI weakness-summarizer.
 *
 * Pattern: mkdir -p; write to a unique temp path; rename to final path.
 * `rename` within the same filesystem is atomic on POSIX; readers either
 * see the previous file or the new one, never a torn write.
 *
 * REQ-REG-GUI-V2-002.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
	/** JSON.stringify spacing (default 2 for human-readable manifests/cache). */
	indent?: number;
}

/**
 * Atomically write a JSON-serializable value to `path`. The parent directory
 * is created if missing. The temp file is unique per process+nonce so
 * concurrent writers do not collide.
 */
export async function atomicWriteJson(
	path: string,
	value: unknown,
	opts: AtomicWriteOptions = {},
): Promise<void> {
	const indent = opts.indent ?? 2;
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
	await writeFile(tmpPath, JSON.stringify(value, null, indent));
	await rename(tmpPath, path);
}
