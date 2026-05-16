/**
 * Cache-key parity contract test (Chunk B.2 Codex C1).
 *
 * The whole point of `buildMetadataDeps()` + `--list` is that the
 * `currentCacheKey` the GUI displays for a case matches exactly the
 * `cacheKey` that `runSuite()` would write to disk for the same case
 * with the same model snapshot. If the two diverge, every page load
 * would incorrectly report "coverage changed" on every real run.
 *
 * This test runs both paths against the same case + model snapshot and
 * asserts byte-equal cache keys.
 */

import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative as relPath } from 'node:path';
import type { TierModelSnapshot } from '@core/types/regression.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCases } from '../runner/case-loader.js';
import { type RunCliDeps, runCli } from '../runner/index.js';
import { bucketCacheSalt, computeCacheKey } from '../shared/cache-key.js';

let repoRoot: string;
let casesDir: string;
let cacheDir: string;

const MODEL_IDS: TierModelSnapshot = {
	fast: 'claude-haiku-4-5-20251001',
	standard: 'claude-sonnet-4-5',
	reasoning: null,
};

const CASE_SRC = `
import type { PersonaCase } from '@core/types/regression.js';
const c: PersonaCase = {
  id: 'parity-demo',
  description: 'cache-key parity contract',
  bucket: 'routing',
  routingTarget: 'food-shadow',
  coverage: ['fixtures/coverage.ts'],
  inputs: [{ payload: 'p', expected: { intent: 'save-recipe' } }],
  oracle: 'structural',
  budgetUsd: 0.05,
};
export default c;
`;

function buildDeps(): RunCliDeps {
	const logger = pino({ level: 'silent' });
	const throwOnDispatch = (): never => {
		throw new Error('classifier invoked');
	};
	return {
		casesDir,
		cacheDir,
		repoRoot,
		modelIds: MODEL_IDS,
		maxRunBudgetUsd: 5.0,
		estimateUsd: () => 0,
		classifiers: {
			foodShadow: async () => throwOnDispatch(),
			sessionControl: async () => throwOnDispatch(),
			pas: async () => throwOnDispatch(),
		},
		logger: {
			warn: (...args) => logger.warn(...(args as Parameters<typeof logger.warn>)),
			info: (...args) => logger.info(...(args as Parameters<typeof logger.info>)),
			debug: (...args) => logger.debug(...(args as Parameters<typeof logger.debug>)),
			error: (...args) => logger.error(...(args as Parameters<typeof logger.error>)),
		},
	};
}

beforeEach(async () => {
	repoRoot = await mkdtemp(join(tmpdir(), 'regression-parity-'));
	execSync('git init -q', { cwd: repoRoot });
	execSync('git config user.email t@t', { cwd: repoRoot });
	execSync('git config user.name T', { cwd: repoRoot });
	casesDir = join(repoRoot, 'cases');
	cacheDir = join(repoRoot, 'cache');
	await mkdir(casesDir, { recursive: true });
	await mkdir(cacheDir, { recursive: true });
	await mkdir(join(repoRoot, 'fixtures'), { recursive: true });
	await writeFile(join(repoRoot, 'fixtures', 'coverage.ts'), '// covered\n');
	await writeFile(join(casesDir, 'parity.case.ts'), CASE_SRC);
	execSync('git add -A', { cwd: repoRoot });
	execSync('git commit -q -m init', { cwd: repoRoot });
});

afterEach(async () => {
	await rm(repoRoot, { recursive: true, force: true });
});

