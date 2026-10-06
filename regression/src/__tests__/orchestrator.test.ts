import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RubricJudgeLLM } from '../oracles/rubric.js';
import type { AgentTrialRunner } from '../runner/case-runners/agent-runner.js';
import type { RecallAdapter } from '../runner/dispatch.js';
import { runCli, runSuite } from '../runner/index.js';
import { VERDICT } from '../shared/types.js';
import { StubLLMService } from './_stub-provider.js';

const noopLogger = {
	warn: () => {},
	info: () => {},
	debug: () => {},
	error: () => {},
};

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
const TYPES_PATH = fileURLToPath(new URL('../shared/types.ts', import.meta.url));

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
	it('cases sharing one definition file are cached independently (REQ-REG-024)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		await writeFile(join(casesDir, 'b.case.ts'), oneRoutingCase('b-id'));
		const outcome = await runSuite(baseOpts());
		const keys = new Set(outcome.results.map((r) => r.cacheKey));
		expect(keys.size).toBe(2);
	});

	it('does not cache an error verdict — the next run dispatches again (REQ-REG-023)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const adapter = makeAdapter();
		adapter.foodShadow.mockRejectedValue(new Error('provider exploded'));
		const opts = baseOpts({ classifiers: adapter });
		const first = await runSuite(opts);
		expect(first.results[0]!.verdict).toBe(VERDICT.error);
		// The write guard on its own: nothing was persisted for the error result.
		const persisted = await readdir(join(cacheDir, 'a-id')).catch(() => []);
		expect(persisted).toEqual([]);
		const second = await runSuite(opts);
		expect(adapter.foodShadow).toHaveBeenCalledTimes(2);
		expect(second.results[0]!.source).toBe('fresh');
	});

	it('first run is fresh; second run is cached; LLM called once', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts();
		await runSuite(opts);
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(1);
		const second = await runSuite(opts);
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(1);
		expect(second.results[0]!.source).toBe('cached');
		expect(second.results[0]!.verdict).toBe(VERDICT.pass);
	});

	it('rerun forces fresh dispatch even when cache is valid', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts();
		await runSuite(opts);
		await runSuite({ ...opts, rerunIds: new Set(['a-id']) });
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(2);
	});

	it('noCache=true forces fresh dispatch for every case (Batch 0)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		await writeFile(join(casesDir, 'b.case.ts'), oneRoutingCase('b-id'));
		const opts = baseOpts();
		await runSuite(opts);
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(2);

		// noCache: true — every case must be redispatched
		const second = await runSuite({ ...opts, noCache: true });
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(4);
		expect(second.results.every((r) => r.source === 'fresh')).toBe(true);
	});
});

