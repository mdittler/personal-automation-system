import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
	parseJudgeModelValue,
	parseModelMatrixValue,
} from '../../../services/regression/model-spec.js';
import { VALID_BUCKETS } from '../../../types/regression.js';
import {
	type RegressionSpawnTarget,
	appendStderrTail,
	spawnRegressionCli,
} from './spawn-helper.js';

const SAFE_RERUN_ID = /^[a-z][a-z0-9-]{0,127}$/;

const ALLOWED_SCALAR_ARGS = new Set(['--json', '--dry-run', '--list']);
const ALLOWED_BUCKET_PREFIX = '--bucket=';
const ALLOWED_RERUN_PREFIX = '--rerun=';
const ALLOWED_MODEL_MATRIX_PREFIX = '--model-matrix=';
const ALLOWED_JUDGE_MODEL_PREFIX = '--judge-model=';

/** Throws when any arg is not on the spawn allowlist (defense in depth). */
export function validateSpawnArgs(args: readonly string[]): void {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (ALLOWED_SCALAR_ARGS.has(a)) continue;
		if (a.startsWith(ALLOWED_BUCKET_PREFIX)) {
			const v = a.slice(ALLOWED_BUCKET_PREFIX.length);
			if (!(VALID_BUCKETS as readonly string[]).includes(v)) {
				throw new Error(
					`spawn allowlist: unknown bucket "${v}" (expected one of ${VALID_BUCKETS.join(', ')})`,
				);
			}
			continue;
		}
		if (a.startsWith(ALLOWED_RERUN_PREFIX)) {
			const v = a.slice(ALLOWED_RERUN_PREFIX.length);
			if (!SAFE_RERUN_ID.test(v)) {
				throw new Error(`spawn allowlist: invalid --rerun id "${v}"`);
			}
			continue;
		}
		// Codex I1: also accept the two-token form `--rerun <id>`.
		if (a === '--rerun') {
			const v = args[i + 1];
			if (!v || !SAFE_RERUN_ID.test(v)) {
				throw new Error(`spawn allowlist: invalid --rerun id "${String(v)}"`);
			}
			i++;
			continue;
		}
		// REQ-REG-GUI-OV-004: --model-matrix and --judge-model (equals form only,
		// re-validated through the shared parser for defense in depth).
		if (a.startsWith(ALLOWED_MODEL_MATRIX_PREFIX)) {
			const v = a.slice(ALLOWED_MODEL_MATRIX_PREFIX.length);
			try {
				parseModelMatrixValue(v);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`spawn allowlist: invalid --model-matrix "${v}": ${msg}`);
			}
			continue;
		}
		if (a.startsWith(ALLOWED_JUDGE_MODEL_PREFIX)) {
			const v = a.slice(ALLOWED_JUDGE_MODEL_PREFIX.length);
			try {
				parseJudgeModelValue(v);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`spawn allowlist: invalid --judge-model "${v}": ${msg}`);
			}
			continue;
		}
		throw new Error(`spawn allowlist: forbidden arg "${a}"`);
	}
}

export type SpawnProcLike = EventEmitter & {
	stdout: Readable;
	stderr: Readable;
	kill: (signal?: NodeJS.Signals) => boolean;
	pid?: number;
};

export type SpawnFn = () => SpawnProcLike;

export type RegressionEvent =
	| { type: 'case-result'; result: unknown }
	| { type: 'summary'; summary: unknown }
	| { type: 'complete'; summary: unknown }
	| { type: 'gate-failed'; summary: unknown; exitCode: number }
	| { type: 'failed'; exitCode: number; stderrTail: string }
	| { type: 'cancelled' };

export interface SpawnRegressionOptions extends Partial<RegressionSpawnTarget> {
	spawnFn?: SpawnFn;
	onEvent: (event: RegressionEvent) => void;
	signal?: AbortSignal;
}