describe('list-mode cache-key parity', () => {
	it('emitted currentCacheKey === computeCacheKey() for the same case + modelIds', async () => {
		const loaded = await loadCases(casesDir);
		expect(loaded).toHaveLength(1);
		const expected = await computeCacheKey({
			casePath: relPath(repoRoot, loaded[0]!.filePath),
			coveragePaths: loaded[0]!.case.coverage,
			modelIds: MODEL_IDS,
			repoRoot,
		});

		const chunks: string[] = [];
		await runCli(['--list', '--json'], buildDeps(), { stdout: (s) => chunks.push(s) });
		const lines = chunks
			.join('')
			.split('\n')
			.filter((s) => s.trim())
			.map((s) => JSON.parse(s) as { type?: string; currentCacheKey?: string });
		const entry = lines.find((l) => l.type === 'case-list-entry');
		expect(entry?.currentCacheKey).toBe(expected);
	});

	it('two --list invocations produce identical cache keys for the same case', async () => {
		const run1: string[] = [];
		const run2: string[] = [];
		await runCli(['--list', '--json'], buildDeps(), { stdout: (s) => run1.push(s) });
		await runCli(['--list', '--json'], buildDeps(), { stdout: (s) => run2.push(s) });
		const k1 = (JSON.parse(run1.join('').split('\n')[0]!) as { currentCacheKey: string })
			.currentCacheKey;
		const k2 = (JSON.parse(run2.join('').split('\n')[0]!) as { currentCacheKey: string })
			.currentCacheKey;
		expect(k1).toBe(k2);
	});

	it('changing model snapshot changes the cache key (modelIds participate in the hash)', async () => {
		const run1: string[] = [];
		await runCli(['--list', '--json'], buildDeps(), { stdout: (s) => run1.push(s) });
		const deps2 = buildDeps();
		deps2.modelIds = { fast: 'different-fast', standard: 'different-std', reasoning: null };
		const run2: string[] = [];
		await runCli(['--list', '--json'], deps2, { stdout: (s) => run2.push(s) });
		const k1 = (JSON.parse(run1.join('').split('\n')[0]!) as { currentCacheKey: string })
			.currentCacheKey;
		const k2 = (JSON.parse(run2.join('').split('\n')[0]!) as { currentCacheKey: string })
			.currentCacheKey;
		expect(k1).not.toBe(k2);
	});

	it('changing coverage file content changes the cache key (git blob hash participates)', async () => {
		const run1: string[] = [];
		await runCli(['--list', '--json'], buildDeps(), { stdout: (s) => run1.push(s) });
		await writeFile(join(repoRoot, 'fixtures', 'coverage.ts'), '// covered v2\n');
		execSync('git add -A', { cwd: repoRoot });
		execSync('git commit -q -m bump', { cwd: repoRoot });
		const run2: string[] = [];
		await runCli(['--list', '--json'], buildDeps(), { stdout: (s) => run2.push(s) });
		const k1 = (JSON.parse(run1.join('').split('\n')[0]!) as { currentCacheKey: string })
			.currentCacheKey;
		const k2 = (JSON.parse(run2.join('').split('\n')[0]!) as { currentCacheKey: string })
			.currentCacheKey;
		expect(k1).not.toBe(k2);
	});

	// Receipt cases need the same date+timezone salt applied in --list mode
	// that runSuite applies, or the GUI's currentCacheKey would silently
	// diverge from the cache file the real run writes.
	it('receipt-bucket --list cacheKey matches computeCacheKey with bucketCacheSalt applied', async () => {
		const RECEIPT_CASE = `
import type { PersonaCase } from '@core/types/regression.js';
const c: PersonaCase = {
  id: 'receipt-parity-demo',
  description: 'receipt cache-key salt parity',
  bucket: 'receipt',
  coverage: ['fixtures/coverage.ts'],
  inputs: [{ payload: { photoFixture: '/tmp/nope', sidecarFixture: '/tmp/nope' }, expected: { kind: 'sidecar' } }],
  oracle: 'structural',
  budgetUsd: 0.05,
};
export default c;
`;
		await writeFile(join(casesDir, 'receipt.case.ts'), RECEIPT_CASE);
		execSync('git add -A', { cwd: repoRoot });
		execSync('git commit -q -m receipt', { cwd: repoRoot });

		const deps = buildDeps();
		// Pin the timezone explicitly so the salt is deterministic regardless
		// of the host's locale.
		deps.timezone = 'America/New_York';
		const loaded = await loadCases(casesDir);
		const receipt = loaded.find((lc) => lc.case.bucket === 'receipt')!;
		const salt = bucketCacheSalt('receipt', deps.timezone);
		expect(salt).toBeDefined();
		const expected = await computeCacheKey({
			casePath: relPath(repoRoot, receipt.filePath),
			coveragePaths: receipt.case.coverage,
			modelIds: MODEL_IDS,
			repoRoot,
			extraSalt: salt,
		});

		const chunks: string[] = [];
		await runCli(['--list', '--json'], deps, { stdout: (s) => chunks.push(s) });
		const lines = chunks
			.join('')
			.split('\n')
			.filter((s) => s.trim())
			.map((s) => JSON.parse(s) as { type?: string; caseId?: string; currentCacheKey?: string });
		const entry = lines.find((l) => l.caseId === 'receipt-parity-demo');
		expect(entry?.currentCacheKey).toBe(expected);
	});

	it('non-receipt buckets do NOT receive the date salt in --list (regression guard)', async () => {
		// Sanity: the routing case from beforeEach must continue to use the
		// non-salted cache key — only receipts get the date binding.
		const deps = buildDeps();
		deps.timezone = 'America/New_York';
		const loaded = await loadCases(casesDir);
		const routing = loaded[0]!;
		const expected = await computeCacheKey({
			casePath: relPath(repoRoot, routing.filePath),
			coveragePaths: routing.case.coverage,
			modelIds: MODEL_IDS,
			repoRoot,
			// no extraSalt — routing buckets are bucket-salt-free
		});
		const chunks: string[] = [];
		await runCli(['--list', '--json'], deps, { stdout: (s) => chunks.push(s) });
		const entry = chunks
			.join('')
			.split('\n')
			.filter((s) => s.trim())
			.map((s) => JSON.parse(s) as { caseId?: string; currentCacheKey?: string })
			.find((l) => l.caseId === 'parity-demo');
		expect(entry?.currentCacheKey).toBe(expected);
	});
});
