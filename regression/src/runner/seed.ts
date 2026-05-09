// regression/src/runner/seed.ts
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
	const failures: FixtureFailure[] = [];

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

		const fullPath = join(baseDir, normalized);
		let buf: Buffer;
		try {
			buf = await readFile(fullPath);
		} catch {
			failures.push({ path: fullPath, reason: 'missing' });
			continue;
		}
		const actualHash = createHash('sha256').update(buf).digest('hex');
		if (actualHash !== expectedHash) {
			failures.push({
				path: fullPath,
				reason: 'mismatch',
				expected: expectedHash,
				actual: actualHash,
			});
		}
	}

	return { ok: failures.length === 0, failures };
}
