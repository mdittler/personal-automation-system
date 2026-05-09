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
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// git binary missing → propagate (don't silently treat as untracked)
		if (code === 'ENOENT') throw new Error(`git binary not available: ${(err as Error).message}`);
		// Node child_process error has `code` set to either an errno string OR an exit code number.
		// Exit code 1 = "file not in index" — treat as untracked. Anything else (e.g. 128 for
		// "not a git repository") is unexpected and should be rethrown rather than masked.
		if (typeof code === 'number' && code !== 1) throw err;
		tracked = false;
	}

	if (tracked) {
		const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', safe], {
			cwd: opts.repoRoot,
		});
		const isDirty = stdout.trim().length > 0;
		if (!isDirty) {
			// --no-filters makes the hash content-only, ignoring core.autocrlf and other
			// clean filters. Important for cache portability across contributor machines.
			const { stdout: hashOut } = await execFileAsync(
				'git',
				['hash-object', '--no-filters', '--', safe],
				{ cwd: opts.repoRoot },
			);
			return hashOut.trim();
		}
	}

	const absPath = join(opts.repoRoot, safe);
	const buf = await readFile(absPath); // throws ENOENT if missing
	return createHash('sha256').update(buf).digest('hex');
}