function defaultSpawn(args: readonly string[], options: SpawnRegressionOptions): SpawnProcLike {
	if (!options.cliPath) {
		throw new Error('spawnRegression: cliPath is required when no spawnFn override is set');
	}
	return spawnRegressionCli(
		{ cliPath: options.cliPath, cwd: options.cwd, tsconfigPath: options.tsconfigPath },
		args,
	) as unknown as SpawnProcLike;
}

export interface SpawnRegressionHandle {
	pid: number | undefined;
	cancel(): void;
	whenComplete: Promise<void>;
}

export async function spawnRegression(
	args: readonly string[],
	options: SpawnRegressionOptions,
): Promise<SpawnRegressionHandle> {
	validateSpawnArgs(args);
	const spawnFn: SpawnFn = options.spawnFn ?? (() => defaultSpawn(args, options));
	const proc = spawnFn();
	let cancelled = false;
	let summaryReceived: unknown = undefined;
	let stderrTail = '';

	proc.stderr.on('data', (chunk: Buffer | string) => {
		stderrTail = appendStderrTail(stderrTail, chunk);
	});

	const reader = createInterface({ input: proc.stdout });
	const linePromise = (async () => {
		for await (const rawLine of reader) {
			const line = rawLine.trim();
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// Codex I3: non-JSON line — skip silently. (We do not console.warn
				// in tests because the harness flags it; production diagnostic logs
				// route via the parent process's pino instance.)
				continue;
			}
			if (typeof parsed !== 'object' || parsed === null) continue;
			const obj = parsed as { type?: string; result?: unknown; summary?: unknown };
			if (obj.type === 'case-result' && 'result' in obj) {
				options.onEvent({ type: 'case-result', result: obj.result });
			} else if (obj.type === 'summary' && 'summary' in obj) {
				summaryReceived = obj.summary;
				options.onEvent({ type: 'summary', summary: obj.summary });
			}
			// Unknown types ignored (Codex I3).
		}
	})();

	const exitPromise = new Promise<number>((resolve) => {
		proc.on('exit', (code: number | null) => resolve(code ?? 1));
	});

	// SIGTERM with a SIGKILL fallback after `SIGKILL_GRACE_MS`. Both the
	// AbortSignal path (Codex P1: registry-driven cancel) and the direct
	// `handle.cancel()` path share this helper; the timer is cleared when
	// the child exits so well-behaved children never receive SIGKILL.
	let killTimer: NodeJS.Timeout | null = null;
	const SIGKILL_GRACE_MS = 5000;
	function sigtermWithSigkillFallback(): void {
		try {
			proc.kill('SIGTERM');
		} catch {
			/* already dead */
		}
		if (killTimer) return;
		killTimer = setTimeout(() => {
			try {
				proc.kill('SIGKILL');
			} catch {
				/* already dead */
			}
		}, SIGKILL_GRACE_MS);
	}
	proc.on('exit', () => {
		if (killTimer) {
			clearTimeout(killTimer);
			killTimer = null;
		}
	});

	const whenComplete = (async () => {
		// Wire cancel BEFORE awaiting in case the caller fires it synchronously.
		options.signal?.addEventListener('abort', () => {
			cancelled = true;
			sigtermWithSigkillFallback();
		});
		await linePromise;
		const exitCode = await exitPromise;
		if (cancelled) {
			options.onEvent({ type: 'cancelled' });
			return;
		}
		if (summaryReceived !== undefined) {
			if (exitCode === 0) {
				options.onEvent({ type: 'complete', summary: summaryReceived });
			} else {
				options.onEvent({ type: 'gate-failed', summary: summaryReceived, exitCode });
			}
			return;
		}
		options.onEvent({ type: 'failed', exitCode, stderrTail });
	})();

	return {
		pid: proc.pid,
		cancel: () => {
			cancelled = true;
			sigtermWithSigkillFallback();
		},
		whenComplete,
	};
}
