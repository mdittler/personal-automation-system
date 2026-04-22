#!/usr/bin/env tsx
/**
 * Load-test harness for the PAS LLM governance stack.
 *
 * Simulates concurrent household traffic across chatbot / ask / food message
 * kinds, collecting latency percentiles, per-household cost, and cap-hit
 * counts so that the D5c per-household limiter can be exercised end-to-end.
 *
 * Usage:
 *   pnpm load-test [--users=N] [--households=H] [--duration=S] [--report=path]
 *
 * This file also exports the Metrics layer (Task 5) and the quantile helper
 * so they can be unit-tested independently.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import pino from 'pino';
import { composeRuntime } from '../core/src/compose-runtime.js';
import type { RuntimeHandle, RuntimeServices } from '../core/src/compose-runtime.js';
import {
	StubProvider,
	createStubProviderRegistry,
} from '../core/src/testing/fixtures/stub-llm-provider.js';
import { fakeTelegramService } from '../core/src/testing/fixtures/fake-telegram.js';
import { seedUsers } from '../core/src/testing/fixtures/seed-users.js';
import type { SeededUser } from '../core/src/testing/fixtures/seed-users.js';
import { chatbotMessage, askMessage, foodMessage } from '../core/src/testing/fixtures/messages.js';
import { requestContext } from '../core/src/services/context/request-context.js';
import type { MessageContext } from '../core/src/types/telegram.js';
import type { ProviderRegistry } from '../core/src/services/llm/providers/provider-registry.js';
import type { CostTracker } from '../core/src/services/llm/cost-tracker.js';

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
 * Pattern matching every pre-throw warn emitted by LLMGuard, SystemLLMGuard,
 * and HouseholdLLMLimiter before they raise a cap/rate-limit error.
 *
 * Filtering on `msg` (not on a caught `error` object) is necessary because
 * Router.dispatchMessage() swallows thrown exceptions (router/index.ts:554-556)
 * and those warn records are the only reliable cap-enforcement signal.
 */
const CAP_MSG_RE = /rate limit exceeded|cost cap exceeded/i;

/**
 * Build a Pino `Writable` destination stream that intercepts guard-level warn
 * records and routes them to the appropriate cap-hit counter on `metrics`.
 *
 * Scope is derived from which context fields the guard included in the record:
 *   householdId present → 'household'
 *   totalCost present   → 'global'
 *   otherwise           → 'app'
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
				const record = JSON.parse(line) as Record<string, unknown>;
				const msg = typeof record.msg === 'string' ? record.msg : '';
				if (CAP_MSG_RE.test(msg)) {
					const scope: 'household' | 'app' | 'global' =
						'householdId' in record ? 'household' :
						'totalCost' in record   ? 'global'    : 'app';
					const key =
						(record.householdId as string | undefined) ??
						(record.appId as string | undefined) ??
						'unknown';
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
// rewireStubCostTracker
// ---------------------------------------------------------------------------

/**
 * After composeRuntime() returns, the StubProvider inside the registry was
 * constructed with a no-op cost tracker. Patch it to use the real CostTracker
 * so that all simulated LLM calls are attributed correctly.
 */
function rewireStubCostTracker(
	costTracker: CostTracker,
	providerRegistry: ProviderRegistry,
): void {
	const provider = providerRegistry.get('stub');
	if (!provider) {
		throw new Error('rewireStubCostTracker: stub provider not found in registry — check provider ID');
	}
	if (!(provider instanceof StubProvider)) {
		throw new Error('rewireStubCostTracker: provider is not a StubProvider — cannot rewire');
	}
	provider.setCostTracker(costTracker);
}

// ---------------------------------------------------------------------------
// worker helpers
// ---------------------------------------------------------------------------

function pickKind(): TrafficKind {
	const r = Math.random();
	if (r < 0.70) return 'chatbot';
	if (r < 0.90) return 'ask';
	return 'food';
}

