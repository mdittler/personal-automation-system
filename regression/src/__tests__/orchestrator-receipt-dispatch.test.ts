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

let repoRoot: string;
let casesDir: string;
let cacheDir: string;
let fixturesDir: string;

const TYPES_PATH = join(process.cwd(), 'regression/src/shared/types.ts');

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
		completeWithMeta: vi
			.fn()
			.mockResolvedValue({ text, finishReason: 'stop' as const }),
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
		expect(results[0]!.verdict).toBe('pass');
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
