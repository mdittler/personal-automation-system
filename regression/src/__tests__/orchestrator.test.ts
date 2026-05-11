import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSuite } from '../runner/index.js';

let repoRoot: string;
let casesDir: string;
let cacheDir: string;

// Cache-key computation runs files through hashRepoRelative which assumes
// the file is inside the repo root and uses git blob hash when clean,
// SHA-256 of contents when untracked. We initialize a tiny temp git repo
// per test, place case files + a coverage stub inside it, and point
// `repoRoot` at the temp repo so relative paths don't traverse outside.
beforeEach(async () => {
	repoRoot = await mkdtemp(join(tmpdir(), 'orch-repo-'));
	execSync('git init -q', { cwd: repoRoot });
	execSync('git config user.email t@t', { cwd: repoRoot });
	execSync('git config user.name T', { cwd: repoRoot });
	casesDir = join(repoRoot, 'cases');
	await mkdir(casesDir, { recursive: true });
	await writeFile(join(repoRoot, 'coverage.ts'), '// stub coverage file\n');
	cacheDir = await mkdtemp(join(tmpdir(), 'orch-cache-'));
});
afterEach(async () => {
	await rm(repoRoot, { recursive: true, force: true });
	await rm(cacheDir, { recursive: true, force: true });
});

// Absolute import path so the case module can find `PersonaCase` even though
// it lives outside the temp dir.
const TYPES_PATH = join(process.cwd(), 'regression/src/shared/types.ts');

const oneRoutingCase = (id: string) => `
import type { PersonaCase } from '${TYPES_PATH.replace(/'/g, "\\'")}';
const c: PersonaCase = {
  id: '${id}',
  description: '',
  bucket: 'routing',
  routingTarget: 'food-shadow',
  coverage: ['coverage.ts'],
  inputs: [{
    payload: 'hi',
    expected: {
      schema: { type: 'object', required: ['action'], properties: { action: { type: 'string' } } },
      strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
    },
  }],
  oracle: 'structural',
  budgetUsd: 0.05,
};
export default c;
`;

const oneReceiptCase = (id: string) => `
const c = {
  id: '${id}',
  description: '',
  bucket: 'receipt',
  coverage: ['coverage.ts'],
  inputs: [{ payload: { photoFixture: '/tmp/nope', sidecarFixture: '/tmp/nope' }, expected: {} }],
  oracle: 'structural',
  budgetUsd: 0.05,
};
export default c;
`;

const makeAdapter = () => ({
	foodShadow: vi.fn().mockResolvedValue({
		raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
		meter: { model: 'f', tokenIn: 10, tokenOut: 5, costUsd: 0.0001 },
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
	classifiers: makeAdapter(),
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
	...over,
});

describe('runSuite — empty case dir', () => {
	it('returns empty results when no cases match', async () => {
		const opts = baseOpts();
		const outcome = await runSuite(opts);
		expect(outcome.results).toEqual([]);
		expect(outcome.summary.totalCases).toBe(0);
	});
});

describe('runSuite — cache lifecycle', () => {
	it('first run is fresh; second run is cached; LLM called once', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts();
		await runSuite(opts);
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(1);
		const second = await runSuite(opts);
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(1);
		expect(second.results[0]!.source).toBe('cached');
		expect(second.results[0]!.verdict).toBe('pass');
	});

	it('rerun forces fresh dispatch even when cache is valid', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts();
		await runSuite(opts);
		await runSuite({ ...opts, rerunIds: new Set(['a-id']) });
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(2);
	});
});