function buildMessage(kind: TrafficKind, user: SeededUser, i: number): MessageContext {
	if (kind === 'chatbot') return chatbotMessage(user.id, i);
	if (kind === 'ask') return askMessage(user.id, i);
	return foodMessage(user.id, i);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function worker(
	user: SeededUser,
	runtime: RuntimeHandle,
	metrics: Metrics,
	endAt: number,
): Promise<void> {
	let i = 0;
	while (Date.now() < endAt) {
		const kind = pickKind();
		const msg = buildMessage(kind, user, i++);
		const t0 = performance.now();
		try {
			await requestContext.run({ userId: user.id, householdId: user.householdId }, () =>
				runtime.services.router.routeMessage(msg),
			);
			metrics.record(kind, performance.now() - t0, 'ok');
		} catch {
			metrics.record(kind, performance.now() - t0, 'err');
		}
		// Think time: 500ms–1500ms (shortened for reasonable test runs)
		await sleep(500 + Math.random() * 1000);
	}
}

// ---------------------------------------------------------------------------
// verifyAttribution
// ---------------------------------------------------------------------------

async function verifyAttribution(
	services: RuntimeServices,
	_metrics: Metrics,
): Promise<boolean> {
	// Wait for any in-flight writes to complete
	await services.costTracker.drainWrites();

	const markdown = await services.costTracker.readUsage();
	const rows = markdown.split('\n').filter((l: string) => l.startsWith('| 2'));
	let allCorrect = true;
	for (const row of rows) {
		const cols = row.split('|').slice(1, -1).map((c: string) => c.trim());
		if (cols.length < 9) continue;
		const userId = cols[7];
		const householdId = cols[8];
		if (!householdId || householdId === '-') continue; // platform-attributed rows
		const expected = services.householdService.getHouseholdForUser(userId);
		if (expected && expected !== householdId) {
			console.error(
				`Attribution mismatch: user=${userId} expected=${expected} actual=${householdId}`,
			);
			allCorrect = false;
		}
	}
	return allCorrect;
}

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

function renderReport(
	metrics: Metrics,
	opts: {
		users: number;
		households: number;
		duration: number;
		correct: boolean;
		householdIds: string[];
	},
): string {
	const s = metrics.summary();
	const today = new Date().toISOString().slice(0, 10);
	const fms = (n: number) => (Number.isNaN(n) ? 'n/a' : `${Math.round(n)}ms`);
	const latencyRows = ALL_KINDS
		.map((k) => {
			const ks = s.byKind[k];
			return `| ${k} | ${ks.count} | ${ks.errorCount} | ${fms(ks.p50)} | ${fms(ks.p95)} | ${fms(ks.p99)} |`;
		})
		.join('\n');
	const totalRow = `| **overall** | ${s.overall.count} | ${s.overall.errorCount} | ${fms(s.overall.p50)} | ${fms(s.overall.p95)} | ${fms(s.overall.p99)} |`;

	const costRows = opts.householdIds
		.map((hhId) => {
			const cost = metrics.getHouseholdCost(hhId);
			return `| ${hhId} | $${cost.toFixed(4)} |`;
		})
		.join('\n');

	const capStr = Object.entries(s.capHits)
		.map(([k, v]) => `- ${k}: ${v}`)
		.join('\n');

	return `# PAS Load Test Report — ${today}

**Users:** ${opts.users}  **Households:** ${opts.households}  **Duration:** ${opts.duration}s
**Attribution correctness:** ${opts.correct ? 'PASS ✓' : 'FAIL ✗'}

## Latency
| Kind | Count | Errors | p50 | p95 | p99 |
|---|---|---|---|---|---|
${latencyRows}
${totalRow}

## Per-household cost
| Household | Cost ($) |
|---|---|
${costRows}

## Cap triggers
${capStr}

## Baselines
- Max writeQueue in-flight: ${metrics.getMaxInFlightWrites()}
- file-mutex contention: not measured (future)
- Router same-user interleaving: not measured (future)
`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const { values: args } = parseArgs({
		options: {
			users:      { type: 'string', default: '40' },
			households: { type: 'string', default: '8' },
			duration:   { type: 'string', default: '120' },
			report:     { type: 'string', default: '' },
		},
	});

	const users      = parseInt(args.users ?? '40', 10);
	const households = parseInt(args.households ?? '8', 10);
	const duration   = parseInt(args.duration ?? '120', 10);

	if (!Number.isInteger(users) || users <= 0) {
		console.error(`Invalid --users value: "${args.users}". Must be a positive integer.`);
		process.exit(1);
	}
	if (!Number.isInteger(households) || households <= 0) {
		console.error(`Invalid --households value: "${args.households}". Must be a positive integer.`);
		process.exit(1);
	}
	if (!Number.isInteger(duration) || duration <= 0) {
		console.error(`Invalid --duration value: "${args.duration}". Must be a positive integer.`);
		process.exit(1);
	}
	const today      = new Date().toISOString().slice(0, 10);
	const report     = args.report || `docs/load-test-report-${today}.md`;

	console.log(`Starting load test: ${users} users × ${households} households × ${duration}s`);

	let runtime: RuntimeHandle | undefined;
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-load-test-'));

	try {
		const metrics = new Metrics();
		const logger = pino({}, createCapCapturingTransport(metrics));

		const seed = await seedUsers({ dataDir: tempDir, users, households });

		const providerRegistry = createStubProviderRegistry(
			{ record: async () => {}, estimateCost: () => 0, flush: async () => {}, readUsage: async () => '' } as any,
			logger,
		);

		runtime = await composeRuntime({
			dataDir: join(tempDir, 'data'),
			configPath: seed.configPath,
			config: seed.config,
			providerRegistry,
			telegramService: fakeTelegramService(),
			logger,
		});

		// Rewire stub provider to use real CostTracker
		rewireStubCostTracker(runtime.services.costTracker, providerRegistry);

		// Run workers
		const endAt = Date.now() + duration * 1000;
		await Promise.all(seed.users.map((u) => worker(u, runtime!, metrics, endAt)));

		// After workers finish, drain writes then read per-household costs from CostTracker
		await runtime.services.costTracker.drainWrites();
		for (const hhId of seed.households) {
			const cost = runtime.services.costTracker.getMonthlyHouseholdCost(hhId);
			if (cost > 0) metrics.recordCost(hhId, cost);
		}

		// Verify attribution correctness
		const correct = await verifyAttribution(runtime.services, metrics);

		// Render and write report
		const reportText = renderReport(metrics, {
			users,
			households,
			duration,
			correct,
			householdIds: seed.households,
		});
		await writeFile(report, reportText, 'utf8');
		console.log(reportText);
		console.log(`\nReport written to: ${report}`);

		process.exitCode = correct ? 0 : 1;
	} finally {
		if (runtime) await runtime.dispose();
		await rm(tempDir, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
