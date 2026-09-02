/**
 * The operator's invariant, stated as a test:
 *
 *   **An all-local model matrix estimates $0.00.**
 *
 * Local models (Ollama, llama.cpp) run on the operator's own hardware and are
 * always free — a new local model needs no `MODEL_PRICING` entry because its
 * cost is zero by construction. The authoritative accounting path
 * (`CostTracker.record` → `estimateCallCost`) already honours this; the
 * regression pre-flight estimator did not, because it dropped `providerType`
 * AND always priced the fast tier regardless of which tier a case runs on.
 *
 * These tests pin the seam that fixes both halves: `buildTierPricingRefs`
 * (tier → model + providerType) and `makeTierAwareEstimator` (call → price on
 * that tier). The GUI's mirror of this invariant lives in
 * `core/src/gui/services/regression/__tests__/estimator.test.ts`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostTracker } from '@core/services/llm/cost-tracker.js';
import type { ModelRef, ModelTier, ProviderType } from '@core/types/llm.js';
import type { PersonaCase, TierModelSnapshot } from '@core/types/regression.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTierPricingRefs, makeTierAwareEstimator } from '../runner/build-deps.js';
import { CHATBOT_ESTIMATE_TOKENS } from '../runner/case-runners/chatbot-runner.js';
import { RECEIPT_ESTIMATE_TOKENS } from '../runner/case-runners/receipt-runner.js';
import { ESTIMATE_TOKENS } from '../runner/case-runners/routing-runner.js';
import { BUCKET_ESTIMATE } from '../runner/index.js';

/** A local model id that deliberately has NO `MODEL_PRICING` entry. */
const LOCAL_FAST = 'qwen3.8:27b-mlx';
const LOCAL_STANDARD = 'gemma4:26b';
/** A remote model that DOES have a pricing entry. */
const REMOTE_STANDARD = 'claude-sonnet-4-6';

const ALL_BUCKETS: ReadonlyArray<PersonaCase['bucket']> = [
	'routing',
	'recall',
	'chatbot',
	'receipt',
];

let dataDir: string;
let costTracker: CostTracker;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'local-estimate-'));
	costTracker = new CostTracker(dataDir, pino({ level: 'silent' }));
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

/**
 * Build pricing refs the way `buildProductionDeps` does: tier refs from the
 * ModelSelector, provider types from the ProviderRegistry.
 */
function refsFor(
	tiers: Partial<Record<ModelTier, { provider: string; model: string }>>,
	providerTypes: Record<string, ProviderType>,
) {
	const refs: Record<ModelTier, ModelRef | undefined> = {
		fast: tiers.fast,
		standard: tiers.standard,
		reasoning: tiers.reasoning,
	};
	const snapshot: TierModelSnapshot = {
		fast: tiers.fast?.model ?? 'unknown',
		standard: tiers.standard?.model ?? 'unknown',
		reasoning: tiers.reasoning?.model ?? null,
	};
	return buildTierPricingRefs(refs, snapshot, (providerId) =>
		providerId === undefined ? undefined : providerTypes[providerId],
	);
}