describe('runSuite — RunBudget hard-abort (REQ-REG-009)', () => {
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
		expect(verdictCounts).toEqual([VERDICT.budgetExceeded, VERDICT.budgetExceeded, VERDICT.pass]);
	});

	it('synthesizes one error oracleVerdict per input on budget-exceeded cases', async () => {
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
		expect(multi.verdict).toBe(VERDICT.budgetExceeded);
		expect(multi.oracleVerdicts).toHaveLength(3);
		expect(multi.oracleVerdicts.every((ov) => ov.verdict === VERDICT.error)).toBe(true);
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

	it('throws when receipt case is present without receiptLlm dep (A.2 wired the arm)', async () => {
		// Chunk A.2 wired the receipt-bucket dispatch arm. The "required iff
		// used" guard mirrors how `chatbotEnvFactory` works for chatbot cases.
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-id'));
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts();
		await expect(runSuite(opts)).rejects.toThrow(/receiptLlm.*r-id|r-id.*receiptLlm/i);
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

describe('runCli', () => {
	it('prints help and exits 0 on --help', async () => {
		const { runCli } = await import('../runner/index.js');
		const out: string[] = [];
		const r = await runCli(['--help'], baseOpts(), { stdout: (s) => out.push(s) });
		expect(r.exitCode).toBe(0);
		expect(out.join('')).toMatch(/Persona Regression Suite/);
	});

	it('exits 1 on bad args', async () => {
		const { runCli } = await import('../runner/index.js');
		const out: string[] = [];
		const r = await runCli(['--garbage'], baseOpts(), { stdout: (s) => out.push(s) });
		expect(r.exitCode).toBe(1);
		expect(out.join('')).toMatch(/unknown flag/i);
	});

	it('emits line-delimited JSON when --json is set', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const { runCli } = await import('../runner/index.js');
		const lines: string[] = [];
		const stdoutFn = (s: string) => {
			for (const l of s.split('\n')) {
				if (l) lines.push(l);
			}
		};
		await runCli(['--json'], baseOpts(), { stdout: stdoutFn });
		const events = lines.map((l) => JSON.parse(l));
		expect(events.some((e) => e.type === 'case-result')).toBe(true);
		const finalEvent = events.at(-1)!;
		expect(finalEvent.type).toBe('summary');
		// The summary line carries `modelIds` as a sibling of `summary` so the
		// GUI's terminal banner can name the actually-tested model. This proves
		// the runner emits it end-to-end (subprocess.ts just forwards what the
		// runner writes).
		expect(finalEvent.modelIds).toEqual({ fast: 'f', standard: 's', reasoning: null });
	});

	it('summary-line modelIds reflects an applied tier override', async () => {
		// Different snapshot than the default baseOpts() so a regression that
		// hard-codes defaults instead of plumbing `deps.modelIds` would fail
		// here even when the previous test passes.
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const { runCli } = await import('../runner/index.js');
		const lines: string[] = [];
		const stdoutFn = (s: string) => {
			for (const l of s.split('\n')) {
				if (l) lines.push(l);
			}
		};
		const overriddenSnapshot = {
			fast: 'gemma4:31b',
			standard: 'claude-sonnet-4-6',
			reasoning: null,
		};
		await runCli(['--json'], baseOpts({ modelIds: overriddenSnapshot }), { stdout: stdoutFn });
		const events = lines.map((l) => JSON.parse(l));
		const finalEvent = events.at(-1)!;
		expect(finalEvent.type).toBe('summary');
		expect(finalEvent.modelIds).toEqual(overriddenSnapshot);
	});

	it('emits markdown summary table by default', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const { runCli } = await import('../runner/index.js');
		const out: string[] = [];
		await runCli([], baseOpts(), { stdout: (s) => out.push(s) });
		expect(out.join('')).toMatch(/\| metric \| value \|/);
	});

	it('--dry-run renders the estimate-focused summary (no pass/fail counts)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		await writeFile(join(casesDir, 'b.case.ts'), oneRoutingCase('b-id'));
		const { runCli } = await import('../runner/index.js');
		const out: string[] = [];
		const adapter = makeAdapter();
		const r = await runCli(['--dry-run'], baseOpts({ classifiers: adapter }), {
			stdout: (s) => out.push(s),
		});
		const body = out.join('');
		expect(r.exitCode).toBe(0);
		expect(adapter.foodShadow).not.toHaveBeenCalled();
		expect(body).toMatch(/DRY RUN/);
		expect(body).toMatch(/cases that would dispatch \| 2/);
		expect(body).toMatch(/estimated cost upper-bound/);
		expect(body).not.toMatch(/pass \| 2/); // no fake pass counts
		expect(body).not.toMatch(/REQ-REG-011/); // gate is skipped on dry-run
	});

	it('--dry-run does not trigger the REQ-REG-011 gate even with synthetic pass results', async () => {
		// 25 cases all marked dry-run → would naively show "25 pass" in the
		// regular summary; the dry-run path must skip the gate.
		for (let i = 0; i < 25; i++) {
			await writeFile(join(casesDir, `c-${i}.case.ts`), oneRoutingCase(`c-id-${i}`));
		}
		const { runCli } = await import('../runner/index.js');
		const out: string[] = [];
		const r = await runCli(['--dry-run'], baseOpts(), { stdout: (s) => out.push(s) });
		expect(r.exitCode).toBe(0);
		expect(out.join('')).not.toMatch(/REQ-REG-011 FAILED/);
	});

	it('exits 1 when REQ-REG-011 gate fails', async () => {
		// Write 25 cases; mock 24 passes + 1 fail. Accuracy = 24/25 = 0.96.
		// Then write 25 cases where 20 pass + 5 fail. Accuracy = 0.80 → fail.
		for (let i = 0; i < 25; i++) {
			await writeFile(join(casesDir, `c-${i}.case.ts`), oneRoutingCase(`c-id-${i}`));
		}
		const adapter = makeAdapter();
		let call = 0;
		adapter.foodShadow.mockImplementation(async () => {
			call++;
			const fail = call > 20; // 5 fail at the end
			return {
				raw: JSON.stringify({ action: fail ? 'wrong' : 'none', confidence: 0.5 }),
				meter: { model: 'f', tokenIn: 5, tokenOut: 5, costUsd: 0.00005 },
			};
		});
		const { runCli } = await import('../runner/index.js');
		const out: string[] = [];
		const r = await runCli([], baseOpts({ classifiers: adapter }), {
			stdout: (s) => out.push(s),
		});
		expect(r.exitCode).toBe(1);
		expect(out.join('')).toMatch(/REQ-REG-011 FAILED/);
	});

	it('exits 0 with a "below floor" indication when fewer than 20 inputs ran', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const { runCli } = await import('../runner/index.js');
		const out: string[] = [];
		const r = await runCli([], baseOpts(), { stdout: (s) => out.push(s) });
		expect(r.exitCode).toBe(0);
		expect(out.join('')).toMatch(/below floor/i);
	});
});

