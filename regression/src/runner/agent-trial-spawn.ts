/**
 * Parent side of the per-trial worker (REQ-REG-AGENT-002). Spawns
 * `process.execPath --import=tsx/esm agent-trial-worker.ts`, writes one JSON
 * request to stdin, relays the worker's cumulative `meter` lines live (the
 * CLI turns them into heartbeats so the GUI's no-stdout watchdog cannot fire
 * during a long trial — review C25), and resolves with the worker's
 * `trial-result` line. Any crash, missing result, timeout, or parent
 * termination becomes an `error` outcome (never cached) that charges the last
 * meter the worker reported.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import type { AgentTrialOutcome, AgentTrialRequest } from './agent-trial.js';
import type { TrialMeter } from './case-runners/agent-runner.js';
import type { TierOverride } from './seeded-runtime.js';

/** The worker emits a cumulative meter this often, as well as after every turn (review C14). */
export const METER_INTERVAL_MS = 2000;
/** Hard ceiling for one trial; the parent SIGKILLs the worker past it. */
export const WORKER_TIMEOUT_MS = 15 * 60_000;

export interface AgentWorkerRequest {
	trial: AgentTrialRequest;
	fixturesDir: string;
	productionConfigPath: string;
	repoRoot: string;
	tierOverride?: TierOverride;
}

export interface SpawnOptions {
	workerPath: string;
	/** Default `['--import=tsx/esm']`; tests pass `[]` for plain .mjs workers. */
	execArgv?: string[];
	cwd: string;
	/** `regression/tsconfig.json` so tsx resolves `@core/*` and `@pas/core/*` to source (sets TSX_TSCONFIG_PATH). */
	tsconfigPath?: string;
	timeoutMs: number;
	/** Called for every `meter` line as it arrives — the heartbeat source. */
	onMeter?: (m: TrialMeter) => void;
}

const STDERR_TAIL = 2000;
const ZERO_METER: TrialMeter = { costUsd: 0, tokenIn: 0, tokenOut: 0 };

/** Parse one stdout line; returns the meter when (and only when) it is a `meter` line. */
export function parseMeterLine(line: string): TrialMeter | undefined {
	if (!line.startsWith('{')) return undefined;
	try {
		const msg = JSON.parse(line) as { type?: string } & Partial<TrialMeter>;
		if (msg.type !== 'meter') return undefined;
		return { costUsd: msg.costUsd ?? 0, tokenIn: msg.tokenIn ?? 0, tokenOut: msg.tokenOut ?? 0 };
	} catch {
		return undefined;
	}
}

/** Parse the worker's NDJSON stdout: the final `trial-result`, and the last cumulative `meter`. */
export function parseWorkerStdout(stdout: string): {
	outcome?: AgentTrialOutcome;
	meter?: TrialMeter;
} {
	let outcome: AgentTrialOutcome | undefined;
	let meter: TrialMeter | undefined;
	for (const line of stdout.split('\n')) {
		const m = parseMeterLine(line);
		if (m) {
			meter = m;
			continue;
		}
		if (!line.startsWith('{')) continue;
		try {
			const msg = JSON.parse(line) as { type?: string; outcome?: AgentTrialOutcome };
			if (msg.type === 'trial-result' && msg.outcome) outcome = msg.outcome;
		} catch {
			// non-JSON noise on stdout — ignore
		}
	}
	return { ...(outcome ? { outcome } : {}), ...(meter ? { meter } : {}) };
}

// ── Live-worker registry: teardown when the CLI itself is terminated (review C25) ──

interface LiveWorker {
	caseId: string;
	trial: number;
	lastMeter: () => TrialMeter | undefined;
	/** Write end of the parent-liveness pipe. Held so it stays open until this process exits. */
	liveness?: ChildProcess['stdio'][number];
}

const liveWorkers = new Map<ChildProcess, LiveWorker>();

export function liveWorkerCount(): number {
	return liveWorkers.size;
}

export interface TerminatedWorker extends TrialMeter {
	caseId: string;
	trial: number;
	pid: number | undefined;
	reason: string;
}

/**
 * SIGKILL every live worker and report each one's last meter. The GUI's
 * SIGTERM (`subprocess.ts` `sigtermWithSigkillFallback`) and an operator's
 * Ctrl-C reach only the CLI pid; without this the workers would keep running
 * and spending after the CLI is gone.
 */
export function killLiveWorkers(reason: string): TerminatedWorker[] {
	const killed: TerminatedWorker[] = [];
	for (const [child, w] of liveWorkers) {
		try {
			child.kill('SIGKILL');
		} catch {
			/* already dead */
		}
		killed.push({
			caseId: w.caseId,
			trial: w.trial,
			pid: child.pid,
			reason,
			...(w.lastMeter() ?? ZERO_METER),
		});
	}
	return killed;
}