describe('runner pre-flight estimator — local models are free', () => {
	it('an all-local model matrix estimates $0.00 for every bucket', () => {
		const estimate = makeTierAwareEstimator(
			costTracker,
			refsFor(
				{
					fast: { provider: 'ollama', model: LOCAL_FAST },
					standard: { provider: 'ollama', model: LOCAL_STANDARD },
				},
				{ ollama: 'ollama' },
			),
		);

		for (const bucket of ALL_BUCKETS) {
			expect(estimate(BUCKET_ESTIMATE[bucket])).toBe(0);
		}
		// A 37-case all-local routing sweep costs exactly nothing.
		expect(estimate(BUCKET_ESTIMATE.routing) * 37).toBe(0);
	});

	it('llama.cpp is local too', () => {
		const estimate = makeTierAwareEstimator(
			costTracker,
			refsFor(
				{
					fast: { provider: 'llamacpp', model: LOCAL_FAST },
					standard: { provider: 'llamacpp', model: LOCAL_STANDARD },
				},
				{ llamacpp: 'llama-cpp' },
			),
		);
		for (const bucket of ALL_BUCKETS) {
			expect(estimate(BUCKET_ESTIMATE[bucket])).toBe(0);
		}
	});

	it('regression guard: without providerType a local model prices at frontier rates', () => {
		// This is exactly the bug. `qwen3.8:27b-mlx` has no MODEL_PRICING entry,
		// so a provider-less lookup falls through to DEFAULT_REMOTE_PRICING.
		const withoutProvider = costTracker.estimateCost(LOCAL_FAST, 4000, 1200);
		expect(withoutProvider).toBeGreaterThan(0);
		const withProvider = costTracker.estimateCost(LOCAL_FAST, 4000, 1200, 'ollama');
		expect(withProvider).toBe(0);
	});

	it('a mixed matrix prices only the remote tier', () => {
		// fast = local Ollama, standard = remote Anthropic.
		const estimate = makeTierAwareEstimator(
			costTracker,
			refsFor(
				{
					fast: { provider: 'ollama', model: LOCAL_FAST },
					standard: { provider: 'anthropic', model: REMOTE_STANDARD },
				},
				{ ollama: 'ollama', anthropic: 'anthropic' },
			),
		);

		// routing + recall run on `fast` → free.
		expect(estimate(BUCKET_ESTIMATE.routing)).toBe(0);
		expect(estimate(BUCKET_ESTIMATE.recall)).toBe(0);
		// receipt + chatbot run on `standard` → billed.
		expect(estimate(BUCKET_ESTIMATE.receipt)).toBeGreaterThan(0);
		expect(estimate(BUCKET_ESTIMATE.chatbot)).toBeGreaterThan(0);
	});

	it('prices the tier a case actually runs on, not always `fast`', () => {
		// The old estimator hard-coded `modelIds.fast`. With a cheap fast tier
		// and an expensive standard tier that under-charges every receipt and
		// chatbot case; here the standard-tier estimate must exceed the
		// fast-tier one for the SAME token counts.
		const estimate = makeTierAwareEstimator(
			costTracker,
			refsFor(
				{
					fast: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
					standard: { provider: 'anthropic', model: 'claude-opus-4-6' },
				},
				{ anthropic: 'anthropic' },
			),
		);
		const tokens = { tokenIn: 4000, tokenOut: 1200 };
		const fast = estimate({ ...tokens, tier: 'fast' });
		const standard = estimate({ ...tokens, tier: 'standard' });
		expect(standard).toBeGreaterThan(fast);
		// No tier → fast (the historical default for routing/recall call sites).
		expect(estimate(tokens)).toBe(fast);
	});

	it('the reasoning slot falls back to standard when unset', () => {
		const estimate = makeTierAwareEstimator(
			costTracker,
			refsFor(
				{
					fast: { provider: 'ollama', model: LOCAL_FAST },
					standard: { provider: 'ollama', model: LOCAL_STANDARD },
				},
				{ ollama: 'ollama' },
			),
		);
		// Reasoning is unset → inherits standard's (local) provider, not an
		// unknown-model remote guess.
		expect(estimate({ tokenIn: 4000, tokenOut: 1200, tier: 'reasoning' })).toBe(0);
	});

	it('every bucket estimate carries a tier and non-zero tokens', () => {
		// Guards two shipped bugs at once: a missing `tier` re-introduces
		// fast-tier mispricing, and zero tokens (the old receipt projection)
		// makes the per-case gate AND the run-budget ceiling unenforceable.
		for (const bucket of ALL_BUCKETS) {
			const call = BUCKET_ESTIMATE[bucket];
			expect(call.tier).toBeDefined();
			expect(call.tokenIn + call.tokenOut).toBeGreaterThan(0);
		}
		expect(ESTIMATE_TOKENS.tier).toBe('fast');
		expect(CHATBOT_ESTIMATE_TOKENS.tier).toBe('standard');
		expect(RECEIPT_ESTIMATE_TOKENS.tier).toBe('standard');
		expect(RECEIPT_ESTIMATE_TOKENS.tokenIn).toBeGreaterThan(0);
		expect(RECEIPT_ESTIMATE_TOKENS.tokenOut).toBeGreaterThan(0);
	});

	it('a receipt projection on a remote standard tier fits inside the per-case budget', () => {
		// Receipt cases declare budgetUsd = 0.05. The projection must be
		// conservative but not so conservative it gates every case out.
		const estimate = makeTierAwareEstimator(
			costTracker,
			refsFor(
				{
					fast: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
					standard: { provider: 'anthropic', model: REMOTE_STANDARD },
				},
				{ anthropic: 'anthropic' },
			),
		);
		const projected = estimate(RECEIPT_ESTIMATE_TOKENS);
		expect(projected).toBeGreaterThan(0);
		expect(projected).toBeLessThan(0.05);
	});
});
