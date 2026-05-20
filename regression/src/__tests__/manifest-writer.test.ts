/**
 * Tests for `buildManifest` + `writeManifest` (REQ-REG-GUI-V2-003).
 * Covers per-case attribution, judge-override signaling, atomic write,
 * bucket-requested derivation, and missing-case error.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	PersonaCase,
	RunResult,
	RunSummary,
	TierModelSnapshot,
} from '@core/types/regression.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, writeManifest } from '../runner/manifest-writer.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'regression-manifest-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const VALID_KEY = 'a'.repeat(64);
const RUN_ID = '550e8400-e29b-41d4-a716-446655440000';
const MODEL_IDS: TierModelSnapshot = {
	fast: 'ollama/gemma3:31b',
	standard: 'anthropic/claude-sonnet-4-6',
	reasoning: null,
};

function makeCase(id: string, bucket: PersonaCase['bucket'] = 'routing'): PersonaCase {
	return {
		id,
		description: `case ${id}`,
		bucket,
		routingTarget: bucket === 'routing' ? 'food-shadow' : undefined,
		coverage: [],
		inputs: [],
		oracle: 'structural',
		budgetUsd: 0.01,
	};
}

function makeResult(id: string, overrides: Partial<RunResult> = {}): RunResult {
	return {
		caseId: id,
		cacheKey: VALID_KEY,
		source: 'fresh',
		verdict: 'pass',
		inputs: [],
		actuals: [],
		oracleVerdicts: [],
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0.001,
		modelIds: MODEL_IDS,
		evaluatedTier: 'fast',
		timestamp: '2026-05-13T12:00:00.000Z',
		durationMs: 100,
		...overrides,
	};
}

const SUMMARY: RunSummary = {
	totalCases: 2,
	pass: 1,
	fail: 1,
	error: 0,
	budgetExceeded: 0,
	routingAccuracy: 0.5,
	routingInputsEvaluated: 2,
	totalCostUsd: 0.002,
	totalDurationMs: 200,
};

describe('buildManifest', () => {
	it('maps each result to a ManifestCaseResult with bucket attribution', () => {
		const r1 = makeResult('case-a');
		const r2 = makeResult('case-b', { verdict: 'fail', source: 'cached', costUsd: 0 });
		const cases = new Map<string, PersonaCase>([
			['case-a', makeCase('case-a')],
			['case-b', makeCase('case-b', 'chatbot')],
		]);
		const manifest = buildManifest({
			runId: RUN_ID,
			startedAt: '2026-05-13T11:59:00.000Z',
			completedAt: '2026-05-13T12:01:00.000Z',
			modelIds: MODEL_IDS,
			judgeOverrideApplied: false,
			bucketsRequested: ['__all__'],
			results: [r1, r2],
			cases,
			summary: SUMMARY,
		});
		expect(manifest.caseResults).toHaveLength(2);
		expect(manifest.caseResults[0]).toMatchObject({
			caseId: 'case-a',
			bucket: 'routing',
			cacheKey: VALID_KEY,
			evaluatedTier: 'fast',
			verdict: 'pass',
			source: 'fresh',
			costUsd: 0.001,
		});
		expect(manifest.caseResults[1]).toMatchObject({
			caseId: 'case-b',
			bucket: 'chatbot',
			verdict: 'fail',
			source: 'cached',
			costUsd: 0,
		});
	});

	it('records judgeOverrideApplied verbatim', () => {
		const cases = new Map([['c', makeCase('c')]]);
		const base = {
			runId: RUN_ID,
			startedAt: 'a',
			completedAt: 'b',
			modelIds: MODEL_IDS,
			bucketsRequested: ['__all__'],
			results: [makeResult('c')],
			cases,
			summary: SUMMARY,
		};
		expect(buildManifest({ ...base, judgeOverrideApplied: true }).judgeOverrideApplied).toBe(true);
		expect(buildManifest({ ...base, judgeOverrideApplied: false }).judgeOverrideApplied).toBe(
			false,
		);
	});

	it('preserves bucketsRequested input verbatim', () => {
		const cases = new Map([['c', makeCase('c')]]);
		const m = buildManifest({
			runId: RUN_ID,
			startedAt: 'a',
			completedAt: 'b',
			modelIds: MODEL_IDS,
			judgeOverrideApplied: false,
			bucketsRequested: ['routing'],
			results: [makeResult('c')],
			cases,
			summary: SUMMARY,
		});
		expect(m.bucketsRequested).toEqual(['routing']);
	});

	it('decodes missing evaluatedTier as "unknown"', () => {
		const cases = new Map([['c', makeCase('c')]]);
		const r = makeResult('c');
		// biome-ignore lint/performance/noDelete: targeted legacy-mode reproduction
		delete (r as Partial<RunResult>).evaluatedTier;
		const m = buildManifest({
			runId: RUN_ID,
			startedAt: 'a',
			completedAt: 'b',
			modelIds: MODEL_IDS,
			judgeOverrideApplied: false,
			bucketsRequested: ['__all__'],
			results: [r],
			cases,
			summary: SUMMARY,
		});
		expect(m.caseResults[0]!.evaluatedTier).toBe('unknown');
	});

	it('throws when a result has no matching PersonaCase entry', () => {
		expect(() =>
			buildManifest({
				runId: RUN_ID,
				startedAt: 'a',
				completedAt: 'b',
				modelIds: MODEL_IDS,
				judgeOverrideApplied: false,
				bucketsRequested: ['__all__'],
				results: [makeResult('orphan')],
				cases: new Map(),
				summary: SUMMARY,
			}),
		).toThrow(/missing PersonaCase for result caseId=orphan/);
	});
});

describe('writeManifest', () => {
	it('writes manifest atomically to <rootDir>/<runId>.json and round-trips', async () => {
		const cases = new Map([['c', makeCase('c')]]);
		const m = buildManifest({
			runId: RUN_ID,
			startedAt: '2026-05-13T11:59:00.000Z',
			completedAt: '2026-05-13T12:01:00.000Z',
			modelIds: MODEL_IDS,
			judgeOverrideApplied: false,
			bucketsRequested: ['__all__'],
			results: [makeResult('c')],
			cases,
			summary: SUMMARY,
		});
		const path = await writeManifest(tempDir, m);
		expect(path).toBe(join(tempDir, `${RUN_ID}.json`));
		const round = JSON.parse(await readFile(path, 'utf8'));
		expect(round.runId).toBe(RUN_ID);
		expect(round.caseResults).toHaveLength(1);
	});

	it('leaves no temp files behind after successful write', async () => {
		const cases = new Map([['c', makeCase('c')]]);
		const m = buildManifest({
			runId: RUN_ID,
			startedAt: 'a',
			completedAt: 'b',
			modelIds: MODEL_IDS,
			judgeOverrideApplied: false,
			bucketsRequested: ['__all__'],
			results: [makeResult('c')],
			cases,
			summary: SUMMARY,
		});
		await writeManifest(tempDir, m);
		const files = await readdir(tempDir);
		expect(files).toEqual([`${RUN_ID}.json`]);
	});
});