describe('runSuite — RunBudget hard-abort (REQ-REG-009, Codex C-9)', () => {
	it('marks remaining cases budget-exceeded WITHOUT dispatching', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		await writeFile(join(casesDir, 'b.case.ts'), oneRoutingCase('b-id'));
		await writeFile(join(casesDir, 'c.case.ts'), oneRoutingCase('c-id'));
		const adapter = makeAdapter();
		adapter.foodShadow.mockResolvedValue({
			raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
			meter: { model: 'f', tokenIn: 10, tokenOut: 5, costUsd: 0.0001 },
		});
		const opts = baseOpts({
			maxRunBudgetUsd: 0.00015,
			estimateUsd: () => 0.0001,
			classifiers: adapter,
		});
		const { results } = await runSuite(opts);
		expect(adapter.foodShadow).toHaveBeenCalledTimes(1);
		const verdictCounts = results.map((r) => r.verdict).sort();
		expect(verdictCounts).toEqual(['budget-exceeded', 'budget-exceeded', 'pass']);
	});

	it('synthesizes one error oracleVerdict per input on budget-exceeded cases (Codex C-2)', async () => {
		const multiInputCase = `
			import type { PersonaCase } from '${TYPES_PATH.replace(/'/g, "\\'")}';
			const c: PersonaCase = {
				id: 'multi-id', description: '', bucket: 'routing', routingTarget: 'food-shadow',
				coverage: ['coverage.ts'],
				inputs: [
					{ payload: 'a', expected: { schema: { type: 'object' } } },
					{ payload: 'b', expected: { schema: { type: 'object' } } },
					{ payload: 'c', expected: { schema: { type: 'object' } } },
				],
				oracle: 'structural', budgetUsd: 0.05,
			};
			export default c;
		`;
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		await writeFile(join(casesDir, 'b.case.ts'), multiInputCase);
		const adapter = makeAdapter();
		adapter.foodShadow.mockResolvedValue({
			raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
			meter: { model: 'f', tokenIn: 10, tokenOut: 5, costUsd: 0.0001 },
		});
		const opts = baseOpts({
			maxRunBudgetUsd: 0.00015,
			estimateUsd: () => 0.0001,
			classifiers: adapter,
		});
		const { results, targets } = await runSuite(opts);
		const multi = results.find((r) => r.caseId === 'multi-id')!;
		expect(multi.verdict).toBe('budget-exceeded');
		expect(multi.oracleVerdicts).toHaveLength(3);
		expect(multi.oracleVerdicts.every((ov) => ov.verdict === 'error')).toBe(true);
		expect(targets.get('multi-id')).toBe('food-shadow');
	});
});

describe('runSuite — bucket filter', () => {
	it('skips non-matching buckets without dispatch', async () => {
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-id'));
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts({ bucketFilter: 'routing' });
		const { results } = await runSuite(opts);
		expect(results).toHaveLength(1);
		expect(results[0]!.caseId).toBe('a-id');
	});

	it('skips non-routing buckets even without filter (B.1 only wires routing)', async () => {
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-id'));
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts();
		const { results } = await runSuite(opts);
		// Receipt case is filtered out at runner-level (no wired bucket runner)
		expect(results.map((r) => r.caseId)).toEqual(['a-id']);
	});
});

describe('runSuite — dry-run', () => {
	it('does not dispatch when dryRun=true', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts({ dryRun: true });
		const { results, summary } = await runSuite(opts);
		expect(opts.classifiers.foodShadow).not.toHaveBeenCalled();
		expect(results).toHaveLength(1);
		expect(summary.totalCostUsd).toBe(0);
	});
});

describe('runSuite — onResult callback', () => {
	it('fires once per case in dispatch order', async () => {
		await writeFile(join(casesDir, 'b.case.ts'), oneRoutingCase('b-id'));
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const callbackOrder: string[] = [];
		const opts = baseOpts({ onResult: (r) => callbackOrder.push(r.caseId) });
		await runSuite(opts);
		expect(callbackOrder).toEqual(['a-id', 'b-id']); // sorted by id
	});
});

describe('runSuite — summary surfaces REQ-REG-011 accuracy', () => {
	it('summary.routingAccuracy is null when below floor', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const { summary } = await runSuite(baseOpts());
		expect(summary.routingAccuracy).toBeNull();
		expect(summary.routingInputsEvaluated).toBe(1);
	});

	it('summary.routingAccuracy computed when above floor', async () => {
		for (let i = 0; i < 20; i++) {
			// id slugs must start with a letter per validatePersonaCase ID_RE.
			await writeFile(join(casesDir, `case-${i}.case.ts`), oneRoutingCase(`case-id-${i}`));
		}
		const { summary } = await runSuite(baseOpts());
		expect(summary.routingAccuracy).toBe(1.0);
		expect(summary.routingInputsEvaluated).toBe(20);
	});
});

describe('runSuite — targets map populated', () => {
	it('maps caseId → routingTarget for every routing case', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const { targets } = await runSuite(baseOpts());
		expect(targets.get('a-id')).toBe('food-shadow');
	});
});
