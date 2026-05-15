/**
 * Receipt runner integration tests (REQ-REG-008).
 *
 * These tests prove that the regression runner invokes the REAL production
 * `parseReceiptFromPhoto` from `apps/food/src/services/receipt-parser.ts`.
 * If the production prompt or post-processing changes in a regressive way,
 * the suite must catch it — and that requires consuming the real function,
 * not duplicating its prompt locally.
 *
 * The LLM is mocked here (via `vi.fn()`) because we test the runner's wiring,
 * not the model. End-to-end runs against real LLMs happen via the CLI in
 * later tasks.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReceiptRunnerDeps, runReceiptCase } from '../runner/case-runners/receipt-runner.js';
import type { PersonaCase, TierModelSnapshot } from '../shared/types.js';

const MODELS: TierModelSnapshot = { fast: 'f', standard: 's', reasoning: 'r' };
const HEX = 'a'.repeat(64);

let tempDir: string;
beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'rrunner-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function stagePhoto(name: string): Promise<string> {
	const fp = join(tempDir, `${name}.png`);
	await writeFile(fp, Buffer.from('FAKE_PNG'));
	return fp;
}

async function stageSidecar(name: string, sidecar: object): Promise<string> {
	const fp = join(tempDir, `${name}.expected.json`);
	await writeFile(fp, JSON.stringify(sidecar));
	return fp;
}

function makeCase(photo: string, sidecar: string, idSuffix = ''): PersonaCase {
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

function makeLogger(): ReceiptRunnerDeps['logger'] {
	return {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

/**
 * Codex P1 (2026-05-15): parseReceiptFromPhoto uses LLMService.completeWithMeta,
 * so the runner shim must provide both methods. This helper wires both to the
 * same response payload so tests can assert against either one.
 */
function llmShim(text: string): ReceiptRunnerDeps['llm'] {
	return {
		complete: vi.fn().mockResolvedValue(text),
		completeWithMeta: vi.fn().mockResolvedValue({ text, finishReason: 'stop' as const }),
	};
}

function llmShimFromMock(
	completeMock: ReturnType<typeof vi.fn>,
): ReceiptRunnerDeps['llm'] {
	return {
		complete: completeMock,
		completeWithMeta: vi.fn(async (...args: unknown[]) => ({
			text: await completeMock(...args),
			finishReason: 'stop' as const,
		})),
	};
}

