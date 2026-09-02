/**
 * Orchestrator-level dispatch tests for the receipt bucket.
 *
 * These tests exercise the wiring added in Chunk A.2:
 *   - Receipt cases dispatch through `runReceiptCase` with stub `receiptLlm`.
 *   - Missing `receiptLlm` throws when a receipt case is in the filtered set.
 *   - Dry-run never touches `receiptLlm`.
 *   - Cache-hit short-circuits the LLM call entirely.
 *   - The receipt-bucket cache-key salt (today's date + timezone) invalidates
 *     cache on date rollover so the rejection-mode fallback re-exercises.
 *
 * Scaffolding mirrors `orchestrator.test.ts` — temp git repo per test,
 * tiny case file written into a temp casesDir, photo + sidecar staged
 * as real files at /tmp paths.
 */

import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSuite } from '../runner/index.js';
import { VERDICT } from '../shared/types.js';

let repoRoot: string;
let casesDir: string;
let cacheDir: string;
let fixturesDir: string;

const _TYPES_PATH = join(process.cwd(), 'regression/src/shared/types.ts');

const oneRoutingCase = (id: string) => `
const c = {
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

const oneReceiptCase = (id: string, photo: string, sidecar: string) => `
const c = {
  id: '${id}',
  description: '',
  bucket: 'receipt',
  coverage: ['coverage.ts'],
  inputs: [{ payload: { photoFixture: '${photo.replace(/'/g, "\\'")}', sidecarFixture: '${sidecar.replace(/'/g, "\\'")}' }, expected: { kind: 'sidecar' } }],
  oracle: 'structural',
  budgetUsd: 0.05,
};
export default c;
`;

const happyPathReceiptJson = JSON.stringify({
	store: 'TestMart',
	date: '2026-04-15',
	lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
	subtotal: 4.99,
	tax: 0,
	total: 4.99,
});

const happyPathSidecar = JSON.stringify({
	store: 'TestMart',
	date: '2026-04-15',
	total: 4.99,
	lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
});

function makeReceiptLlm(text: string) {
	return {
		complete: vi.fn().mockResolvedValue(text),
		completeWithMeta: vi.fn().mockResolvedValue({ text, finishReason: 'stop' as const }),
	};
}

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

beforeEach(async () => {
	repoRoot = await mkdtemp(join(tmpdir(), 'orch-receipt-repo-'));
	execSync('git init -q', { cwd: repoRoot });
	execSync('git config user.email t@t', { cwd: repoRoot });
	execSync('git config user.name T', { cwd: repoRoot });
	casesDir = join(repoRoot, 'cases');
	await mkdir(casesDir, { recursive: true });
	await writeFile(join(repoRoot, 'coverage.ts'), '// stub coverage file\n');
	cacheDir = await mkdtemp(join(tmpdir(), 'orch-receipt-cache-'));
	fixturesDir = await mkdtemp(join(tmpdir(), 'orch-receipt-fx-'));
});
afterEach(async () => {
	await rm(repoRoot, { recursive: true, force: true });
	await rm(cacheDir, { recursive: true, force: true });
	await rm(fixturesDir, { recursive: true, force: true });
	vi.useRealTimers();
});

describe('runSuite — receipt bucket dispatch', () => {
	it('happy path: receipt case dispatches through runReceiptCase, verdict=pass', async () => {
		const photo = join(fixturesDir, 'p.png');
		const sidecar = join(fixturesDir, 'p.expected.json');
		await writeFile(photo, Buffer.from('FAKE_PNG'));
		await writeFile(sidecar, happyPathSidecar);
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-happy', photo, sidecar));

		const receiptLlm = makeReceiptLlm(happyPathReceiptJson);
		const opts = baseOpts({ receiptLlm, timezone: 'America/New_York' });

		const { results } = await runSuite(opts);
		expect(results).toHaveLength(1);
		expect(results[0]!.caseId).toBe('r-happy');
		expect(results[0]!.verdict).toBe(VERDICT.pass);
		expect(receiptLlm.completeWithMeta).toHaveBeenCalledTimes(1);
	});

	it('throws when receipt case is present and receiptLlm is missing', async () => {
		const photo = join(fixturesDir, 'p.png');
		const sidecar = join(fixturesDir, 'p.expected.json');
		await writeFile(photo, Buffer.from('FAKE_PNG'));
		await writeFile(sidecar, happyPathSidecar);
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-no-llm', photo, sidecar));

		// `receiptLlm` deliberately omitted
		const opts = baseOpts({ timezone: 'UTC' });
		await expect(runSuite(opts)).rejects.toThrow(/receiptLlm.*r-no-llm|r-no-llm.*receiptLlm/i);
	});

	it('dry-run never touches receiptLlm', async () => {
		const photo = join(fixturesDir, 'p.png');
		const sidecar = join(fixturesDir, 'p.expected.json');
		await writeFile(photo, Buffer.from('FAKE_PNG'));
		await writeFile(sidecar, happyPathSidecar);
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-dry', photo, sidecar));

		const receiptLlm = makeReceiptLlm(happyPathReceiptJson);
		const opts = baseOpts({ receiptLlm, dryRun: true });
		const { results } = await runSuite(opts);
		expect(results).toHaveLength(1);
		// Dry-run synthesizes a result without dispatch.
		expect(receiptLlm.complete).not.toHaveBeenCalled();
		expect(receiptLlm.completeWithMeta).not.toHaveBeenCalled();
	});

	it('cache hit: receipt case marked source=cached and LLM never called', async () => {
		const photo = join(fixturesDir, 'p.png');
		const sidecar = join(fixturesDir, 'p.expected.json');
		await writeFile(photo, Buffer.from('FAKE_PNG'));
		await writeFile(sidecar, happyPathSidecar);
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-cache', photo, sidecar));

		const receiptLlm = makeReceiptLlm(happyPathReceiptJson);
		const opts = baseOpts({ receiptLlm, timezone: 'UTC' });

		// First run populates the cache.
		const first = await runSuite(opts);
		expect(first.results[0]!.source).toBe('fresh');
		expect(receiptLlm.completeWithMeta).toHaveBeenCalledTimes(1);

		// Reset call counts; second run with same modelIds + same day MUST cache-hit.
		receiptLlm.complete.mockClear();
		receiptLlm.completeWithMeta.mockClear();
		const second = await runSuite(opts);
		expect(second.results[0]!.source).toBe('cached');
		expect(receiptLlm.complete).not.toHaveBeenCalled();
		expect(receiptLlm.completeWithMeta).not.toHaveBeenCalled();
	});

	// Cache-key date salt for receipts: same-day reruns still hit cache;
	// date rollover (different `today`) invalidates so the rejection-mode
	// fallback re-exercises.
	it('date-salt invalidation: cache hit same day, cache miss next day', async () => {
		const photo = join(fixturesDir, 'p.png');
		const sidecar = join(fixturesDir, 'p.expected.json');
		await writeFile(photo, Buffer.from('FAKE_PNG'));
		await writeFile(sidecar, happyPathSidecar);
		await writeFile(join(casesDir, 'r.case.ts'), oneReceiptCase('r-salt', photo, sidecar));

		// Fix the clock to 2026-05-15 UTC for the first run.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));

		const receiptLlm = makeReceiptLlm(happyPathReceiptJson);
		const opts = baseOpts({ receiptLlm, timezone: 'UTC' });

		const firstRun = await runSuite(opts);
		expect(firstRun.results[0]!.source).toBe('fresh');
		expect(receiptLlm.completeWithMeta).toHaveBeenCalledTimes(1);

		// Same day: cache hit.
		receiptLlm.completeWithMeta.mockClear();
		vi.setSystemTime(new Date('2026-05-15T23:59:00Z'));
		const sameDay = await runSuite(opts);
		expect(sameDay.results[0]!.source).toBe('cached');
		expect(receiptLlm.completeWithMeta).not.toHaveBeenCalled();

		// Next day: cache miss because the date-salt component changed.
		receiptLlm.completeWithMeta.mockClear();
		vi.setSystemTime(new Date('2026-05-16T00:01:00Z'));
		const nextDay = await runSuite(opts);
		expect(nextDay.results[0]!.source).toBe('fresh');
		expect(receiptLlm.completeWithMeta).toHaveBeenCalledTimes(1);
	});

	// Sanity: routing buckets keep their existing cache-key behavior (no salt).
	// If we accidentally applied the receipt salt to non-receipt cases, routing
	// cache hits across days would break — this guards against that.
	it('non-receipt buckets do not use the date salt (routing case still cache-hits next day)', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), oneRoutingCase('a-id'));

		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));
		const opts = baseOpts({ timezone: 'UTC' });

		const first = await runSuite(opts);
		expect(first.results[0]!.source).toBe('fresh');

		vi.setSystemTime(new Date('2026-05-16T12:00:00Z'));
		const second = await runSuite(opts);
		expect(second.results[0]!.source).toBe('cached');
	});
});

/**
 * Receipt-bucket cost metering + run-budget enforcement.
 *
 * Before this suite existed, `runReceiptCase` derived `RunResult.costUsd`
 * from a projection built with `{tokenIn: 0, tokenOut: 0}` — structurally $0
 * for every model. Every receipt case therefore reported `costUsd: 0` despite
 * genuine remote spend, and `runBudget.add(0)` meant the whole-run ceiling
 * could never stop a receipt sweep no matter how long it ran.
 */
describe('runSuite — receipt bucket cost metering + run budget', () => {
	/** CostTracker stand-in whose totals advance on every metered dispatch. */
	function chargingMeter(perCallUsd: number, perCallTokens = { input: 2165, output: 976 }) {
		let cost = 0;
		let input = 0;
		let output = 0;
		return {
			charge: () => {
				cost += perCallUsd;
				input += perCallTokens.input;
				output += perCallTokens.output;
			},
			getMonthlyTotalCost: () => cost,
			getTokenUsageTotals: () => ({ input, output }),
		};
	}

	function chargingReceiptLlm(meter: { charge: () => void }, text: string) {
		const complete = vi.fn().mockImplementation(async () => {
			meter.charge();
			return text;
		});
		const completeWithMeta = vi.fn().mockImplementation(async () => {
			meter.charge();
			return { text, finishReason: 'stop' as const };
		});
		return { complete, completeWithMeta };
	}

	async function stageReceiptCases(ids: readonly string[]): Promise<void> {
		const photo = join(fixturesDir, 'p.png');
		const sidecar = join(fixturesDir, 'p.expected.json');
		await writeFile(photo, Buffer.from('FAKE_PNG'));
		await writeFile(sidecar, happyPathSidecar);
		for (const id of ids) {
			await writeFile(join(casesDir, `${id}.case.ts`), oneReceiptCase(id, photo, sidecar));
		}
	}

	it('records the real CostTracker delta, not the pre-charge projection', async () => {
		await stageReceiptCases(['r-cost']);
		const meter = chargingMeter(0.021);
		const receiptLlm = chargingReceiptLlm(meter, happyPathReceiptJson);

		const { results, summary } = await runSuite(
			baseOpts({
				receiptLlm,
				costTracker: meter,
				timezone: 'America/New_York',
				// A deliberately WRONG projection: if the runner charged the
				// projection instead of the delta, cost would be 0.004, not 0.021.
				estimateUsd: () => 0.004,
			}),
		);

		expect(results).toHaveLength(1);
		expect(results[0]!.verdict).toBe(VERDICT.pass);
		expect(results[0]!.costUsd).toBeCloseTo(0.021, 6);
		expect(results[0]!.tokenCounts).toEqual({ input: 2165, output: 976 });
		expect(summary.totalCostUsd).toBeCloseTo(0.021, 6);
	});

	it('reports $0 for a receipt case whose model never bills (all-local run)', async () => {
		await stageReceiptCases(['r-local']);
		// A local model's CostTracker delta is genuinely zero — the meter never
		// advances — so $0 here is a measurement, not the old structural zero.
		const meter = chargingMeter(0);
		const receiptLlm = chargingReceiptLlm(meter, happyPathReceiptJson);

		const { results } = await runSuite(
			baseOpts({
				receiptLlm,
				costTracker: meter,
				timezone: 'America/New_York',
				estimateUsd: () => 0,
			}),
		);
		expect(results[0]!.verdict).toBe(VERDICT.pass);
		expect(results[0]!.costUsd).toBe(0);
		expect(receiptLlm.completeWithMeta).toHaveBeenCalledTimes(1);
	});

	it('run-budget ceiling aborts a receipt sweep once accumulated spend exceeds it', async () => {
		await stageReceiptCases(['r-a', 'r-b', 'r-c']);
		// Ceiling $0.06; each case really bills $0.03; per-case pre-flight
		// estimate $0.02.
		//   case 1 → canAfford(0.02) with 0.00 spent ✓ → spends 0.03
		//   case 2 → canAfford(0.02) with 0.03 spent ✓ → spends 0.06
		//   case 3 → 0.06 + 0.02 > 0.06 ✗ → budget-exceeded, no dispatch
		// With the old always-$0 accounting all three would have dispatched.
		const meter = chargingMeter(0.03);
		const receiptLlm = chargingReceiptLlm(meter, happyPathReceiptJson);

		const { results } = await runSuite(
			baseOpts({
				receiptLlm,
				costTracker: meter,
				timezone: 'America/New_York',
				maxRunBudgetUsd: 0.06,
				estimateUsd: () => 0.02,
			}),
		);

		expect(results).toHaveLength(3);
		const skipped = results.filter((r) => r.verdict === VERDICT.budgetExceeded);
		expect(skipped).toHaveLength(1);
		expect(receiptLlm.completeWithMeta).toHaveBeenCalledTimes(2);
		// The skipped case carries one synthetic error verdict per input so
		// downstream gates count it rather than silently ignoring it.
		expect(skipped[0]!.oracleVerdicts).toHaveLength(1);
		expect(skipped[0]!.oracleVerdicts[0]!.verdict).toBe(VERDICT.error);
	});
});
