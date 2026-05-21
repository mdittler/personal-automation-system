/**
 * Tests for `createRunHistoryStore` (REQ-REG-GUI-V2-004).
 * - Reads manifests with strict validation; rejects malformed shapes.
 * - `list` sorts by completedAt desc; honors `since`, `tier`, `modelId`, `limit`.
 * - `latestPerTierAndModel` keys by `${tier}:${modelId}` and returns the
 *   newest manifest per key.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunManifest } from '../../../../types/regression.js';
import { VERDICT } from '../../../../types/regression.js';
import { createRunHistoryStore, tierModelKeys } from '../run-history-store.js';

const silentLogger = pino({ level: 'silent' });
let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'rhs-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
	const runId = overrides.runId ?? '550e8400-e29b-41d4-a716-446655440000';
	return {
		runId,
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
				caseId: 'c1',
				bucket: 'routing',
				cacheKey: 'a'.repeat(64),
				evaluatedTier: 'fast',
				verdict: VERDICT.pass,
				source: 'fresh',
				costUsd: 0.001,
				timestamp: '2026-05-13T11:30:00.000Z',
			},
		],
		summary: {
			totalCases: 1,
			pass: 1,
			fail: 0,
			error: 0,
			budgetExceeded: 0,
			routingAccuracy: 1,
			routingInputsEvaluated: 1,
			totalCostUsd: 0.001,
			totalDurationMs: 100,
		},
		...overrides,
	};
}

async function writeManifestFile(dir: string, m: RunManifest): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${m.runId}.json`), JSON.stringify(m, null, 2));
}

describe('createRunHistoryStore — happy path', () => {
	it('returns empty list when the manifests directory does not exist', async () => {
		const store = createRunHistoryStore({
			rootDir: join(tempDir, 'does-not-exist'),
			logger: silentLogger,
		});
		expect(await store.list()).toEqual([]);
	});

	it('round-trips a written manifest via list and getById', async () => {
		const m = makeManifest();
		await writeManifestFile(tempDir, m);
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		const all = await store.list();
		expect(all).toHaveLength(1);
		expect(all[0]!.runId).toBe(m.runId);
		expect(await store.getById(m.runId)).toEqual(m);
	});

	it('returns null on getById for non-UUID or missing id', async () => {
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		expect(await store.getById('not-a-uuid')).toBeNull();
		expect(await store.getById('00000000-0000-4000-8000-000000000000')).toBeNull();
	});

	it('sorts list() by completedAt descending', async () => {
		const a = makeManifest({
			runId: 'aaaaaaaa-0000-4000-8000-000000000001',
			completedAt: '2026-05-13T10:00:00.000Z',
		});
		const b = makeManifest({
			runId: 'bbbbbbbb-0000-4000-8000-000000000002',
			completedAt: '2026-05-13T12:00:00.000Z',
		});
		await writeManifestFile(tempDir, a);
		await writeManifestFile(tempDir, b);
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		const list = await store.list();
		expect(list.map((m) => m.runId)).toEqual([b.runId, a.runId]);
	});
});

describe('createRunHistoryStore — filters', () => {
	beforeEach(async () => {
		const newer = makeManifest({
			runId: '11111111-0000-4000-8000-000000000001',
			completedAt: '2026-05-13T12:00:00.000Z',
			modelIds: {
				fast: 'ollama/gemma3:31b',
				standard: 'anthropic/claude-sonnet-4-6',
				reasoning: null,
			},
		});
		const older = makeManifest({
			runId: '22222222-0000-4000-8000-000000000002',
			completedAt: '2026-05-13T08:00:00.000Z',
			modelIds: {
				fast: 'ollama/gemma3:e4b',
				standard: 'anthropic/claude-haiku-4-5-20251001',
				reasoning: null,
			},
		});
		await writeManifestFile(tempDir, newer);
		await writeManifestFile(tempDir, older);
	});

	it('since=<iso> drops older manifests', async () => {
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		const out = await store.list({ since: '2026-05-13T10:00:00.000Z' });
		expect(out).toHaveLength(1);
		expect(out[0]!.runId).toBe('11111111-0000-4000-8000-000000000001');
	});

	it('tier+modelId narrows to manifests where that slot equals that model', async () => {
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		const out = await store.list({ tier: 'fast', modelId: 'ollama/gemma3:e4b' });
		expect(out.map((m) => m.runId)).toEqual(['22222222-0000-4000-8000-000000000002']);
	});

	it('limit truncates after sort', async () => {
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		const out = await store.list({ limit: 1 });
		expect(out).toHaveLength(1);
		expect(out[0]!.runId).toBe('11111111-0000-4000-8000-000000000001');
	});
});

describe('createRunHistoryStore — robustness', () => {
	it('skips a file with wrong runId in body (manifest filename mismatch)', async () => {
		const m = makeManifest({ runId: 'aaaaaaaa-0000-4000-8000-000000000001' });
		const wrongPath = join(tempDir, 'bbbbbbbb-0000-4000-8000-000000000002.json');
		await mkdir(tempDir, { recursive: true });
		await writeFile(wrongPath, JSON.stringify(m));
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		expect(await store.list()).toEqual([]);
	});

	it('skips a manifest with malformed JSON', async () => {
		await mkdir(tempDir, { recursive: true });
		await writeFile(join(tempDir, '11111111-0000-4000-8000-000000000001.json'), '{ not valid json');
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		expect(await store.list()).toEqual([]);
	});

	it('skips a manifest with malformed caseResults shape', async () => {
		const bad = makeManifest({ runId: 'aaaaaaaa-0000-4000-8000-000000000003' });
		// biome-ignore lint/suspicious/noExplicitAny: intentional malformed-shape test
		(bad as any).caseResults[0].verdict = 'totally-invalid';
		await writeManifestFile(tempDir, bad);
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		expect(await store.list()).toEqual([]);
	});

	it('ignores non-UUID JSON files in the directory', async () => {
		await mkdir(tempDir, { recursive: true });
		await writeFile(join(tempDir, 'hello-world.json'), '{}');
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		expect(await store.list()).toEqual([]);
	});
});

describe('latestPerTierAndModel', () => {
	it('returns the newest manifest per (tier, modelId) key (Codex P2 #5: keyed by evaluated tier only)', async () => {
		// Both runs have fast- AND standard-tier caseResults so both keys appear.
		const both = (runId: string, completedAt: string): RunManifest =>
			makeManifest({
				runId,
				completedAt,
				modelIds: {
					fast: 'ollama/gemma3:31b',
					standard: 'anthropic/claude-sonnet-4-6',
					reasoning: null,
				},
				caseResults: [
					{
						caseId: 'c1',
						bucket: 'routing',
						cacheKey: 'a'.repeat(64),
						evaluatedTier: 'fast',
						verdict: VERDICT.pass,
						source: 'fresh',
						costUsd: 0.001,
						timestamp: completedAt,
					},
					{
						caseId: 'c2',
						bucket: 'chatbot',
						cacheKey: 'b'.repeat(64),
						evaluatedTier: 'standard',
						verdict: VERDICT.pass,
						source: 'fresh',
						costUsd: 0.002,
						timestamp: completedAt,
					},
				],
			});
		const older = both('11111111-0000-4000-8000-000000000001', '2026-05-13T08:00:00.000Z');
		const newer = both('22222222-0000-4000-8000-000000000002', '2026-05-13T12:00:00.000Z');
		await writeManifestFile(tempDir, older);
		await writeManifestFile(tempDir, newer);
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		const map = await store.latestPerTierAndModel();
		expect(map.get('fast:ollama/gemma3:31b')?.runId).toBe(newer.runId);
		expect(map.get('standard:anthropic/claude-sonnet-4-6')?.runId).toBe(newer.runId);
	});

	it('routing-only run does NOT expose a standard:<model> key (Codex P2 #5)', async () => {
		const routingOnly = makeManifest({
			runId: '33333333-0000-4000-8000-000000000003',
			caseResults: [
				{
					caseId: 'c1',
					bucket: 'routing',
					cacheKey: 'a'.repeat(64),
					evaluatedTier: 'fast',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0.001,
					timestamp: '2026-05-13T11:00:00.000Z',
				},
			],
		});
		await writeManifestFile(tempDir, routingOnly);
		const store = createRunHistoryStore({ rootDir: tempDir, logger: silentLogger });
		const map = await store.latestPerTierAndModel();
		expect(map.has('fast:ollama/gemma3:31b')).toBe(true);
		expect(map.has('standard:anthropic/claude-sonnet-4-6')).toBe(false);
	});
});

describe('tierModelKeys (Codex P2 #5 — evaluated tiers only)', () => {
	it('returns keys only for tiers with at least one evaluated caseResult', () => {
		// Routing-only run: one case with evaluatedTier='fast'. Even though the
		// modelIds snapshot also records a standard model, it didn't run any
		// standard-tier cases, so 'standard:...' must NOT appear.
		const m = makeManifest({
			caseResults: [
				{
					caseId: 'c1',
					bucket: 'routing',
					cacheKey: 'a'.repeat(64),
					evaluatedTier: 'fast',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0.001,
					timestamp: '2026-05-13T11:30:00.000Z',
				},
			],
		});
		expect(tierModelKeys(m)).toEqual(['fast:ollama/gemma3:31b']);
	});

	it('returns multiple keys when multiple tiers participated', () => {
		const m = makeManifest({
			modelIds: { fast: 'f', standard: 's', reasoning: 'r' },
			caseResults: [
				{
					caseId: 'c1',
					bucket: 'routing',
					cacheKey: 'a'.repeat(64),
					evaluatedTier: 'fast',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0.001,
					timestamp: '2026-05-13T11:30:00.000Z',
				},
				{
					caseId: 'c2',
					bucket: 'chatbot',
					cacheKey: 'b'.repeat(64),
					evaluatedTier: 'standard',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0.002,
					timestamp: '2026-05-13T11:31:00.000Z',
				},
				{
					caseId: 'c3',
					bucket: 'recall',
					cacheKey: 'c'.repeat(64),
					evaluatedTier: 'reasoning',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0.003,
					timestamp: '2026-05-13T11:32:00.000Z',
				},
			],
		});
		expect(tierModelKeys(m).sort()).toEqual(['fast:f', 'reasoning:r', 'standard:s']);
	});

	it('skips reasoning when participated but modelIds.reasoning is null', () => {
		const m = makeManifest({
			caseResults: [
				{
					caseId: 'c1',
					bucket: 'routing',
					cacheKey: 'a'.repeat(64),
					evaluatedTier: 'reasoning', // tier participated but no model recorded
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0,
					timestamp: '2026-05-13T11:30:00.000Z',
				},
			],
		});
		expect(tierModelKeys(m)).toEqual([]);
	});

	it('skips mixed and unknown evaluatedTier entries', () => {
		const m = makeManifest({
			caseResults: [
				{
					caseId: 'c1',
					bucket: 'routing',
					cacheKey: 'a'.repeat(64),
					evaluatedTier: 'mixed',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0,
					timestamp: '2026-05-13T11:30:00.000Z',
				},
				{
					caseId: 'c2',
					bucket: 'routing',
					cacheKey: 'b'.repeat(64),
					evaluatedTier: 'unknown',
					verdict: VERDICT.pass,
					source: 'fresh',
					costUsd: 0,
					timestamp: '2026-05-13T11:30:00.000Z',
				},
			],
		});
		expect(tierModelKeys(m)).toEqual([]);
	});
});
