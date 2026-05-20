/**
 * Shared test helpers for receipt-runner integration / adversarial-persona
 * tests. Used by transcription-oracle integration scenarios and by the
 * receipt-runner unit tests.
 *
 * - `stagePhoto` / `stageSidecar` / `stageTranscription` author files in a
 *   caller-managed temp dir (`tempDir`).
 * - `llmShim` / `llmShimFromMock` build the LLMService shim
 *   `parseReceiptFromPhoto` actually consumes (`complete` + `completeWithMeta`).
 * - `makeReceiptDeps` returns a ready-to-pass `ReceiptRunnerDeps` with sane
 *   defaults; tests inject only the variable bit (the LLM stub).
 * - `makeCase` / `makeCaseWithTranscription` build the matching `PersonaCase`.
 * - `buildCase` is the high-level adversarial-persona entry point. With
 *   `{ useRealFixture: 'costco-long', stubParsed }` it wires the REAL fixture
 *   absolute paths into the payload and stubs the LLM to return `stubParsed`.
 *   No temp-dir authoring is required for that mode.
 * - `findTranscriptionVerdict` is the small shape-aware accessor used to
 *   match against `result.oracleVerdicts[]` regardless of array order.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { stringify as yamlStringify } from 'yaml';
import type { ReceiptRunnerDeps } from '../runner/case-runners/receipt-runner.js';
import type { OracleVerdict, PersonaCase, RunResult, TierModelSnapshot } from '../shared/types.js';

export const MODELS: TierModelSnapshot = { fast: 'f', standard: 's', reasoning: 'r' };
export const HEX_CACHE_KEY = 'a'.repeat(64);

// Absolute path to the committed fixtures dir. The integration-test mode
// (`useRealFixture: <slug>`) wires these paths straight through to the
// runner so the production parser sees the real .jpg / .expected.json /
// .transcription.yaml on disk.
const HERE = dirname(fileURLToPath(import.meta.url));
export const REAL_FIXTURES_DIR = resolve(HERE, '../../fixtures/receipts');

// ─── temp-dir authoring helpers ────────────────────────────────────────────

export async function makeTempDir(prefix = 'rrunner-'): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

export async function stagePhoto(tempDir: string, name: string): Promise<string> {
	const fp = join(tempDir, `${name}.png`);
	await writeFile(fp, Buffer.from('FAKE_PNG'));
	return fp;
}

export async function stageSidecar(
	tempDir: string,
	name: string,
	sidecar: object,
): Promise<string> {
	const fp = join(tempDir, `${name}.expected.json`);
	await writeFile(fp, JSON.stringify(sidecar));
	return fp;
}

export async function stageTranscription(
	tempDir: string,
	baseName: string,
	transcription: Record<string, unknown>,
	shaMode: 'matching' | 'mismatching' = 'matching',
): Promise<string> {
	const yamlText = yamlStringify(transcription);
	const yamlPath = join(tempDir, `${baseName}.transcription.yaml`);
	const shaPath = join(tempDir, `${baseName}.transcription.sha256`);
	await writeFile(yamlPath, yamlText, 'utf8');
	const sha =
		shaMode === 'matching' ? createHash('sha256').update(yamlText).digest('hex') : 'b'.repeat(64);
	await writeFile(shaPath, sha, 'utf8');
	return yamlPath;
}

// ─── LLM shim helpers ──────────────────────────────────────────────────────

/**
 * parseReceiptFromPhoto uses LLMService.completeWithMeta, so the runner shim
 * must provide both methods. This helper wires both to the same response
 * payload so tests can assert against either one.
 */
export function llmShim(text: string): ReceiptRunnerDeps['llm'] {
	return {
		complete: vi.fn().mockResolvedValue(text),
		completeWithMeta: vi.fn().mockResolvedValue({ text, finishReason: 'stop' as const }),
	};
}

export function llmShimFromMock(completeMock: ReturnType<typeof vi.fn>): ReceiptRunnerDeps['llm'] {
	return {
		complete: completeMock,
		completeWithMeta: vi.fn(async (...args: unknown[]) => ({
			text: await completeMock(...args),
			finishReason: 'stop' as const,
		})),
	};
}

