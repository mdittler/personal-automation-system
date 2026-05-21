/**
 * Tests for `createWeaknessSummarizer` (REQ-REG-GUI-V2-018/019).
 * - Idempotent on retry (skip if file exists).
 * - `force=true` regenerates.
 * - Zero LLM calls when there are no failing cases (Codex #12).
 * - Standard tier + responseFormat: 'json'.
 * - Single retry on empty output.
 * - Malformed LLM output → status: 'error' (Codex #11).
 * - Drops fabricated case IDs (Codex #11).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMService } from '../../../../types/llm.js';
import type { RunManifest, RunResult } from '../../../../types/regression.js';
import { VERDICT } from '../../../../types/regression.js';
import { createWeaknessSummarizer } from '../weakness-summarizer.js';

const silentLogger = pino({ level: 'silent' });
let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'weakness-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const RUN_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_KEY = 'a'.repeat(64);

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
	return {
		runId: RUN_ID,
		startedAt: '2026-05-13T11:00:00.000Z',
		completedAt: '2026-05-13T12:00:00.000Z',
		modelIds: {
			fast: 'ollama/gemma3:31b',
			standard: 'anthropic/claude-sonnet-4-6',
			reasoning: null,
		},
		judgeOverrideApplied: false,
		bucketsRequested: ['__all__'],
		caseResults: [
			{
				caseId: 'failing-case',
				bucket: 'routing',
				cacheKey: VALID_KEY,
				evaluatedTier: 'fast',
				verdict: VERDICT.fail,
				source: 'fresh',
				costUsd: 0.001,
				timestamp: '2026-05-13T11:30:00.000Z',
			},
		],
		summary: {
			totalCases: 1,
			pass: 0,
			fail: 1,
			error: 0,
			budgetExceeded: 0,
			routingAccuracy: 0,
			routingInputsEvaluated: 1,
			totalCostUsd: 0.001,
			totalDurationMs: 100,
		},
		...overrides,
	};
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		caseId: 'failing-case',
		cacheKey: VALID_KEY,
		source: 'fresh',
		verdict: VERDICT.fail,
		inputs: [{ payload: 'show me my macros', expected: { intent: 'macro-targets' } }],
		actuals: [{ intent: 'data-query' }],
		oracleVerdicts: [{ verdict: VERDICT.fail, details: 'expected macro-targets, got data-query' }],
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0.001,
		modelIds: {
			fast: 'ollama/gemma3:31b',
			standard: 'anthropic/claude-sonnet-4-6',
			reasoning: null,
		},
		evaluatedTier: 'fast',
		timestamp: '2026-05-13T11:30:00.000Z',
		durationMs: 100,
		...overrides,
	};
}

async function seedCacheFile(
	cacheDir: string,
	caseId: string,
	cacheKey: string,
	result: RunResult,
): Promise<void> {
	const dir = join(cacheDir, caseId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${cacheKey}.json`), JSON.stringify({ result }, null, 2));
}

interface Harness {
	manifestDir: string;
	cacheDir: string;
	summaryDir: string;
	llm: { complete: ReturnType<typeof vi.fn> };
}

async function makeHarness(): Promise<Harness> {
	const manifestDir = join(tempDir, 'runs');
	const cacheDir = join(tempDir, 'cache');
	const summaryDir = join(tempDir, 'summaries');
	await mkdir(manifestDir, { recursive: true });
	await mkdir(cacheDir, { recursive: true });
	const llm = {
		complete: vi.fn().mockResolvedValue(
			JSON.stringify({
				summary: 'Mis-routes macro questions to generic data-query.',
				failureCategories: [
					{
						label: 'macro-related queries mis-routed',
						count: 1,
						exampleCaseIds: ['failing-case'],
					},
				],
			}),
		),
	};
	return { manifestDir, cacheDir, summaryDir, llm };
}

describe('createWeaknessSummarizer — happy path', () => {
	it('writes structured JSON when LLM returns a valid summary', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		const out = await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(out.status).toBe('ready');
		expect(out.hadFailures).toBe(true);
		expect(out.failureCategories).toHaveLength(1);
		expect(out.failureCategories?.[0]?.exampleCaseIds).toEqual(['failing-case']);
		expect(out.modelId).toBe('ollama/gemma3:31b');
	});

	it('persists the result to <summaryDir>/<runId>/<tier>.json', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		const onDisk = JSON.parse(await readFile(summarizer.pathFor(RUN_ID, 'fast'), 'utf8'));
		expect(onDisk.runId).toBe(RUN_ID);
		expect(onDisk.tier).toBe('fast');
		expect(onDisk.status).toBe('ready');
	});
});

describe('createWeaknessSummarizer — LLM call discipline (Codex #12)', () => {
	it('makes exactly ONE LLM call for a run with failing inputs', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(h.llm.complete).toHaveBeenCalledTimes(1);
	});

	it('makes ZERO LLM calls when the tier has no failing inputs', async () => {
		const h = await makeHarness();
		const noFailManifest = makeManifest({
			caseResults: [
				{
					caseId: 'passing-case',
					bucket: 'routing',
					cacheKey: VALID_KEY,
					evaluatedTier: 'fast',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0.001,
					timestamp: '2026-05-13T11:30:00.000Z',
				},
			],
		});
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		const out = await summarizer.summarize({ manifest: noFailManifest, tier: 'fast' });
		expect(h.llm.complete).not.toHaveBeenCalled();
		expect(out.status).toBe('no-failures');
		expect(out.hadFailures).toBe(false);
	});

	it('makes ZERO LLM calls on a second invocation (idempotent default)', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(h.llm.complete).toHaveBeenCalledTimes(1);
	});

	it('force=true makes a fresh LLM call even if a summary file exists', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		await summarizer.summarize({ manifest: makeManifest(), tier: 'fast', force: true });
		expect(h.llm.complete).toHaveBeenCalledTimes(2);
	});

	it('calls LLM at standard tier with responseFormat: json', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		const lastCallOpts = h.llm.complete.mock.calls[0]![1];
		expect(lastCallOpts.tier).toBe('standard');
		expect(lastCallOpts.responseFormat).toBe('json');
	});

	it('retries once on empty LLM output (Batch 1/2 pattern)', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		h.llm.complete
			.mockResolvedValueOnce('') // first call empty
			.mockResolvedValueOnce(
				JSON.stringify({
					summary: 'retry-recovered summary',
					failureCategories: [{ label: 'lbl', count: 1, exampleCaseIds: ['failing-case'] }],
				}),
			);
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		const out = await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(h.llm.complete).toHaveBeenCalledTimes(2);
		expect(out.status).toBe('ready');
		expect(out.summary).toBe('retry-recovered summary');
	});
});

describe('createWeaknessSummarizer — robustness', () => {
	it('records status: "error" on malformed LLM JSON', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		h.llm.complete.mockResolvedValue('this is not json at all');
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		const out = await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(out.status).toBe('error');
		expect(out.errorMessage).toBeDefined();
		expect(out.llmRawOutput).toBe('this is not json at all');
	});

	it('records status: "error" when the missing summary field violates the schema', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		h.llm.complete.mockResolvedValue(JSON.stringify({ failureCategories: [] }));
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		const out = await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(out.status).toBe('error');
	});

	it('drops fabricated case IDs from LLM output (Codex #11)', async () => {
		const h = await makeHarness();
		await seedCacheFile(h.cacheDir, 'failing-case', VALID_KEY, makeRunResult());
		h.llm.complete.mockResolvedValue(
			JSON.stringify({
				summary: 'has fabricated id',
				failureCategories: [
					{
						label: 'lbl',
						count: 1,
						exampleCaseIds: ['failing-case', 'this-case-never-existed'],
					},
				],
			}),
		);
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		const out = await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(out.failureCategories?.[0]?.exampleCaseIds).toEqual(['failing-case']);
	});

	it('records status: "error" when every failing-case cache file is missing', async () => {
		const h = await makeHarness();
		// No cache files written.
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		const out = await summarizer.summarize({ manifest: makeManifest(), tier: 'fast' });
		expect(out.status).toBe('error');
		expect(h.llm.complete).not.toHaveBeenCalled();
	});

	it('read() returns null when no summary has been persisted', async () => {
		const h = await makeHarness();
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
		});
		expect(await summarizer.read(RUN_ID, 'fast')).toBeNull();
	});

	it('truncates failing-cases payload to maxFailingInputs', async () => {
		const h = await makeHarness();
		const manyFailing = makeManifest({
			caseResults: Array.from({ length: 30 }, (_, i) => ({
				caseId: `failing-${i}`,
				bucket: 'routing' as const,
				cacheKey: VALID_KEY,
				evaluatedTier: 'fast' as const,
				verdict: VERDICT.fail as const,
				source: 'fresh' as const,
				costUsd: 0.001,
				timestamp: '2026-05-13T11:30:00.000Z',
			})),
		});
		for (let i = 0; i < 30; i++) {
			await seedCacheFile(
				h.cacheDir,
				`failing-${i}`,
				VALID_KEY,
				makeRunResult({ caseId: `failing-${i}` }),
			);
		}
		h.llm.complete.mockResolvedValue(
			JSON.stringify({
				summary: 'truncation test',
				failureCategories: [{ label: 'lbl', count: 20, exampleCaseIds: ['failing-0'] }],
			}),
		);
		const summarizer = createWeaknessSummarizer({
			...h,
			llm: h.llm as unknown as LLMService,
			logger: silentLogger,
			maxFailingInputs: 5,
		});
		await summarizer.summarize({ manifest: manyFailing, tier: 'fast' });
		const prompt = h.llm.complete.mock.calls[0]![0];
		// Only the first 5 failing-N case ids should appear in the prompt.
		for (let i = 0; i < 5; i++) {
			expect(prompt).toContain(`failing-${i}`);
		}
		expect(prompt).not.toContain('failing-29');
	});
});
