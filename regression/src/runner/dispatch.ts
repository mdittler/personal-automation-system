/**
 * Build classifier adapters used by the routing case-runner.
 *
 * Each adapter wraps one production classifier. On parse-failed output the
 * adapter returns the raw LLM string (NOT a thrown error) so the structural
 * oracle judges the schema mismatch — preserving regression signal that
 * REQ-REG-011 would otherwise miss. Infrastructure errors (LLM network
 * failures) DO throw and become `verdict: 'error'` at the runner.
 *
 * Cost is metered via `CostTracker.getMonthlyTotalCost()` delta. Token
 * counts are best-effort 0 (CostTracker has no per-call token surface);
 * cost is authoritative for REQ-REG-013. The delta is only correct under
 * sequential dispatch — the orchestrator enforces that invariant.
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
				// Surface raw output so the oracle fails on schema mismatch — that's
				// real regression signal the REQ-REG-011 gate is designed to catch.
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
			// delta drifted (defensive against unrelated CostTracker activity).
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
			// classifyPASMessage's DATA_QUERY_PREFILTER short-circuits without an
			// LLM call; cost delta naturally lands at 0 in that case.
			return { raw: JSON.stringify(r), meter };
		},
	};
}
