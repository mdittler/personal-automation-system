/**
 * Cache invalidation tests (Codex C-21).
 *
 * Tests the end-to-end "touched coverage file → cache miss → fresh
 * dispatch" flow without modifying any real source files. Uses a temp
 * git repo per test so the file-state machinery (`hashRepoRelative`
 * branches on tracked-clean vs untracked vs dirty) runs the same way
 * production does.
 */

import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSuite } from '../runner/index.js';

const TYPES_PATH = join(process.cwd(), 'regression/src/shared/types.ts');

let repoRoot: string;
let casesDir: string;
let cacheDir: string;

beforeEach(async () => {
	repoRoot = await mkdtemp(join(tmpdir(), 'inv-repo-'));
	execSync('git init -q', { cwd: repoRoot });
	execSync('git config user.email t@t', { cwd: repoRoot });
	execSync('git config user.name T', { cwd: repoRoot });
	casesDir = join(repoRoot, 'cases');
	await mkdir(casesDir, { recursive: true });
	cacheDir = await mkdtemp(join(tmpdir(), 'inv-cache-'));
});
afterEach(async () => {
	await rm(repoRoot, { recursive: true, force: true });
	await rm(cacheDir, { recursive: true, force: true });
});

const caseModule = (id: string) => `
import type { PersonaCase } from '${TYPES_PATH.replace(/'/g, "\\'")}';
const c: PersonaCase = {
  id: '${id}', description: '', bucket: 'routing', routingTarget: 'food-shadow',
  coverage: ['coverage.ts'],
  inputs: [{
    payload: 'hi',
    expected: {
      schema: { type: 'object', required: ['action'], properties: { action: { type: 'string' } } },
      strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
    },
  }],
  oracle: 'structural', budgetUsd: 0.05,
};
export default c;
`;

const adapter = () => ({
	foodShadow: vi.fn().mockResolvedValue({
		raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
		meter: { model: 'f', tokenIn: 5, tokenOut: 5, costUsd: 0.0001 },
	}),
	sessionControl: vi.fn(),
	pas: vi.fn(),
});

const baseOpts = (over: Partial<Parameters<typeof runSuite>[0]> = {}) => ({
	casesDir,
	cacheDir,
	repoRoot,
	modelIds: { fast: 'f', standard: 's', reasoning: null },
	maxRunBudgetUsd: 5.0,
	estimateUsd: () => 0.0001,
	classifiers: adapter(),
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
	...over,
});

describe('coverage-changed cache invalidation', () => {
	it('modifying a tracked-clean coverage file invalidates the cache key', async () => {
		await writeFile(join(repoRoot, 'coverage.ts'), '// v1\n');
		execSync('git add . && git commit -qm v1', { cwd: repoRoot });
		await writeFile(join(casesDir, 'a.case.ts'), caseModule('a-id'));

		const opts1 = baseOpts();
		await runSuite(opts1);
		expect(opts1.classifiers.foodShadow).toHaveBeenCalledTimes(1);

		// Cache hit on immediate re-run with new adapter
		const opts2 = baseOpts();
		const second = await runSuite(opts2);
		expect(opts2.classifiers.foodShadow).toHaveBeenCalledTimes(0);
		expect(second.results[0]!.source).toBe('cached');

		// Modify the coverage file (no commit yet → file becomes dirty, sha256-hashed)
		await writeFile(join(repoRoot, 'coverage.ts'), '// v2 different\n');

		const opts3 = baseOpts();
		const third = await runSuite(opts3);
		expect(opts3.classifiers.foodShadow).toHaveBeenCalledTimes(1);
		expect(third.results[0]!.source).toBe('fresh');
	});

	it('committing the modified coverage file produces yet another cache key', async () => {
		await writeFile(join(repoRoot, 'coverage.ts'), '// v1\n');
		execSync('git add . && git commit -qm v1', { cwd: repoRoot });
		await writeFile(join(casesDir, 'a.case.ts'), caseModule('a-id'));

		await runSuite(baseOpts());

		// Dirty edit
		await writeFile(join(repoRoot, 'coverage.ts'), '// v2 different\n');
		await runSuite(baseOpts());

		// Commit the dirty edit — git blob hash now stable but different from v1
		execSync('git add . && git commit -qm v2', { cwd: repoRoot });

		const opts3 = baseOpts();
		const result = await runSuite(opts3);
		// Cache miss again because the cache key for tracked-clean v2 ≠ dirty v2
		expect(opts3.classifiers.foodShadow).toHaveBeenCalledTimes(1);
		expect(result.results[0]!.source).toBe('fresh');
	});

	it('modifying an UNRELATED file does NOT invalidate the cache', async () => {
		await writeFile(join(repoRoot, 'coverage.ts'), '// v1\n');
		await writeFile(join(repoRoot, 'unrelated.ts'), '// unrelated\n');
		execSync('git add . && git commit -qm v1', { cwd: repoRoot });
		await writeFile(join(casesDir, 'a.case.ts'), caseModule('a-id'));

		await runSuite(baseOpts());

		// Touch unrelated file — case's coverage[] doesn't include it
		await writeFile(join(repoRoot, 'unrelated.ts'), '// changed but not covered\n');

		const opts2 = baseOpts();
		const result = await runSuite(opts2);
		expect(opts2.classifiers.foodShadow).toHaveBeenCalledTimes(0);
		expect(result.results[0]!.source).toBe('cached');
	});

	it('history is retained after invalidation (REQ-REG-010)', async () => {
		await writeFile(join(repoRoot, 'coverage.ts'), '// v1\n');
		execSync('git add . && git commit -qm v1', { cwd: repoRoot });
		await writeFile(join(casesDir, 'a.case.ts'), caseModule('a-id'));

		await runSuite(baseOpts());
		await writeFile(join(repoRoot, 'coverage.ts'), '// v2 different\n');
		await runSuite(baseOpts());

		const { CacheStore } = await import('../runner/cache.js');
		const store = new CacheStore(cacheDir);
		const allForCase = await store.listAllForCase('a-id');
		// Two distinct cache entries — REQ-REG-010 keeps history forever.
		expect(allForCase.length).toBe(2);
	});
});