describe('runSuite — recall bucket', () => {
	let tmp: string;
	let recallCasesDir: string;
	let recallCacheDir: string;

	beforeEach(async () => {
		// realpath() resolves the macOS /var → /private/var symlink so the
		// repoRoot here matches what `import.meta.url` reports from the
		// dynamically-loaded `buildCases()` module (Node resolves symlinks on
		// import). Without this, `relative(repoRoot, filePath)` produces a
		// `../../private/...` prefix that `assertRepoRelative` rejects.
		tmp = await realpath(await mkdtemp(join(tmpdir(), 'orch-recall-')));
		// Initialize a git repo + stub coverage file so cache-key computation
		// (which calls `git ls-files` / readFile under tmp) succeeds for the
		// `coverage: ['core/.../recall-classifier.ts']` path referenced in the
		// inlined case fixture below.
		execSync('git init -q', { cwd: tmp });
		execSync('git config user.email t@t', { cwd: tmp });
		execSync('git config user.name T', { cwd: tmp });
		await mkdir(join(tmp, 'core', 'src', 'services', 'conversation-retrieval'), {
			recursive: true,
		});
		await writeFile(
			join(tmp, 'core', 'src', 'services', 'conversation-retrieval', 'recall-classifier.ts'),
			'// stub coverage file\n',
		);
		recallCasesDir = join(tmp, 'cases', 'recall');
		recallCacheDir = join(tmp, 'cache');
		await mkdir(recallCasesDir, { recursive: true });
		await mkdir(recallCacheDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	async function writeRecallCaseFile(payload: string): Promise<void> {
		// Inline a buildCases() module so the loader picks it up via index.ts.
		const src = `
			import { fileURLToPath } from 'node:url';
			export function buildCases() {
				const filePath = fileURLToPath(import.meta.url);
				return [{
					case: {
						id: 'orch-recall-smoke',
						description: 'smoke',
						bucket: 'recall',
						coverage: ['core/src/services/conversation-retrieval/recall-classifier.ts'],
						inputs: [{
							payload: ${JSON.stringify(payload)},
							today: '2026-05-11',
							expected: { schema: { type: 'object', required: ['shouldRecall'], properties: { shouldRecall: { const: true } } } },
						}],
						oracle: 'structural',
						budgetUsd: 0.05,
					},
					filePath,
				}];
			}
		`;
		await writeFile(join(recallCasesDir, 'index.ts'), src, 'utf8');
	}

	it('dispatches recall cases through the recall adapter and writes the cache file', async () => {
		await writeRecallCaseFile('what did we say about the leak earlier?');
		const recallCalls: Array<{ msg: string; today?: string }> = [];
		const recallAdapter: RecallAdapter = {
			recall: async (msg, today) => {
				recallCalls.push({ msg, today });
				return {
					raw: '{"shouldRecall": true, "query": "leak", "timeAnchor": null, "reason": "x"}',
					meter: { model: 'fast-m', tokenIn: 0, tokenOut: 0, costUsd: 0.0003 },
				};
			},
		};
		const outcome = await runSuite({
			casesDir: join(tmp, 'cases'),
			cacheDir: recallCacheDir,
			repoRoot: tmp,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			maxRunBudgetUsd: 1,
			estimateUsd: () => 0.001,
			classifiers: { foodShadow: vi.fn(), sessionControl: vi.fn(), pas: vi.fn() } as never,
			logger: noopLogger,
			recallAdapter,
		});
		expect(outcome.results).toHaveLength(1);
		const r = outcome.results[0]!;
		expect(r.verdict).toBe(VERDICT.pass);
		expect(r.source).toBe('fresh');
		expect(recallCalls).toHaveLength(1);
		expect(recallCalls[0]!.today).toBe('2026-05-11');
		// Cache file written (CacheStore wraps as `{ result: RunResult }`).
		const cacheFile = join(recallCacheDir, 'orch-recall-smoke', `${r.cacheKey}.json`);
		const persisted = JSON.parse(await readFile(cacheFile, 'utf8'));
		expect(persisted.result.caseId).toBe('orch-recall-smoke');
	});

	it('skips dispatch when a recall case is in cache (cache hit; source=cached)', async () => {
		await writeRecallCaseFile('what did we say about the leak earlier?');
		const recallAdapter: RecallAdapter = {
			recall: vi.fn(async () => {
				throw new Error('adapter must not be invoked on cache hit');
			}),
		};
		// First run writes cache
		await runSuite({
			casesDir: join(tmp, 'cases'),
			cacheDir: recallCacheDir,
			repoRoot: tmp,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			maxRunBudgetUsd: 1,
			estimateUsd: () => 0.001,
			classifiers: { foodShadow: vi.fn(), sessionControl: vi.fn(), pas: vi.fn() } as never,
			logger: noopLogger,
			recallAdapter: {
				recall: async () => ({
					raw: '{"shouldRecall": true, "query": "leak", "timeAnchor": null, "reason": "x"}',
					meter: { model: 'fast-m', tokenIn: 0, tokenOut: 0, costUsd: 0 },
				}),
			},
		});
		// Second run must hit cache
		const outcome2 = await runSuite({
			casesDir: join(tmp, 'cases'),
			cacheDir: recallCacheDir,
			repoRoot: tmp,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			maxRunBudgetUsd: 1,
			estimateUsd: () => 0.001,
			classifiers: { foodShadow: vi.fn(), sessionControl: vi.fn(), pas: vi.fn() } as never,
			logger: noopLogger,
			recallAdapter,
		});
		expect(outcome2.results[0]!.source).toBe('cached');
		expect(recallAdapter.recall).not.toHaveBeenCalled();
	});

	it('emits onResult exactly once per dispatched recall case', async () => {
		await writeRecallCaseFile('what did we discuss?');
		const events: string[] = [];
		await runSuite({
			casesDir: join(tmp, 'cases'),
			cacheDir: recallCacheDir,
			repoRoot: tmp,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			maxRunBudgetUsd: 1,
			estimateUsd: () => 0.001,
			classifiers: { foodShadow: vi.fn(), sessionControl: vi.fn(), pas: vi.fn() } as never,
			logger: noopLogger,
			recallAdapter: {
				recall: async () => ({
					raw: '{"shouldRecall": true, "query": "x", "timeAnchor": null, "reason": "x"}',
					meter: { model: 'fast-m', tokenIn: 0, tokenOut: 0, costUsd: 0 },
				}),
			},
			onResult: (r) => events.push(r.caseId),
		});
		expect(events).toEqual(['orch-recall-smoke']);
	});
});

describe('runSuite — chatbot bucket', () => {
	let tmp: string;
	let chatbotCasesDir: string;
	let chatbotCacheDir: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), 'orch-chatbot-'));
		chatbotCasesDir = join(tmp, 'cases', 'chatbot');
		chatbotCacheDir = join(tmp, 'cache');
		await mkdir(chatbotCasesDir, { recursive: true });
		await mkdir(chatbotCacheDir, { recursive: true });
		// computeCacheKey requires a git repo + coverage path
		execSync('git init -q', { cwd: tmp });
		execSync('git config user.email t@t', { cwd: tmp });
		execSync('git config user.name T', { cwd: tmp });
		await mkdir(join(tmp, 'core', 'src', 'services', 'conversation'), {
			recursive: true,
		});
		await writeFile(
			join(tmp, 'core', 'src', 'services', 'conversation', 'handle-message.ts'),
			'// stub for cache key',
			'utf8',
		);
		// realpath() resolves the macOS /var → /private/var symlink so the
		// repoRoot here matches what `import.meta.url` reports from the
		// dynamically-loaded `buildCases()` module.
		tmp = await realpath(tmp);
		chatbotCasesDir = join(tmp, 'cases', 'chatbot');
		chatbotCacheDir = join(tmp, 'cache');
	});
	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	async function writeTwoChatbotCases(): Promise<void> {
		const src = `
			import { fileURLToPath } from 'node:url';
			export function buildCases() {
				const filePath = fileURLToPath(import.meta.url);
				const base = {
					bucket: 'chatbot',
					coverage: ['core/src/services/conversation/handle-message.ts'],
					oracle: 'rubric',
					budgetUsd: 0.2,
				};
				return [
					{ case: { ...base, id: 'cb-a', description: 'a', rubric: 'rubric a content', inputs: [{ payload: 'p1', expected: {} }] }, filePath },
					{ case: { ...base, id: 'cb-b', description: 'b', rubric: 'rubric b content', inputs: [{ payload: 'p2', expected: {} }] }, filePath },
				];
			}
		`;
		await writeFile(join(chatbotCasesDir, 'index.ts'), src, 'utf8');
	}

	function fakeChatbotEnv() {
		const sent: Array<{ userId: string; text: string }> = [];
		let recordedHandler: string | null = null;
		return {
			userId: 'u',
			householdId: 'h',
			telegram: { sent },
			runtime: {
				services: {
					router: {
						routeMessage: vi.fn(async () => {
							recordedHandler = 'chatbot-fallback';
							sent.push({ userId: 'u', text: 'fake reply' });
						}),
					},
				},
			},
			captureHandler: () => () => recordedHandler,
			endActiveSession: vi.fn(async () => {
				recordedHandler = null;
			}),
			dispose: vi.fn(async () => {}),
		};
	}

	function chatbotBaseOpts(
		extras: Partial<Parameters<typeof runSuite>[0]> = {},
	): Parameters<typeof runSuite>[0] {
		return {
			casesDir: join(tmp, 'cases'),
			cacheDir: chatbotCacheDir,
			repoRoot: tmp,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			maxRunBudgetUsd: 1,
			estimateUsd: () => 0.001,
			classifiers: { foodShadow: vi.fn(), sessionControl: vi.fn(), pas: vi.fn() } as never,
			logger: noopLogger,
			...extras,
		};
	}

	it('builds a fresh environment per chatbot case and disposes each (REQ-REG-025)', async () => {
		await writeTwoChatbotCases();
		const judge = new StubLLMService()
			.queue('{"score": 5, "explanation": "ok"}')
			.queue('{"score": 5, "explanation": "ok"}');
		const envs: Array<ReturnType<typeof fakeChatbotEnv>> = [];
		const factory = vi.fn(async () => {
			const e = fakeChatbotEnv();
			envs.push(e);
			return e;
		});
		const outcome = await runSuite(
			chatbotBaseOpts({
				chatbotEnvFactory: factory,
				judgeLlm: judge as unknown as RubricJudgeLLM,
				costTracker: {
					getMonthlyTotalCost: () => 0,
					getTokenUsageTotals: () => ({ input: 0, output: 0 }),
				},
			}),
		);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(envs.every((e) => e.dispose.mock.calls.length === 1)).toBe(true);
		expect(outcome.results.map((r) => r.verdict)).toEqual([VERDICT.pass, VERDICT.pass]);
	});

	it('disposes each case environment even when routing throws (REQ-REG-025)', async () => {
		await writeTwoChatbotCases();
		const envs: Array<ReturnType<typeof fakeChatbotEnv>> = [];
		const factory = vi.fn(async () => {
			const e = fakeChatbotEnv();
			e.runtime.services.router.routeMessage = vi.fn(async () => {
				throw new Error('router exploded');
			});
			envs.push(e);
			return e;
		});
		await runSuite(
			chatbotBaseOpts({
				chatbotEnvFactory: factory,
				judgeLlm: new StubLLMService() as unknown as RubricJudgeLLM,
				costTracker: {
					getMonthlyTotalCost: () => 0,
					getTokenUsageTotals: () => ({ input: 0, output: 0 }),
				},
			}),
		);
		expect(envs).toHaveLength(2);
		expect(envs.every((e) => e.dispose.mock.calls.length === 1)).toBe(true);
	});

	it('throws when a chatbot case is present and no chatbotEnvFactory is provided', async () => {
		await writeTwoChatbotCases();
		await expect(runSuite(chatbotBaseOpts())).rejects.toThrow(/chatbotEnvFactory|judgeLlm/i);
	});

	it('on env-factory failure marks ALL remaining chatbot cases as error without retrying the factory (Codex I3)', async () => {
		await writeTwoChatbotCases();
		const factory = vi.fn(async () => {
			throw new Error('compose runtime failed');
		});
		const outcome = await runSuite(
			chatbotBaseOpts({
				chatbotEnvFactory: factory,
				judgeLlm: new StubLLMService() as unknown as RubricJudgeLLM,
				costTracker: {
					getMonthlyTotalCost: () => 0,
					getTokenUsageTotals: () => ({ input: 0, output: 0 }),
				},
			}),
		);
		expect(factory).toHaveBeenCalledTimes(1); // not retried per case
		expect(outcome.results).toHaveLength(2);
		for (const r of outcome.results) {
			expect(r.verdict).toBe(VERDICT.error);
			expect(r.oracleVerdicts[0]!.details).toMatch(/compose runtime failed|env-factory/);
		}
	});

	it('emits onResult once per chatbot case in dispatch order', async () => {
		await writeTwoChatbotCases();
		const env = fakeChatbotEnv();
		const judge = new StubLLMService()
			.queue('{"score": 5, "explanation": "ok"}')
			.queue('{"score": 5, "explanation": "ok"}');
		const events: string[] = [];
		await runSuite(
			chatbotBaseOpts({
				chatbotEnvFactory: async () => env,
				judgeLlm: judge as unknown as RubricJudgeLLM,
				costTracker: {
					getMonthlyTotalCost: () => 0,
					getTokenUsageTotals: () => ({ input: 0, output: 0 }),
				},
				onResult: (r) => events.push(r.caseId),
			}),
		);
		expect(events).toEqual(['cb-a', 'cb-b']); // sorted by id
	});
});

