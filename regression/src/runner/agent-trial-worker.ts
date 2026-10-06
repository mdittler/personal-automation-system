#!/usr/bin/env tsx
/**
 * Per-trial worker (REQ-REG-AGENT-002). Reads one AgentWorkerRequest from
 * stdin, builds a fresh seeded runtime in THIS process (so no app module
 * state survives from another trial), runs the trial, prints one
 * `{"type":"trial-result", ...}` line, and exits. Logs go to stderr.
 */
import { loadSystemConfig } from '@core/services/config/index.js';
import { CostTracker } from '@core/services/llm/cost-tracker.js';
import { pino } from 'pino';
import { createAgentEnvironment } from './agent-environment.js';
import { type AgentWorkerRequest, METER_INTERVAL_MS } from './agent-trial-spawn.js';
import { runAgentTrial } from './agent-trial.js';
import { createProviderCallTracker } from './provider-call-tracker.js';
import { createProviderRegistry } from './provider-registry.js';

process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET ?? 'true';

async function readStdin(): Promise<string> {
	let s = '';
	for await (const chunk of process.stdin) s += chunk;
	return s;
}

const request = JSON.parse(await readStdin()) as AgentWorkerRequest;
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' }, process.stderr);
const config = await loadSystemConfig({ configPath: request.productionConfigPath, mode: 'strict' });
const costTracker = new CostTracker(config.dataDir, logger.child({ service: 'cost-tracker' }));
await costTracker.loadMonthlyCache();
const registry = createProviderRegistry(config, logger, costTracker);

// Record provider-level failures (after retries) and track un-awaited calls so
// the trial reports `error` instead of grading the app's polite failure reply
// (review C12/C19). Production settle/drain values: 250 ms / 120 s.
const tracker = createProviderCallTracker();
for (const provider of registry.getAll()) tracker.wrap(provider);

// Cumulative spend every METER_INTERVAL_MS (2 s) as well as after each turn,
// so a trial that hangs mid-turn (e.g. between a receipt-parse call and its
// continuation) still reports what it already spent before the parent kills
// it (review C14). The parent relays every meter as a heartbeat (review C25).
const startCost = costTracker.getMonthlyTotalCost();
const startTok = costTracker.getTokenUsageTotals();
const emitMeter = () => {
	const tok = costTracker.getTokenUsageTotals();
	process.stdout.write(
		`${JSON.stringify({
			type: 'meter',
			costUsd: Math.max(0, costTracker.getMonthlyTotalCost() - startCost),
			tokenIn: Math.max(0, tok.input - startTok.input),
			tokenOut: Math.max(0, tok.output - startTok.output),
		})}\n`,
	);
};
setInterval(emitMeter, METER_INTERVAL_MS).unref();

const outcome = await runAgentTrial(
	request.trial,
	(overlay) =>
		createAgentEnvironment(
			{
				fixturesDir: request.fixturesDir,
				productionConfigPath: request.productionConfigPath,
				providerRegistry: registry,
				...(request.tierOverride ? { tierOverride: request.tierOverride } : {}),
				logger,
			},
			overlay,
		),
	costTracker,
	request.repoRoot,
	{
		infraErrors: () => tracker.errors,
		onMeter: () => emitMeter(),
		drain: () => tracker.drain(),
	},
);
// N2: make per-trial process isolation observable in the report and the smoke (review C3/C23).
outcome.details = `${outcome.details} [worker pid ${process.pid}]`;
process.stdout.write(`${JSON.stringify({ type: 'trial-result', outcome })}\n`, () =>
	process.exit(0),
);