export function makeLogger(): ReceiptRunnerDeps['logger'] {
	return {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

// ─── deps + case builders ──────────────────────────────────────────────────

/**
 * Returns a fully-formed `ReceiptRunnerDeps` with sane defaults. Each test
 * supplies the `llm` (the variable bit) and optionally overrides any other
 * field; the boilerplate (`logger`, `modelIds`, `cacheKey`, `caseBudgetUsd`,
 * `estimateUsd`, `timezone`) lives here.
 */
export function makeReceiptDeps(
	llm: ReceiptRunnerDeps['llm'],
	overrides: Partial<ReceiptRunnerDeps> = {},
): ReceiptRunnerDeps {
	return {
		llm,
		logger: makeLogger(),
		timezone: 'America/New_York',
		modelIds: MODELS,
		cacheKey: HEX_CACHE_KEY,
		caseBudgetUsd: 0.05,
		estimateUsd: () => 0.02,
		...overrides,
	};
}

export function makeCase(photo: string, sidecar: string, idSuffix = ''): PersonaCase {
	return {
		id: `receipt-stub${idSuffix ? `-${idSuffix}` : ''}-1`,
		description: 'd',
		bucket: 'receipt',
		coverage: ['apps/food/src/services/receipt-parser.ts'],
		inputs: [
			{
				payload: { photoFixture: photo, sidecarFixture: sidecar },
				expected: { kind: 'sidecar' },
			},
		],
		oracle: 'structural',
		budgetUsd: 0.05,
	};
}

interface TestReceiptPayloadShape {
	photoFixture: string;
	sidecarFixture: string;
	transcriptionFixture?: string;
}

export function makeCaseWithTranscription(
	photo: string,
	sidecar: string,
	transcription: string | undefined,
	idSuffix = '',
): PersonaCase {
	const payload: TestReceiptPayloadShape = { photoFixture: photo, sidecarFixture: sidecar };
	if (transcription !== undefined) {
		payload.transcriptionFixture = transcription;
	}
	return {
		id: `receipt-trx${idSuffix ? `-${idSuffix}` : ''}-1`,
		description: 'd',
		bucket: 'receipt',
		coverage: ['apps/food/src/services/receipt-parser.ts'],
		inputs: [{ payload, expected: { kind: 'sidecar' } }],
		oracle: 'structural',
		budgetUsd: 0.05,
	};
}

// ─── high-level adversarial-persona builder ───────────────────────────────

/**
 * Adversarial-persona integration entry point.
 *
 * `useRealFixture: <slug>` wires the REAL fixture paths from
 * `regression/fixtures/receipts/` straight into the payload — no temp-dir
 * authoring. The stub LLM returns the JSON-serialized `stubParsed` shape.
 * All other deps use `makeReceiptDeps` defaults.
 *
 * This lets the integration test exercise the full runner pipeline (production
 * parser + structural + transcription oracles + aggregation) against the same
 * fixtures the GUI / CLI would consume, varying only the parser output via
 * the LLM stub.
 */
export function buildCase(opts: {
	useRealFixture: string;
	stubParsed: unknown;
	depsOverrides?: Partial<ReceiptRunnerDeps>;
	idSuffix?: string;
}): { case_: PersonaCase; deps: ReceiptRunnerDeps } {
	const slug = opts.useRealFixture;
	const photoFixture = join(REAL_FIXTURES_DIR, `${slug}.jpg`);
	const sidecarFixture = join(REAL_FIXTURES_DIR, `${slug}.expected.json`);
	const transcriptionFixture = join(REAL_FIXTURES_DIR, `${slug}.transcription.yaml`);

	const payload: TestReceiptPayloadShape = {
		photoFixture,
		sidecarFixture,
		transcriptionFixture,
	};

	const case_: PersonaCase = {
		id: `receipt-integration-${slug}${opts.idSuffix ? `-${opts.idSuffix}` : ''}`,
		description: `Adversarial persona over ${slug}`,
		bucket: 'receipt',
		coverage: [
			'apps/food/src/services/receipt-parser.ts',
			`regression/fixtures/receipts/${slug}.jpg`,
			`regression/fixtures/receipts/${slug}.expected.json`,
			`regression/fixtures/receipts/${slug}.transcription.yaml`,
		],
		inputs: [{ payload, expected: { kind: 'sidecar' } }],
		oracle: 'structural',
		budgetUsd: 0.05,
	};

	const llm = llmShim(JSON.stringify(opts.stubParsed));
	const deps = makeReceiptDeps(llm, opts.depsOverrides ?? {});
	return { case_, deps };
}

/** Locate the transcription verdict on a RunResult regardless of array order. */
export function findTranscriptionVerdict(result: RunResult): OracleVerdict | undefined {
	return result.oracleVerdicts.find((v) => v.label === 'transcription');
}

/** Locate the structural verdict on a RunResult regardless of array order. */
export function findStructuralVerdict(result: RunResult): OracleVerdict | undefined {
	return result.oracleVerdicts.find((v) => v.label === 'structural');
}
