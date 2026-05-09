import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export interface FixtureFailure {
	path: string;
	reason: 'mismatch' | 'missing';
	expected?: string;
	actual?: string;
}

export interface FixtureCheckResult {
	ok: boolean;
	failures: FixtureFailure[];
}

const MANIFEST_LINE_RE = /^([0-9a-f]{64})\s+(.+)$/i;

/**
 * REQ-REG-006 — verify SHA-256 manifest before any chatbot/receipt run.
 * Manifest format (one per line): "<64-hex-sha256>  <relative-path>"
 * Rejects path traversal and absolute paths defensively.
 */
export async function verifyFixtureIntegrity(manifestPath: string): Promise<FixtureCheckResult> {
	const manifestText = await readFile(manifestPath, 'utf8');
	const baseDir = dirname(manifestPath);

	// Phase 1: parse + validate paths (synchronous, fail-fast on traversal/absolute)
	const entries: Array<{ relPath: string; fullPath: string; expectedHash: string }> = [];
	for (const rawLine of manifestText.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const m = MANIFEST_LINE_RE.exec(line);
		if (!m || m[1] === undefined || m[2] === undefined) {
			throw new Error(`Malformed manifest line: ${line}`);
		}
		const expectedHash = m[1].toLowerCase();
		const relPath = m[2];
		if (isAbsolute(relPath)) {
			throw new Error(`Manifest path must be relative, got absolute: ${relPath}`);
		}
		const normalized = normalize(relPath);
		if (normalized.startsWith('..') || normalized.split('/').includes('..')) {
			throw new Error(`Manifest path traversal rejected: ${relPath}`);
		}
		entries.push({ relPath: normalized, fullPath: join(baseDir, normalized), expectedHash });
	}

	// Phase 2: hash + compare (parallel I/O)
	const results = await Promise.all(
		entries.map(async (e): Promise<FixtureFailure | null> => {
			try {
				const buf = await readFile(e.fullPath);
				const actualHash = createHash('sha256').update(buf).digest('hex');
				if (actualHash !== e.expectedHash) {
					return {
						path: e.relPath,
						reason: 'mismatch',
						expected: e.expectedHash,
						actual: actualHash,
					};
				}
				return null;
			} catch {
				return { path: e.relPath, reason: 'missing' };
			}
		}),
	);
	const failures = results.filter((r): r is FixtureFailure => r !== null);
	return { ok: failures.length === 0, failures };
}