describe('runCli --archive-cache', () => {
	it('--archive-cache moves the cache and exits 0 without dispatching (REQ-REG-027)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		const opts = baseOpts();
		await runSuite(opts);
		const out: string[] = [];
		const res = await runCli(['--archive-cache'], opts, { stdout: (s) => out.push(s) });
		expect(res.exitCode).toBe(0);
		expect(out.join('')).toMatch(/Archived cache to /);
		expect(opts.classifiers.foodShadow).toHaveBeenCalledTimes(1);
	});
});

describe('runSuite — agent bucket', () => {
	const agentCaseSrc = (id: string) => `
		import type { PersonaCase } from '${TYPES_PATH.replace(/'/g, "\\'")}';
		const c: PersonaCase = {
			id: '${id}', description: '', bucket: 'agent', coverage: ['coverage.ts'],
			inputs: [{ payload: { turns: [{ text: 'q' }] },
				expected: { set: 'regression', category: 'single-fact', facts: [{ kind: 'number', value: 57.35, label: 'total' }] } }],
			oracle: 'outcome', budgetUsd: 1,
		};
		export default c;
	`;
	const passTrial = vi.fn(async () => ({
		verdict: 'pass' as const,
		details: 'ok',
		transcript: 'It was $57.35',
		costUsd: 0,
		tokenIn: 0,
		tokenOut: 0,
		durationMs: 1,
	}));

	it('dispatches agent cases through the trial runner with the configured repeats', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		passTrial.mockClear();
		const outcome = await runSuite(baseOpts({ agentTrialRunner: passTrial, agentRepeats: 2 }));
		expect(passTrial).toHaveBeenCalledTimes(2);
		expect(outcome.results[0]!.verdict).toBe(VERDICT.pass);
	});

	it('a different repeats value is a different cache key', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		const one = await runSuite(baseOpts({ agentTrialRunner: passTrial, agentRepeats: 1 }));
		const two = await runSuite(baseOpts({ agentTrialRunner: passTrial, agentRepeats: 2 }));
		expect(one.results[0]!.cacheKey).not.toBe(two.results[0]!.cacheKey);
		expect(two.results[0]!.source).toBe('fresh');
	});

	it('throws a clear error when an agent case is present without a trial runner', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		await expect(runSuite(baseOpts())).rejects.toThrow(/agentTrialRunner/);
	});

	it('relays every trial meter as a heartbeat with case id and trial number (review C25)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		const beats: unknown[] = [];
		const metering: AgentTrialRunner = async (_req, hooks) => {
			hooks?.onMeter?.({ costUsd: 0.01, tokenIn: 5, tokenOut: 2 });
			return passTrial();
		};
		await runSuite(
			baseOpts({
				agentTrialRunner: metering,
				agentRepeats: 2,
				onHeartbeat: (h) => beats.push(h),
			}),
		);
		expect(beats).toEqual([
			{ caseId: 'agent-a', trial: 1, repeats: 2, costUsd: 0.01, tokenIn: 5, tokenOut: 2 },
			{ caseId: 'agent-a', trial: 2, repeats: 2, costUsd: 0.01, tokenIn: 5, tokenOut: 2 },
		]);
	});

	it('runCli --json writes heartbeat NDJSON lines before the case-result (review C25)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		const out: string[] = [];
		const metering: AgentTrialRunner = async (_req, hooks) => {
			hooks?.onMeter?.({ costUsd: 0.01, tokenIn: 5, tokenOut: 2 });
			return passTrial();
		};
		await runCli(
			['--json', '--bucket=agent', '--repeats=1'],
			baseOpts({ agentTrialRunner: metering }),
			{
				stdout: (s) => out.push(s),
			},
		);
		const types = out
			.join('')
			.trim()
			.split('\n')
			.map((l) => (JSON.parse(l) as { type: string }).type);
		expect(types).toEqual(['heartbeat', 'case-result', 'summary']);
		expect(JSON.parse(out[0]!)).toMatchObject({
			type: 'heartbeat',
			caseId: 'agent-a',
			trial: 1,
			repeats: 1,
			costUsd: 0.01,
		});
	});

	it('runCli without --json keeps heartbeats off stdout (stderr progress line instead)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		const out: string[] = [];
		const err: string[] = [];
		const metering: AgentTrialRunner = async (_req, hooks) => {
			hooks?.onMeter?.({ costUsd: 0.01, tokenIn: 5, tokenOut: 2 });
			return passTrial();
		};
		await runCli(['--bucket=agent', '--repeats=1'], baseOpts({ agentTrialRunner: metering }), {
			stdout: (s) => out.push(s),
			stderr: (s) => err.push(s),
		});
		expect(out.join('')).not.toContain('heartbeat');
		expect(err.join('')).toMatch(/agent heartbeat: agent-a trial 1\/1 \$0\.0100/);
	});

	it('run-budget pre-check prices agent cases as per-turn estimate x turns x repeats (review C9)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		const never: AgentTrialRunner = vi.fn(async () => passTrial());
		// 0.01 per turn x 1 turn x 3 repeats = 0.03 > 0.02 remaining → skipped without dispatch.
		const outcome = await runSuite(
			baseOpts({
				agentTrialRunner: never,
				agentRepeats: 3,
				maxRunBudgetUsd: 0.02,
				estimateUsd: () => 0.01,
			}),
		);
		expect(outcome.results[0]!.verdict).toBe(VERDICT.budgetExceeded);
		expect(never).not.toHaveBeenCalled();
	});

	it('runCli --dry-run prices agent cases through estimateAgentCaseUsd (review C9/C26)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		const out: string[] = [];
		await runCli(
			['--dry-run', '--bucket=agent', '--repeats=3'],
			baseOpts({ estimateUsd: () => 0.01 }),
			{ stdout: (s) => out.push(s) },
		);
		expect(out.join('')).toContain('| estimated cost upper-bound (USD) | 0.030000 |');
	});

	it('caps the case allowance at the run budget remaining (review C15)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), agentCaseSrc('agent-a'));
		const spend: AgentTrialRunner = vi.fn(async () => ({
			verdict: 'pass' as const,
			details: 'ok',
			transcript: '',
			costUsd: 0.03,
			tokenIn: 0,
			tokenOut: 0,
			durationMs: 1,
		}));
		// Case budget is $1, run budget leaves $0.05: trial 1 ($0.03) fits, trial 2 would not.
		const outcome = await runSuite(
			baseOpts({
				agentTrialRunner: spend,
				agentRepeats: 3,
				maxRunBudgetUsd: 0.05,
				estimateUsd: () => 0.001,
			}),
		);
		expect(outcome.results[0]!.verdict).toBe(VERDICT.budgetExceeded);
		expect(spend).toHaveBeenCalledTimes(2);
	});
});

describe('runSuite — caseFilter (review C23)', () => {
	it('dispatches only the named cases and rejects unknown ids', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		await writeFile(join(casesDir, 'b.case.ts'), oneRoutingCase('b-id'));
		const outcome = await runSuite(baseOpts({ caseFilter: new Set(['b-id']) }));
		expect(outcome.results.map((r) => r.caseId)).toEqual(['b-id']);
		await expect(runSuite(baseOpts({ caseFilter: new Set(['nope']) }))).rejects.toThrow(
			/unknown case id\(s\): nope/,
		);
	});

	it('runCli --case=<id> reaches runSuite as the case filter', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));
		await writeFile(join(casesDir, 'b.case.ts'), oneRoutingCase('b-id'));
		const r = await runCli(['--case=a-id'], baseOpts(), { stdout: () => {} });
		expect(r.outcome!.results.map((x) => x.caseId)).toEqual(['a-id']);
	});
});
