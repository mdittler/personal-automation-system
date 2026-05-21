/**
 * cache-reader tests (Codex C2 + I5).
 *
 * C2: latest-by-timestamp selection is wrong when a newer stale entry
 * exists alongside an older entry that matches `currentCacheKey`.
 * `readDisplayForCase` must FIRST look for the current-key match, then
 * fall back to newest-with-coverageChanged.
 *
 * I5: cache validation mirrors `CacheStore`'s strict shape check —
 * negative cost, unknown verdict, missing fields are SKIPPED with
 * warning, never normalized into UI state.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../../../types/regression.js';
import { VERDICT } from '../../../../types/regression.js';
import { readDisplayForCase, readHistoryForCase } from '../cache-reader.js';

let cacheDir: string;

function makeResult(
	overrides: Partial<RunResult> & { caseId: string; cacheKey: string },
): RunResult {
	return {
		caseId: overrides.caseId,
		cacheKey: overrides.cacheKey,
		source: 'fresh',
		verdict: VERDICT.pass,
		inputs: [],
		actuals: [],
		oracleVerdicts: [],
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds: { fast: 'm1', standard: 'm2', reasoning: null },
		timestamp: new Date(Date.now() - 60_000).toISOString(),
		durationMs: 100,
		...overrides,
	};
}

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX64_C = 'c'.repeat(64);

async function writeCache(caseId: string, cacheKey: string, result: RunResult): Promise<void> {
	const dir = join(cacheDir, caseId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${cacheKey}.json`), JSON.stringify({ result }, null, 2));
}

beforeEach(async () => {
	cacheDir = await mkdtemp(join(tmpdir(), 'regression-cache-reader-'));
});

afterEach(async () => {
	await rm(cacheDir, { recursive: true, force: true });
});

describe('readDisplayForCase — current-key-first selection (C2)', () => {
	it('returns null when no cache files exist', async () => {
		expect(await readDisplayForCase(cacheDir, 'demo-case', HEX64_A)).toBeNull();
	});

	it('returns the matching-key entry with coverageChanged=false', async () => {
		await writeCache(
			'demo-case',
			HEX64_A,
			makeResult({ caseId: 'demo-case', cacheKey: HEX64_A, timestamp: '2026-05-10T00:00:00Z' }),
		);
		const out = await readDisplayForCase(cacheDir, 'demo-case', HEX64_A);
		expect(out?.coverageChanged).toBe(false);
		expect(out?.result.cacheKey).toBe(HEX64_A);
	});

	it('CRITICAL: newer stale + older current-key → returns current-key entry, NOT the newer stale', async () => {
		// This was Codex C2: latest-by-timestamp would mask the current pass.
		await writeCache(
			'demo-case',
			HEX64_A,
			makeResult({
				caseId: 'demo-case',
				cacheKey: HEX64_A,
				timestamp: '2026-05-01T00:00:00Z',
			}),
		);
		await writeCache(
			'demo-case',
			HEX64_B,
			makeResult({
				caseId: 'demo-case',
				cacheKey: HEX64_B,
				timestamp: '2026-05-10T00:00:00Z', // newer
			}),
		);
		const out = await readDisplayForCase(cacheDir, 'demo-case', HEX64_A);
		expect(out?.coverageChanged).toBe(false);
		expect(out?.result.cacheKey).toBe(HEX64_A);
	});

	it('falls back to newest-stale with coverageChanged=true when current key not cached', async () => {
		await writeCache(
			'demo-case',
			HEX64_A,
			makeResult({
				caseId: 'demo-case',
				cacheKey: HEX64_A,
				timestamp: '2026-05-01T00:00:00Z',
			}),
		);
		await writeCache(
			'demo-case',
			HEX64_B,
			makeResult({
				caseId: 'demo-case',
				cacheKey: HEX64_B,
				timestamp: '2026-05-10T00:00:00Z',
			}),
		);
		// Asking for cacheKey C (not cached) → falls back to newest (B)
		const out = await readDisplayForCase(cacheDir, 'demo-case', HEX64_C);
		expect(out?.coverageChanged).toBe(true);
		expect(out?.result.cacheKey).toBe(HEX64_B);
	});

	it('returns null when only invalid cache files exist', async () => {
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		await writeFile(join(cacheDir, 'demo-case', `${HEX64_A}.json`), '{not json at all');
		expect(await readDisplayForCase(cacheDir, 'demo-case', HEX64_A)).toBeNull();
	});
});

describe('readDisplayForCase — strict validation (I5)', () => {
	it('SKIPS files with negative costUsd (does not normalize to 0)', async () => {
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		const corrupt = makeResult({ caseId: 'demo-case', cacheKey: HEX64_A, costUsd: -1 });
		await writeFile(
			join(cacheDir, 'demo-case', `${HEX64_A}.json`),
			JSON.stringify({ result: corrupt }),
		);
		expect(await readDisplayForCase(cacheDir, 'demo-case', HEX64_A)).toBeNull();
	});

	it('SKIPS files with unknown verdict enum', async () => {
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		const corrupt = { ...makeResult({ caseId: 'demo-case', cacheKey: HEX64_A }), verdict: 'wat' };
		await writeFile(
			join(cacheDir, 'demo-case', `${HEX64_A}.json`),
			JSON.stringify({ result: corrupt }),
		);
		expect(await readDisplayForCase(cacheDir, 'demo-case', HEX64_A)).toBeNull();
	});

	it('SKIPS files missing required timestamp', async () => {
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		const { timestamp: _t, ...r } = makeResult({ caseId: 'demo-case', cacheKey: HEX64_A });
		await writeFile(join(cacheDir, 'demo-case', `${HEX64_A}.json`), JSON.stringify({ result: r }));
		expect(await readDisplayForCase(cacheDir, 'demo-case', HEX64_A)).toBeNull();
	});

	it('SKIPS files missing required cacheKey field', async () => {
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		const { cacheKey: _ck, ...r } = makeResult({ caseId: 'demo-case', cacheKey: HEX64_A });
		await writeFile(join(cacheDir, 'demo-case', `${HEX64_A}.json`), JSON.stringify({ result: r }));
		expect(await readDisplayForCase(cacheDir, 'demo-case', HEX64_A)).toBeNull();
	});
});

describe('readDisplayForCase — caseId validation (path traversal defense)', () => {
	it('rejects caseId with path traversal', async () => {
		await expect(readDisplayForCase(cacheDir, '../etc/passwd', HEX64_A)).rejects.toThrow();
	});

	it('rejects caseId with separators', async () => {
		await expect(readDisplayForCase(cacheDir, 'a/b', HEX64_A)).rejects.toThrow();
	});

	it('rejects malformed cacheKey (not 64-hex)', async () => {
		await expect(readDisplayForCase(cacheDir, 'demo-case', 'not-hex')).rejects.toThrow();
	});
});

describe('readHistoryForCase', () => {
	it('returns [] when no entries exist', async () => {
		expect(await readHistoryForCase(cacheDir, 'demo-case')).toEqual([]);
	});

	it('returns all valid entries DESC by timestamp', async () => {
		await writeCache(
			'demo-case',
			HEX64_A,
			makeResult({ caseId: 'demo-case', cacheKey: HEX64_A, timestamp: '2026-05-01T00:00:00Z' }),
		);
		await writeCache(
			'demo-case',
			HEX64_B,
			makeResult({ caseId: 'demo-case', cacheKey: HEX64_B, timestamp: '2026-05-10T00:00:00Z' }),
		);
		await writeCache(
			'demo-case',
			HEX64_C,
			makeResult({ caseId: 'demo-case', cacheKey: HEX64_C, timestamp: '2026-05-05T00:00:00Z' }),
		);
		const out = await readHistoryForCase(cacheDir, 'demo-case');
		expect(out).toHaveLength(3);
		expect(out[0]?.cacheKey).toBe(HEX64_B); // newest
		expect(out[1]?.cacheKey).toBe(HEX64_C);
		expect(out[2]?.cacheKey).toBe(HEX64_A);
	});

	it('skips invalid files but returns the valid ones (I5 behavior)', async () => {
		await writeCache(
			'demo-case',
			HEX64_A,
			makeResult({ caseId: 'demo-case', cacheKey: HEX64_A, timestamp: '2026-05-01T00:00:00Z' }),
		);
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		await writeFile(join(cacheDir, 'demo-case', `${HEX64_B}.json`), '{ corrupt');
		const out = await readHistoryForCase(cacheDir, 'demo-case');
		expect(out).toHaveLength(1);
		expect(out[0]?.cacheKey).toBe(HEX64_A);
	});

	it('ignores non-hex filenames in the cache dir', async () => {
		await writeCache(
			'demo-case',
			HEX64_A,
			makeResult({ caseId: 'demo-case', cacheKey: HEX64_A, timestamp: '2026-05-01T00:00:00Z' }),
		);
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		await writeFile(join(cacheDir, 'demo-case', 'README.md'), 'ignored');
		await writeFile(join(cacheDir, 'demo-case', 'partial.tmp'), 'ignored');
		const out = await readHistoryForCase(cacheDir, 'demo-case');
		expect(out).toHaveLength(1);
	});
});