const SIGNAL_EXIT_CODE: Partial<Record<NodeJS.Signals, number>> = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGTERM: 143,
};

function formatCrash(reason: unknown): string {
	return reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
}

/**
 * Install once from `cli-main.ts`. On SIGTERM/SIGINT/SIGHUP, and also on
 * `uncaughtException` / `unhandledRejection` / process `exit`: SIGKILL every
 * live worker and log one `{"type":"worker-terminated",…}` line per worker
 * (stderr, with its last meter). Signal handlers then exit 128+signal.
 * Exception handlers log the crash and exit 1 so it stays visible. The `exit`
 * handler only kills — it must not call `process.exit` again. Returns a
 * disposer (tests).
 */
export function installWorkerTeardown(
	proc: Pick<NodeJS.Process, 'once' | 'on' | 'exit'> = process,
	opts: { signals?: NodeJS.Signals[]; log?: (line: string) => void } = {},
): () => void {
	const signals = opts.signals ?? ['SIGTERM', 'SIGINT', 'SIGHUP'];
	const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	let disposed = false;
	let cleaned = false;
	const report = (reason: string) => {
		if (disposed || cleaned) return;
		cleaned = true;
		for (const k of killLiveWorkers(reason)) {
			log(JSON.stringify({ type: 'worker-terminated', ...k }));
		}
	};
	for (const sig of signals) {
		proc.once(sig, () => {
			report(`parent received ${sig}`);
			proc.exit(SIGNAL_EXIT_CODE[sig] ?? 1);
		});
	}
	const crash = (kind: string, reason: unknown) => {
		report(`parent ${kind}`);
		log(formatCrash(reason));
		proc.exit(1);
	};
	proc.on('uncaughtException', (err) => crash('uncaughtException', err));
	proc.on('unhandledRejection', (reason) => crash('unhandledRejection', reason));
	proc.on('exit', () => {
		report('parent exit');
	});
	return () => {
		disposed = true;
	};
}

export function spawnAgentTrial(
	opts: SpawnOptions,
	request: AgentWorkerRequest,
): Promise<AgentTrialOutcome> {
	const label = `trial ${request.trial.trial}/${request.trial.repeats}`;
	const start = Date.now();
	let stdout = '';
	let pendingLine = '';
	let lastMeter: TrialMeter | undefined;
	// On any failure, charge the last cumulative meter the worker reported so
	// spend that already happened is never dropped from budgets or reports.
	const fail = (why: string): AgentTrialOutcome => ({
		verdict: 'error',
		details: `${label}: ${why}`,
		transcript: '',
		...(lastMeter ?? parseWorkerStdout(stdout).meter ?? ZERO_METER),
		durationMs: Date.now() - start,
	});
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (opts.tsconfigPath) env.TSX_TSCONFIG_PATH = opts.tsconfigPath;
		const child = spawn(
			process.execPath,
			[...(opts.execArgv ?? ['--import=tsx/esm']), opts.workerPath],
			{
				cwd: opts.cwd,
				env,
				// fd 3 stays open for the parent's lifetime. The worker treats EOF
				// on it as "parent is gone" — stdin cannot, because it is ended
				// as soon as the request JSON is written.
				stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
			},
		);
		const liveness = child.stdio[3];
		liveWorkers.set(child, {
			caseId: request.trial.caseId,
			trial: request.trial.trial,
			lastMeter: () => lastMeter,
			liveness,
		});
		let stderr = '';
		let settled = false;
		const settle = (o: AgentTrialOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			liveWorkers.delete(child);
			resolve(o);
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			settle(fail(`timed out after ${opts.timeoutMs} ms`));
		}, opts.timeoutMs);
		child.stdout.on('data', (c: Buffer) => {
			const text = c.toString();
			stdout += text;
			// Relay complete `meter` lines as they arrive (a chunk may hold a partial line).
			pendingLine += text;
			let nl = pendingLine.indexOf('\n');
			while (nl >= 0) {
				const m = parseMeterLine(pendingLine.slice(0, nl));
				pendingLine = pendingLine.slice(nl + 1);
				if (m) {
					lastMeter = m;
					opts.onMeter?.(m);
				}
				nl = pendingLine.indexOf('\n');
			}
		});
		child.stderr.on('data', (c: Buffer) => {
			stderr = `${stderr}${c.toString()}`.slice(-STDERR_TAIL);
		});
		child.on('error', (err) => settle(fail(`spawn failed: ${err.message}`)));
		child.on('close', (code) => {
			const { outcome } = parseWorkerStdout(stdout);
			settle(outcome ?? fail(`worker exited ${code} without a result; stderr: ${stderr.trim()}`));
		});
		child.stdin.end(JSON.stringify(request));
	});
}
