/**
 * Build classifier adapters used by the routing case-runner.
 *
 * Each adapter wraps one production classifier. On parse-failed output the
 * adapter returns the raw LLM string (NOT a thrown error) so the structural
 * oracle judges the schema mismatch — preserving regression signal that
 * REQ-REG-011 would otherwise miss. Infrastructure errors (LLM network
 * failures) DO throw and become `verdict: 'error'` at the runner.
 *
 * Cost is metered via `CostTracker.getMonthlyTotalCost()` delta. Tokens are
 * metered via the `getTokenUsageTotals()` delta (in `finally`, throw-resilient)
 * under the same sequential-dispatch invariant as cost. The delta is only
 * correct under sequential dispatch — the orchestrator enforces that invariant.
 */

import {
	classifyRecallIntent,
	recallPreFilter,
} from '@core/services/conversation-retrieval/recall-classifier.js';
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
	getTokenUsageTotals(): { input: number; output: number };
}

/** Non-negative, finite delta. Guards against a mis-reporting tracker. */
function safeDelta(after: number, before: number): number {
	const d = after - before;
	return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Error carrying the CallMeter for spend that occurred before the throw. */
export class MeteredError extends Error {
	constructor(
		message: string,
		readonly meter: CallMeter,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'MeteredError';
	}
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
	const costBefore = deps.costTracker.getMonthlyTotalCost();
	const tokBefore = deps.costTracker.getTokenUsageTotals();
	const buildMeter = (): CallMeter => {
		const model = deps.modelIds[tier];
		const tokAfter = deps.costTracker.getTokenUsageTotals();
		return {
			model: typeof model === 'string' ? model : 'unknown',
			tokenIn: safeDelta(tokAfter.input, tokBefore.input),
			tokenOut: safeDelta(tokAfter.output, tokBefore.output),
			costUsd: Math.max(0, deps.costTracker.getMonthlyTotalCost() - costBefore),
		};
	};
	try {
		const value = await fn();
		return { value, meter: buildMeter() };
	} catch (err) {
		throw new MeteredError(err instanceof Error ? err.message : String(err), buildMeter(), {
			cause: err,
		});
	}
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
				// Append the underlying message when there is one — `category` is
				// 'unknown' for most provider failures, and "infrastructure error:
				// unknown" is useless in a report.
				const detail = r.message ? `${r.category}: ${r.message}` : r.category;
				throw new MeteredError(`food-shadow infrastructure error: ${detail}`, meter);
			}
			throw new MeteredError(`food-shadow unexpected kind: ${(r as { kind: string }).kind}`, meter);
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
			// `appMetadata` is intentionally omitted. Production passes installed-
			// app names to refine routing, but the regression suite exercises the
			// base (no-metadata) classifier path so cases don't drift when apps
			// are installed/uninstalled between runs. If future cases need the
			// app-aware path, pass an AppMetadataService stub here and split into
			// a new routingTarget for the metadata-aware branch.
			//
			// DATA_QUERY_PREFILTER short-circuits without an LLM call; cost delta
			// naturally lands at 0 in that case.
			const { value: r, meter } = await meterCall(deps, 'fast', () =>
				classifyPASMessage(text, {
					llm: deps.llm,
					logger: widenedLogger,
				}),
			);
			return { raw: JSON.stringify(r), meter };
		},
	};
}

export interface RecallAdapter {
	/**
	 * Classify a message; `today` overrides `defaultToday` when supplied
	 * (case fixtures pin a deterministic date for temporal assertions).
	 */
	recall(message: string, today?: string): Promise<AdapterResult>;
}

export interface BuildRecallAdapterDeps {
	llm: LLMService;
	logger: MinimalLogger;
	costTracker: CostMeterSource;
	modelIds: TierModelSnapshot;
	/** YYYY-MM-DD default — used when the case fixture does not pin its own. */
	defaultToday: string;
	maxWindowDays?: number;
}

export function buildRecallAdapter(deps: BuildRecallAdapterDeps): RecallAdapter {
	const widenedLogger = deps.logger as unknown as AppLogger;
	return {
		recall: async (message: string, today?: string): Promise<AdapterResult> => {
			const effectiveToday = today ?? deps.defaultToday;
			// Pre-filter is synchronous + zero-cost; mirror the prod two-stage pipeline.
			const pf = recallPreFilter(message);
			if (pf.skip) {
				return {
					raw: JSON.stringify({
						shouldRecall: false,
						query: null,
						timeAnchor: null,
						reason: `prefilter:${pf.reason}`,
					}),
					meter: ZERO_METER(deps.modelIds.fast),
				};
			}
			const costBefore = deps.costTracker.getMonthlyTotalCost();
			const tokBefore = deps.costTracker.getTokenUsageTotals();
			const buildMeter = (): CallMeter => {
				const tokAfter = deps.costTracker.getTokenUsageTotals();
				return {
					model: deps.modelIds.fast,
					tokenIn: safeDelta(tokAfter.input, tokBefore.input),
					tokenOut: safeDelta(tokAfter.output, tokBefore.output),
					costUsd: Math.max(0, deps.costTracker.getMonthlyTotalCost() - costBefore),
				};
			};
			try {
				const verdict = await classifyRecallIntent(message, {
					llm: deps.llm,
					logger: widenedLogger,
					today: effectiveToday,
					...(deps.maxWindowDays !== undefined ? { maxWindowDays: deps.maxWindowDays } : {}),
				});
				return { raw: JSON.stringify(verdict), meter: buildMeter() };
			} catch (err) {
				throw new MeteredError(err instanceof Error ? err.message : String(err), buildMeter(), {
					cause: err,
				});
			}
		},
	};
}
