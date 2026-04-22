#!/usr/bin/env tsx
/**
 * Load-test harness for the PAS LLM governance stack.
 *
 * Simulates concurrent household traffic across chatbot / ask / food message
 * kinds, collecting latency percentiles, per-household cost, and cap-hit
 * counts so that the D5c per-household limiter can be exercised end-to-end.
 *
 * Usage (once Task 6 is complete):
 *   pnpm tsx scripts/load-test.ts [--households=N] [--duration=60] [--concurrency=10]
 *
 * This file also exports the Metrics layer (Task 5) and the quantile helper
 * so they can be unit-tested independently.
 */

import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrafficKind = 'chatbot' | 'ask' | 'food';
export type ResultKind = 'ok' | 'err';

export interface KindStats {
	count: number;
	errorCount: number;
	latencies: number[]; // raw milliseconds
}

export interface MetricsSummary {
	overall: { count: number; errorCount: number; p50: number; p95: number; p99: number };
	byKind: Record<TrafficKind, KindStats & { p50: number; p95: number; p99: number }>;
	capHits: { household: number; app: number; global: number };
}

// ---------------------------------------------------------------------------
// quantile
// ---------------------------------------------------------------------------

/**
 * Compute the q-th quantile of `samples` using the nearest-rank method.
 *
 * Sorts a *copy* of the input array, then:
 *   index = Math.ceil(q * samples.length) - 1
 *
 * Returns NaN for an empty array.
 *
 * @example
 *   quantile([1, 2, …, 100], 0.5) // → 50
 */
export function quantile(samples: number[], q: number): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.ceil(q * sorted.length) - 1;
	return sorted[index]!;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const ALL_KINDS: TrafficKind[] = ['chatbot', 'ask', 'food'];

/**
 * Thread-safe (single-process) metrics aggregator for the load-test harness.
 */
export class Metrics {
	private readonly kindStats: Record<TrafficKind, KindStats> = {
		chatbot: { count: 0, errorCount: 0, latencies: [] },
		ask: { count: 0, errorCount: 0, latencies: [] },
		food: { count: 0, errorCount: 0, latencies: [] },
	};

	private readonly householdCosts = new Map<string, number>();
	private readonly capHits = { household: 0, app: 0, global: 0 };
	private maxInFlightWrites = 0;

	/** Record a single request outcome. */
	record(kind: TrafficKind, latencyMs: number, result: ResultKind): void {
		const s = this.kindStats[kind];
		s.count++;
		if (result === 'err') s.errorCount++;
		s.latencies.push(latencyMs);
	}

	/** Accumulate LLM cost attributed to a household. */
	recordCost(householdId: string, costUsd: number): void {
		this.householdCosts.set(
			householdId,
			(this.householdCosts.get(householdId) ?? 0) + costUsd,
		);
	}

	/** Increment a cap-hit counter by scope. */
	recordCapHit(scope: 'household' | 'app' | 'global', _key: string): void {
		this.capHits[scope]++;
	}

	/** Return accumulated cost for a household (0 if never seen). */
	getHouseholdCost(householdId: string): number {
		return this.householdCosts.get(householdId) ?? 0;
	}

	/** Return current cap-hit counters. */
	getCapHits(): { household: number; app: number; global: number } {
		return { ...this.capHits };
	}

	/** Return the current max-in-flight-writes watermark. */
	getMaxInFlightWrites(): number {
		return this.maxInFlightWrites;
	}

	/** Update the max-in-flight-writes watermark (called by the harness). */
	setMaxInFlightWrites(n: number): void {
		if (n > this.maxInFlightWrites) this.maxInFlightWrites = n;
	}

	/** Produce a snapshot summary. */
	summary(): MetricsSummary {
		let totalCount = 0;
		let totalErrors = 0;
		const allLatencies: number[] = [];

		const byKind = {} as MetricsSummary['byKind'];

		for (const kind of ALL_KINDS) {
			const s = this.kindStats[kind];
			totalCount += s.count;
			totalErrors += s.errorCount;
			allLatencies.push(...s.latencies);

			byKind[kind] = {
				...s,
				latencies: [...s.latencies],
				p50: quantile(s.latencies, 0.5),
				p95: quantile(s.latencies, 0.95),
				p99: quantile(s.latencies, 0.99),
			};
		}

		return {
			overall: {
				count: totalCount,
				errorCount: totalErrors,
				p50: quantile(allLatencies, 0.5),
				p95: quantile(allLatencies, 0.95),
				p99: quantile(allLatencies, 0.99),
			},
			byKind,
			capHits: this.getCapHits(),
		};
	}
}

// ---------------------------------------------------------------------------
// createCapCapturingTransport
// ---------------------------------------------------------------------------

/**
 * Creates a Pino destination stream that parses each log record
 * (newline-delimited JSON) and counts entries where `record.err?.name` is
 * `'LLMCostCapError'` or `'LLMRateLimitError'`, routing them to the
 * appropriate cap-hit counter on `metrics`.
 */
export function createCapCapturingTransport(metrics: Metrics): Writable {
	return new Writable({
		write(
			chunk: Buffer,
			_enc: BufferEncoding,
			cb: (err?: Error | null) => void,
		) {
			try {
				const line = chunk.toString().trim();
				if (!line) {
					cb();
					return;
				}
				const record = JSON.parse(line) as {
					err?: { name?: string; scope?: string; key?: string };
				};
				const name = record.err?.name;
				if (name === 'LLMCostCapError' || name === 'LLMRateLimitError') {
					const scope = (record.err?.scope as 'household' | 'app' | 'global') ?? 'app';
					const key = record.err?.key ?? 'unknown';
					metrics.recordCapHit(scope, key);
				}
			} catch {
				/* ignore non-JSON lines */
			}
			cb();
		},
	});
}

// ---------------------------------------------------------------------------
// Main entry point (Task 6 will flesh this out)
// ---------------------------------------------------------------------------

async function main() {
	console.log('load-test harness not yet fully implemented (Task 6)');
	process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch(console.error);
}
