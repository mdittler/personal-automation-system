import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, posix, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HashOptions {
	repoRoot: string;
}

function assertRepoRelative(repoRel: string): string {
	if (isAbsolute(repoRel)) throw new Error(`Path must be repo-relative, got absolute: ${repoRel}`);
	// Reject any '..' segment in the *raw* input (before normalize() collapses them).
	// `apps/food/../sneaky.ts` normalizes to `apps/sneaky.ts` but is a traversal attempt.
	const rawSegmentsPosix = repoRel.split(/[/\\]/);
	if (rawSegmentsPosix.includes('..')) {
		throw new Error(`Path traverses outside repo root: ${repoRel}`);
	}
	const norm = normalize(repoRel);
	if (norm.startsWith('..') || norm.split(sep).includes('..')) {
		throw new Error(`Path traverses outside repo root: ${repoRel}`);
	}
	return norm.split(sep).join(posix.sep);
}

/**
 * Returns 40-hex git blob hash for tracked-and-clean files,
 * or 64-hex SHA-256 of file contents otherwise.
 * Distinct lengths let callers tell the source apart for diagnostics.
 */
export async function hashRepoRelative(repoRel: string, opts: HashOptions): Promise<string> {
	const safe = assertRepoRelative(repoRel);

	// Probe: is file tracked AND clean?
	let tracked = false;
	try {
		await execFileAsync('git', ['ls-files', '--error-unmatch', '--', safe], { cwd: opts.repoRoot });
		tracked = true;
	} catch {
		tracked = false;
	}

	if (tracked) {
		const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', safe], {
			cwd: opts.repoRoot,
		});
		const isDirty = stdout.trim().length > 0;
		if (!isDirty) {
			const { stdout: hashOut } = await execFileAsync('git', ['hash-object', '--', safe], {
				cwd: opts.repoRoot,
			});
			return hashOut.trim();
		}
	}

	const absPath = join(opts.repoRoot, safe);
	const buf = await readFile(absPath); // throws ENOENT if missing
	return createHash('sha256').update(buf).digest('hex');
}
