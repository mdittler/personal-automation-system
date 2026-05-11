/**
 * Tests for the `--list` CLI mode (Chunk B.2 Codex C5 + I3 + I4).
 *
 * --list emits one `{type:'case-list-entry', ...}` NDJSON line per case,
 * then a terminating `{type:'case-list-end', totalCases, modelIds}` line.
 * The entry carries enough metadata for the GUI to render a never-run
 * drilldown (inputs + expected + oracle + budgetUsd + coverage +
 * currentCacheKey). No dispatch happens — classifiers are throwing stubs.
 */

import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TierModelSnapshot } from '@core/types/regression.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunCliDeps, runCli } from '../runner/index.js';

let tempDir: string;
let casesDir: string;
let cacheDir: string;

const MODEL_IDS: TierModelSnapshot = {
	fast: 'fast-model-x',
	standard: 'standard-model-y',
	reasoning: null,
};

const SAMPLE_CASE_SRC = `
import type { PersonaCase } from '@core/types/regression.js';
const c: PersonaCase = {
  id: 'demo-case-a',
  description: 'demo case for list mode',
  bucket: 'routing',
  routingTarget: 'food-shadow',
  coverage: ['regression/src/__tests__/list-mode.test.ts'],
  inputs: [
    { label: 'i1', payload: 'hello', expected: { intent: 'save-recipe' } },
    { label: 'i2', payload: 'world', expected: { intent: 'pantry-add' } },
  ],
  oracle: 'structural',
  budgetUsd: 0.05,
};
export default c;
`;

function buildListDeps(): RunCliDeps {
	const logger = pino({ level: 'silent' });
	const throwOnDispatch = (): never => {
		throw new Error('classifier invoked — list mode should never dispatch');
	};
	return {
		casesDir,
		cacheDir,
		repoRoot: tempDir,
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

interface CaseListLine {
	type?: string;
	caseId?: string;
	bucket?: string;
	routingTarget?: string;
	description?: string;
	oracle?: string;
	budgetUsd?: number;
	coverage?: string[];
	currentCacheKey?: string;
	inputs?: Array<{ label?: string; payload: unknown; expected: unknown }>;
	totalCases?: number;
	modelIds?: TierModelSnapshot;
}

function parseLines(out: string): CaseListLine[] {
	return out
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as CaseListLine);
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'regression-list-mode-'));
	execSync('git init -q', { cwd: tempDir });
	execSync('git config user.email t@t', { cwd: tempDir });
	execSync('git config user.name T', { cwd: tempDir });
	casesDir = join(tempDir, 'cases');
	cacheDir = join(tempDir, 'cache');
	await mkdir(casesDir, { recursive: true });
	await mkdir(cacheDir, { recursive: true });
	// Write a coverage file at the repo-relative path the case declares.
	const coverageRel = 'regression/src/__tests__/list-mode.test.ts';
	await mkdir(join(tempDir, 'regression', 'src', '__tests__'), { recursive: true });
	await writeFile(join(tempDir, coverageRel), '// stub coverage file\n');
	await writeFile(join(casesDir, 'demo.case.ts'), SAMPLE_CASE_SRC);
	execSync('git add -A', { cwd: tempDir });
	execSync('git commit -q -m init', { cwd: tempDir });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('runCli --list', () => {
	it('emits a case-list-entry NDJSON line per case', async () => {
		const chunks: string[] = [];
		const stdout = (s: string) => chunks.push(s);
		const result = await runCli(['--list', '--json'], buildListDeps(), { stdout });
		expect(result.exitCode).toBe(0);
		const lines = parseLines(chunks.join(''));
		const entries = lines.filter((l) => l.type === 'case-list-entry');
		expect(entries).toHaveLength(1);
	});

	it('case-list-entry carries inputs + expected + oracle + budgetUsd + coverage (C5 never-run drilldown)', async () => {
		const chunks: string[] = [];
		await runCli(['--list', '--json'], buildListDeps(), { stdout: (s) => chunks.push(s) });
		const lines = parseLines(chunks.join(''));
		const entry = lines.find((l) => l.type === 'case-list-entry');
		expect(entry).toBeDefined();
		expect(entry?.caseId).toBe('demo-case-a');
		expect(entry?.bucket).toBe('routing');
		expect(entry?.routingTarget).toBe('food-shadow');
		expect(entry?.description).toBe('demo case for list mode');
		expect(entry?.oracle).toBe('structural');
		expect(entry?.budgetUsd).toBe(0.05);
		expect(entry?.coverage).toEqual(['regression/src/__tests__/list-mode.test.ts']);
		const inputs = entry?.inputs ?? [];
		expect(inputs).toHaveLength(2);
		expect(inputs[0]?.label).toBe('i1');
		expect(inputs[0]?.payload).toBe('hello');
		expect(inputs[0]?.expected).toEqual({ intent: 'save-recipe' });
	});

	it('case-list-entry includes a deterministic currentCacheKey (64-char hex)', async () => {
		const chunks: string[] = [];
		await runCli(['--list', '--json'], buildListDeps(), { stdout: (s) => chunks.push(s) });
		const lines = parseLines(chunks.join(''));
		const entry = lines.find((l) => l.type === 'case-list-entry');
		expect(entry?.currentCacheKey).toMatch(/^[a-f0-9]{64}$/);
	});

	it('emits a final case-list-end line with totalCases + modelIds', async () => {
		const chunks: string[] = [];
		await runCli(['--list', '--json'], buildListDeps(), { stdout: (s) => chunks.push(s) });
		const lines = parseLines(chunks.join(''));
		const end = lines.find((l) => l.type === 'case-list-end');
		expect(end).toBeDefined();
		expect(end?.totalCases).toBe(1);
		expect(end?.modelIds).toEqual(MODEL_IDS);
	});

	it('emits zero case-result lines (no dispatch)', async () => {
		const chunks: string[] = [];
		await runCli(['--list', '--json'], buildListDeps(), { stdout: (s) => chunks.push(s) });
		const lines = parseLines(chunks.join(''));
		expect(lines.filter((l) => l.type === 'case-result')).toHaveLength(0);
	});

	it('emits no summary line in list mode (REQ-REG-011 gate does not run)', async () => {
		const chunks: string[] = [];
		await runCli(['--list', '--json'], buildListDeps(), { stdout: (s) => chunks.push(s) });
		const lines = parseLines(chunks.join(''));
		expect(lines.filter((l) => l.type === 'summary')).toHaveLength(0);
	});

	it('exits 0 even when there are zero cases (empty casesDir)', async () => {
		await rm(join(casesDir, 'demo.case.ts'));
		const chunks: string[] = [];
		const result = await runCli(['--list', '--json'], buildListDeps(), {
			stdout: (s) => chunks.push(s),
		});
		expect(result.exitCode).toBe(0);
		const lines = parseLines(chunks.join(''));
		expect(lines.filter((l) => l.type === 'case-list-entry')).toHaveLength(0);
		const end = lines.find((l) => l.type === 'case-list-end');
		expect(end?.totalCases).toBe(0);
	});

	it('does not invoke classifiers (would throw in test deps)', async () => {
		const chunks: string[] = [];
		await expect(
			runCli(['--list', '--json'], buildListDeps(), { stdout: (s) => chunks.push(s) }),
		).resolves.toBeDefined();
	});
});