describe('runReceiptCase — production parser integration', () => {
	it('passes when LLM extraction matches sidecar exactly', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 47.82,
			lineItems: [
				{ name: 'Eggs', totalPrice: 4.99 },
				{ name: 'Milk', totalPrice: 3.49 },
			],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [
					{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
					{ name: 'Milk', quantity: 1, unitPrice: 3.49, totalPrice: 3.49 },
				],
				subtotal: 8.48,
				tax: 39.34,
				total: 47.82,
			}),
		);
		const deps: ReceiptRunnerDeps = {
			llm: llmShimFromMock(llmComplete),
			logger: makeLogger(),
			timezone: 'America/New_York',
			modelIds: MODELS,
			cacheKey: HEX,
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.02,
		};
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath), deps);
		expect(result.verdict).toBe('pass');
		expect(result.actuals).toHaveLength(1);
		expect(result.costUsd).toBeCloseTo(0.02, 4);
		expect(llmComplete).toHaveBeenCalledTimes(1);
		const callArgs = llmComplete.mock.calls[0];
		if (!callArgs) throw new Error('expected llm.complete to have been called');
		const prompt = callArgs[0] as string;
		// Sample the food prompt's structure — these regexes catch regressions
		// that strip or rearrange the prompt without breaking JSON parseability.
		expect(prompt).toMatch(/grocery receipt/i);
		expect(prompt).toMatch(/YYYY-MM-DD/);
		expect(prompt).toMatch(/lineItems/);
		expect(prompt).toMatch(/total/i);
		// The LLM-side options carry tier and images
		const opts = callArgs[1] as { tier?: string; images?: Array<{ mimeType: string }> };
		expect(opts.tier).toBe('standard');
		expect(opts.images?.[0]?.mimeType).toBe('image/png');
		expect(result.oracleVerdicts[0]?.verdict).toBe('pass');
	});

	it('fails when LLM hallucinates a line item (set-equality)', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const deps: ReceiptRunnerDeps = {
			llm: llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: '2026-04-15',
					lineItems: [
						{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
						{ name: 'Hallucinated Caviar', quantity: 1, unitPrice: 100, totalPrice: 100 },
					],
					subtotal: 104.99,
					tax: 0,
					total: 104.99,
				}),
			),
			logger: makeLogger(),
			timezone: 'America/New_York',
			modelIds: MODELS,
			cacheKey: HEX,
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.02,
		};
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'hallu'), deps);
		expect(result.verdict).toBe('fail');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/caviar/i);
	});

	it('emits verdict=error when LLM returns malformed JSON (parser throws)', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const deps: ReceiptRunnerDeps = {
			llm: llmShim('not json{'),
			logger: makeLogger(),
			timezone: 'America/New_York',
			modelIds: MODELS,
			cacheKey: HEX,
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.02,
		};
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'bad-json'), deps);
		expect(result.verdict).toBe('error');
		expect(result.oracleVerdicts[0]?.details ?? '').toMatch(/parser threw/i);
		expect(result.actuals[0]).toBeNull();
	});

	it('expectRejection=true: parser overwrites date to today, preserves rawExtractedDate', async () => {
		const photoPath = await stagePhoto('future');
		const sidecarPath = await stageSidecar('future', {
			expectRejection: true,
			store: 'Walmart',
			total: 47.82,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		// LLM returns a date 70+ years in the future — the production parser's
		// isValidReceiptDate rejects it (MAX_RECEIPT_AGE_DAYS = 90, future
		// dates rejected).
		const futureDate = '2099-12-31';
		const deps: ReceiptRunnerDeps = {
			llm: llmShim(
				JSON.stringify({
					store: 'Walmart',
					date: futureDate,
					lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
					subtotal: 4.99,
					tax: 0,
					total: 47.82,
				}),
			),
			logger: makeLogger(),
			timezone: 'America/New_York',
			modelIds: MODELS,
			cacheKey: HEX,
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.02,
		};
		const result = await runReceiptCase(makeCase(photoPath, sidecarPath, 'reject'), deps);
		expect(result.verdict).toBe('pass');
		const parsed = result.actuals[0] as { rawExtractedDate?: string; date: string };
		expect(parsed.rawExtractedDate).toBe(futureDate);
		expect(parsed.date).not.toBe(futureDate); // overwritten to today (parser fallback)
	});

	it('aborts with verdict=budget-exceeded before any LLM call when first call would exceed budget', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [],
				subtotal: 0,
				tax: 0,
				total: 4.99,
			}),
		);
		const deps: ReceiptRunnerDeps = {
			llm: llmShimFromMock(llmComplete),
			logger: makeLogger(),
			timezone: 'America/New_York',
			modelIds: MODELS,
			cacheKey: HEX,
			caseBudgetUsd: 0.01,
			estimateUsd: () => 0.05, // every call costs 5x the budget
		};
		const c = makeCase(photoPath, sidecarPath, 'budget');
		c.inputs.push({
			payload: { photoFixture: photoPath, sidecarFixture: sidecarPath },
			expected: { kind: 'sidecar' },
		});
		const result = await runReceiptCase(c, deps);
		expect(result.verdict).toBe('budget-exceeded');
		// Pre-charge gate fires before the first call is dispatched: 0 + 0.05 > 0.01.
		expect(llmComplete).not.toHaveBeenCalled();
		expect(result.costUsd).toBe(0);
	});

	it('preserves prior fail verdict when a later input would trip the budget gate', async () => {
		// Two-input case: input 1 hallucinates a line item (verdict=fail);
		// input 2 would trip the budget gate. Final verdict must be 'fail',
		// NOT 'budget-exceeded' — stronger verdicts must not be clobbered.
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart-precedence', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [
					{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 },
					{ name: 'Hallucinated Caviar', quantity: 1, unitPrice: 100, totalPrice: 100 },
				],
				subtotal: 104.99,
				tax: 0,
				total: 104.99,
			}),
		);
		// estimate: first call $0.02 (fits in $0.05 budget), second call $0.05 (would push 0.02+0.05=0.07 > 0.05)
		let callIdx = 0;
		const deps: ReceiptRunnerDeps = {
			llm: llmShimFromMock(llmComplete),
			logger: makeLogger(),
			timezone: 'America/New_York',
			modelIds: MODELS,
			cacheKey: HEX,
			caseBudgetUsd: 0.05,
			estimateUsd: () => {
				callIdx += 1;
				return callIdx === 1 ? 0.02 : 0.05;
			},
		};
		const c = makeCase(photoPath, sidecarPath, 'precedence');
		c.inputs.push({
			payload: { photoFixture: photoPath, sidecarFixture: sidecarPath },
			expected: { kind: 'sidecar' },
		});
		const result = await runReceiptCase(c, deps);
		expect(result.verdict).toBe('fail');
		// First input was processed (LLM called once, hallucination → fail).
		// Second input was gated out, but must NOT clobber the prior fail.
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(result.oracleVerdicts).toHaveLength(1);
		expect(result.oracleVerdicts[0]?.verdict).toBe('fail');
	});

	it('passes input to production parseReceiptFromPhoto with correct mime type and tier', async () => {
		const photoPath = await stagePhoto('walmart');
		const sidecarPath = await stageSidecar('walmart', {
			store: 'Walmart',
			date: '2026-04-15',
			total: 4.99,
			lineItems: [{ name: 'Eggs', totalPrice: 4.99 }],
		});
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				store: 'Walmart',
				date: '2026-04-15',
				lineItems: [{ name: 'Eggs', quantity: 1, unitPrice: 4.99, totalPrice: 4.99 }],
				subtotal: 4.99,
				tax: 0,
				total: 4.99,
			}),
		);
		const deps: ReceiptRunnerDeps = {
			llm: llmShimFromMock(llmComplete),
			logger: makeLogger(),
			timezone: 'America/New_York',
			modelIds: MODELS,
			cacheKey: HEX,
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.02,
		};
		await runReceiptCase(makeCase(photoPath, sidecarPath, 'mime'), deps);
		expect(llmComplete).toHaveBeenCalledTimes(1);
		const callArgs = llmComplete.mock.calls[0];
		expect(callArgs).toBeDefined();
		const opts = callArgs?.[1] as {
			tier?: string;
			images?: Array<{ mimeType: string; data: Buffer }>;
		};
		expect(opts.tier).toBe('standard');
		expect(opts.images).toHaveLength(1);
		expect(opts.images?.[0]?.mimeType).toBe('image/png');
		expect(Buffer.isBuffer(opts.images?.[0]?.data)).toBe(true);
	});
});
