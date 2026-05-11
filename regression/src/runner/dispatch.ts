/**
 * Build classifier adapters used by the routing case-runner.
 *
 * Each adapter wraps one production classifier and:
 *
 *  - Returns the JSON-stringified output that the structural oracle expects
 *    (the production return shape, not a re-serialization).
 *  - On parse-failed kinds (currently only food-shadow's discriminated
 *    union has this), returns the raw LLM output so the oracle can fail it
 *    via schema mismatch (Codex C-3). Throwing here would convert real
 *    parser regressions into runner-level `verdict: 'error'`, which the
 *    REQ-REG-011 accuracy gate now counts (Codex C-2) but loses the
 *    "the LLM said X but it was nonsense" diagnostic in the GUI drilldown.
 *  - On LLM infrastructure errors, throws — the routing-runner catches and
 *    records `verdict: 'error'`.
 *  - Meters cost via `CostTracker.getMonthlyTotalCost()` delta. Token
 *    counts are 0 (best-effort; CostTracker doesn't expose per-call
 *    tokens). Cost is authoritative for REQ-REG-013.
 *
 * Cost-delta correctness depends on sequential dispatch — the orchestrator
 * runs cases one at a time. Two parallel routing cases would race the
 * snapshot. Documented in `runner/index.ts`.
 */

import { classifyPASMessage } from '@core/services/conversation/pas-classifier.js';
import { detectSessionControl } from '@core/services/conversation/session-control-classifier.js';
import type { AppLogger } from '@core/types/app-module.js';
import type { LLMService } from '@core/types/llm.js';
import type { CallMeter, TierModelSnapshot } from '@core/types/regression.js';
import { FoodShadowClassifier } from '@food/routing/shadow-classifier.js';
import { FOOD_SHADOW_LABELS } from '@food/routing/shadow-taxonomy.js';
import type {
	AdapterResult,
	MinimalLogger,
	RoutingClassifierAdapter,
} from './case-runners/routing-runner.js';

export interface CostMeterSource {
	getMonthlyTotalCost(): number;
}

export interface BuildAdaptersDeps {
	llm: LLMService;
	logger: MinimalLogger;
	costTracker: CostMeterSource;
	modelIds: TierModelSnapshot;
}

const ZERO_METER = (model: string): CallMeter => ({
	model,
	tokenIn: 0,
	tokenOut: 0,
	costUsd: 0,
});

async function meterCall<T>(
	deps: BuildAdaptersDeps,
	tier: keyof TierModelSnapshot,
	fn: () => Promise<T>,
): Promise<{ value: T; meter: CallMeter }> {
	const before = deps.costTracker.getMonthlyTotalCost();
	const value = await fn();
	const after = deps.costTracker.getMonthlyTotalCost();
	const model = deps.modelIds[tier] ?? 'unknown';
	return {
		value,
		meter: {
			model: typeof model === 'string' ? model : 'unknown',
			tokenIn: 0,
			tokenOut: 0,
			costUsd: Math.max(0, after - before),
		},
	};
}

export function buildClassifierAdapters(deps: BuildAdaptersDeps): RoutingClassifierAdapter {
	// MinimalLogger has the subset of AppLogger we use (warn/info/debug/error).
	// The wider cast preserves type compatibility with production classifiers
	// that import AppLogger (FoodShadowClassifier, classifyPASMessage).
	const widenedLogger = deps.logger as unknown as AppLogger;
	const foodShadow = new FoodShadowClassifier({
		llm: deps.llm,
		logger: widenedLogger,
		labels: FOOD_SHADOW_LABELS,
	});

	return {
		foodShadow: async (text: string): Promise<AdapterResult> => {
			const { value: r, meter } = await meterCall(deps, 'fast', () =>
				foodShadow.classify(text, 1.0),
			);
			if (r.kind === 'ok') {
				return {
					raw: JSON.stringify({ action: r.action, confidence: r.confidence }),
					meter,
				};
			}
			if (r.kind === 'parse-failed') {
				// Codex C-3: surface raw output instead of throwing. The structural
				// oracle will fail it on schema mismatch, which the REQ-REG-011 gate
				// counts as a real regression rather than an infrastructure miss.
				return { raw: r.raw, meter };
			}
			if (r.kind === 'llm-error') {
				throw new Error(`food-shadow infrastructure error: ${r.category}`);
			}
			throw new Error(`food-shadow unexpected kind: ${(r as { kind: string }).kind}`);
		},

		sessionControl: async (text: string): Promise<AdapterResult> => {
			const { value: r, meter } = await meterCall(deps, 'fast', () =>
				detectSessionControl(text, {
					llm: deps.llm,
					logger: widenedLogger,
				}),
			);
			// Prefilter path didn't hit the LLM; force a zero meter even if the
			// delta is non-zero (paranoid — other code could have called CostTracker
			// in between, though the orchestrator's sequential dispatch makes that
			// effectively impossible).
			const finalMeter = r.source === 'prefilter' ? ZERO_METER(meter.model) : meter;
			return { raw: JSON.stringify(r), meter: finalMeter };
		},

		pas: async (text: string): Promise<AdapterResult> => {
			const { value: r, meter } = await meterCall(deps, 'fast', () =>
				classifyPASMessage(text, {
					llm: deps.llm,
					logger: widenedLogger,
				}),
			);
			// The internal DATA_QUERY_PREFILTER in classifyPASMessage short-circuits
			// without an LLM call. The cost delta will be 0 naturally; tests in
			// dispatch.test.ts assert the LLM mock wasn't invoked for prefilter
			// phrases. The adapter has no way to distinguish prefilter from
			// LLM-skipped-on-empty-input, so we trust the delta.
			return { raw: JSON.stringify(r), meter };
		},
	};
}
