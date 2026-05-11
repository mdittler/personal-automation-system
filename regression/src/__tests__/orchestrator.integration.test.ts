/**
 * Production-wiring integration test (testing-standards rule 5).
 *
 * Runs `runSuite()` against a temp git repo with a real `food-shadow`
 * routing case, using the **real** `buildClassifierAdapters` →
 * `FoodShadowClassifier` → adapter contract. Only the LLM provider is
 * stubbed (via `StubLLMService`); everything else — case loader,
 * structural oracle, cache, budget, summary — runs production code.
 *
 * This catches integration bugs that the per-component unit tests
 * (with mocked adapters) miss.
 */

import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClassifierAdapters, type CostMeterSource } from '../runner/dispatch.js';
import { runSuite } from '../runner/index.js';
import { StubLLMService } from './_stub-provider.js';

const TYPES_PATH = join(process.cwd(), 'regression/src/shared/types.ts');

let repoRoot: string;
let casesDir: string;
let cacheDir: string;

beforeEach(async () => {
	repoRoot = await mkdtemp(join(tmpdir(), 'orch-int-repo-'));
	execSync('git init -q', { cwd: repoRoot });
	execSync('git config user.email t@t', { cwd: repoRoot });
	execSync('git config user.name T', { cwd: repoRoot });
	casesDir = join(repoRoot, 'cases');
	await mkdir(casesDir, { recursive: true });
	await writeFile(join(repoRoot, 'coverage.ts'), '// stub coverage file\n');
	cacheDir = await mkdtemp(join(tmpdir(), 'orch-int-cache-'));
});
afterEach(async () => {
	await rm(repoRoot, { recursive: true, force: true });
	await rm(cacheDir, { recursive: true, force: true });
});

const foodShadowCase = `
import type { PersonaCase } from '${TYPES_PATH.replace(/'/g, "\\'")}';
const c: PersonaCase = {
  id: 'integration-food-save-recipe',
  description: 'food-shadow integration test',
  bucket: 'routing',
  routingTarget: 'food-shadow',
  coverage: ['coverage.ts'],
  inputs: [{
    payload: 'save this recipe',
    expected: {
      schema: {
        type: 'object',
        required: ['action', 'confidence'],
        properties: { action: { type: 'string' }, confidence: { type: 'number' } },
      },
      strings: [{ path: 'action', expectedCaseInsensitive: 'user wants to save a recipe' }],
    },
  }],
  oracle: 'structural',
  budgetUsd: 0.05,
};
export default c;
`;

function queuedCostTracker(values: number[]): CostMeterSource {
	const queue = [...values];
	return {
		getMonthlyTotalCost(): number {
			const v = queue.shift();
			if (v === undefined) throw new Error('cost tracker queue empty');
			return v;
		},
	};
}

const logger = {
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
};

describe('orchestrator integration — real classifier path', () => {
	it('dispatches a food-shadow case through FoodShadowClassifier with StubLLMService', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), foodShadowCase);

		const stubLLM = new StubLLMService();
		// FoodShadowClassifier.classify will call llm.complete and JSON-parse the result.
		stubLLM.queue(
			JSON.stringify({ action: 'user wants to save a recipe', confidence: 0.92 }),
		);
		const costTracker = queuedCostTracker([1.0, 1.0001]);

		const classifiers = buildClassifierAdapters({
			llm: stubLLM as never,
			logger,
			costTracker,
			modelIds: { fast: 'stub-fast', standard: 'stub-standard', reasoning: null },
		});

		const outcome = await runSuite({
			casesDir,
			cacheDir,
			repoRoot,
			modelIds: { fast: 'stub-fast', standard: 'stub-standard', reasoning: null },
			maxRunBudgetUsd: 5.0,
			estimateUsd: () => 0.0001,
			classifiers,
			logger,
		});

		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]!.verdict).toBe('pass');
		expect(outcome.results[0]!.source).toBe('fresh');
		expect(outcome.results[0]!.costUsd).toBeCloseTo(0.0001, 7);
		expect(stubLLM.calls).toBe(1);
	});

	it('integration: parse-failed LLM output surfaces as verdict=error', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), foodShadowCase);

		const stubLLM = new StubLLMService();
		stubLLM.queue('I think the user wants to save a recipe but I am not sure');
		const costTracker = queuedCostTracker([1.0, 1.0001]);

		const classifiers = buildClassifierAdapters({
			llm: stubLLM as never,
			logger,
			costTracker,
			modelIds: { fast: 'stub-fast', standard: 'stub-standard', reasoning: null },
		});

		const outcome = await runSuite({
			casesDir,
			cacheDir,
			repoRoot,
			modelIds: { fast: 'stub-fast', standard: 'stub-standard', reasoning: null },
			maxRunBudgetUsd: 5.0,
			estimateUsd: () => 0.0001,
			classifiers,
			logger,
		});

		// Non-JSON LLM output → FoodShadowClassifier returns kind='parse-failed' →
		// adapter surfaces raw string → structural oracle returns verdict='error'
		// (non-parseable JSON per spec line 180). The runner records error and
		// the REQ-REG-011 gate counts it against accuracy.
		expect(outcome.results[0]!.verdict).toBe('error');
		expect(stubLLM.calls).toBe(1);
	});

	it('integration: cache hit on second run with no LLM call', async () => {
		await writeFile(join(casesDir, 'a.case.ts'), foodShadowCase);

		const stubLLM = new StubLLMService();
		stubLLM.queue(
			JSON.stringify({ action: 'user wants to save a recipe', confidence: 0.92 }),
		);
		const costTracker = queuedCostTracker([1.0, 1.0001]);

		const classifiers = buildClassifierAdapters({
			llm: stubLLM as never,
			logger,
			costTracker,
			modelIds: { fast: 'stub-fast', standard: 'stub-standard', reasoning: null },
		});

		const opts = {
			casesDir,
			cacheDir,
			repoRoot,
			modelIds: { fast: 'stub-fast', standard: 'stub-standard', reasoning: null },
			maxRunBudgetUsd: 5.0,
			estimateUsd: () => 0.0001,
			classifiers,
			logger,
		};

		const first = await runSuite(opts);
		expect(first.results[0]!.source).toBe('fresh');
		expect(stubLLM.calls).toBe(1);

		// Build a new adapter set for the second run (a fresh cost tracker).
		const classifiers2 = buildClassifierAdapters({
			llm: stubLLM as never,
			logger,
			costTracker: queuedCostTracker([1.0001, 1.0001]),
			modelIds: opts.modelIds,
		});
		const second = await runSuite({ ...opts, classifiers: classifiers2 });
		expect(second.results[0]!.source).toBe('cached');
		expect(stubLLM.calls).toBe(1); // no new call
	});
});
