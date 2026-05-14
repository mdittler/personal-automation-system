import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
	parseJudgeModelValue,
	parseModelMatrixValue,
} from '../../../services/regression/model-spec.js';
import { SAFE_RUN_ID_RE, VALID_BUCKETS } from '../../../types/regression.js';
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
const ALLOWED_RUN_ID_PREFIX = '--run-id=';

/** Throws when any arg is not on the spawn allowlist (defense in depth). */
export function validateSpawnArgs(args: readonly string[]): void {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === undefined) break;
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
		// REQ-REG-GUI-OV-004: defense-in-depth re-validation through the same
		// shared parser the POST handler used.
		if (revalidatePrefixedArg(a, ALLOWED_MODEL_MATRIX_PREFIX, parseModelMatrixValue)) continue;
		if (revalidatePrefixedArg(a, ALLOWED_JUDGE_MODEL_PREFIX, parseJudgeModelValue)) continue;
		// REQ-REG-GUI-V2-003: --run-id=<uuid> — strictly UUID-shaped.
		if (a.startsWith(ALLOWED_RUN_ID_PREFIX)) {
			const v = a.slice(ALLOWED_RUN_ID_PREFIX.length);
			if (!SAFE_RUN_ID_RE.test(v)) {
				throw new Error(`spawn allowlist: invalid --run-id "${v}" (must be UUID)`);
			}
			continue;
		}
		throw new Error(`spawn allowlist: forbidden arg "${a}"`);
	}
}

/**
 * If `arg` starts with `prefix`, slice off the value, run it through `parser`,
 * and return `true` (caller should `continue`). Throws a `spawn allowlist:`
 * error on parser failure. Returns `false` when the arg doesn't match the
 * prefix, leaving caller to fall through to the next check.
 */
function revalidatePrefixedArg(
	arg: string,
	prefix: string,
	parser: (v: string) => unknown,
): boolean {
	if (!arg.startsWith(prefix)) return false;
	const v = arg.slice(prefix.length);
	try {
		parser(v);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`spawn allowlist: invalid ${prefix.replace(/=$/, '')} "${v}": ${msg}`);
	}
	return true;
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

	// Single-shot terminal-event latch. Stream errors race normal exit, cancel
	// races with crashes, and spawn ENOENT fires proc.on('error') without ever
	// producing an exit event. `finishOnce` lets every path call without fear
	// of double-emit; `terminatedPromise` lets `whenComplete` short-circuit
	// the normal exit-wait when an error path fires first; `resolveExit` lets
	// finishOnce unstick `normalPath` (otherwise its closures leak until GC).
	let finished = false;
	let resolveTerminated!: () => void;
	const terminatedPromise = new Promise<void>((res) => {
		resolveTerminated = res;
	});
	let resolveExit!: (code: number) => void;
	const exitPromise = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	function finishOnce(event: RegressionEvent): void {
		if (finished) return;
		finished = true;
		options.onEvent(event);
		resolveTerminated();
		// Unstick the normal exit path so its closures can be GC'd. proc.error
		// on spawn ENOENT fires no exit event, leaving normalPath pending forever.
		// Promise.resolve is idempotent, so the real exit listener (if it does
		// fire later) just no-ops.
		resolveExit(1);
	}
	const onSurfaceError =
		(label: string) =>
		(err: Error): void => {
			// If cancel is already in flight, downstream stream errors are
			// expected (the child is being torn down). Report cancelled instead
			// of failed so an operator-initiated cancel isn't misclassified.
			if (cancelled) {
				finishOnce({ type: 'cancelled' });
				return;
			}
			finishOnce({ type: 'failed', exitCode: 1, stderrTail: `${label} error: ${err.message}` });
		};

	proc.stderr.on('data', (chunk: Buffer | string) => {
		stderrTail = appendStderrTail(stderrTail, chunk);
	});

	proc.on('error', onSurfaceError('spawn'));
	proc.stdout.on('error', onSurfaceError('stdout'));
	proc.stderr.on('error', onSurfaceError('stderr'));

	const reader = createInterface({ input: proc.stdout });
	const linePromise = (async () => {
		try {
			for await (const rawLine of reader) {
				const line = rawLine.trim();
				if (!line) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
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
			}
		} catch (err) {
			if (cancelled) {
				finishOnce({ type: 'cancelled' });
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			finishOnce({ type: 'failed', exitCode: 1, stderrTail: `reader error: ${msg}` });
		}
	})();

	proc.on('exit', (code: number | null) => resolveExit(code ?? 1));

	// SIGTERM with a SIGKILL fallback after `SIGKILL_GRACE_MS`. Both the
	// AbortSignal path (registry-driven cancel) and the direct
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
		// Race the normal exit path against terminatedPromise so spawn ENOENT
		// (proc.on('error') fires, exitPromise never resolves) doesn't hang.
		const normalPath = (async () => {
			await linePromise;
			const exitCode = await exitPromise;
			if (cancelled) {
				finishOnce({ type: 'cancelled' });
				return;
			}
			if (summaryReceived !== undefined) {
				if (exitCode === 0) {
					finishOnce({ type: 'complete', summary: summaryReceived });
				} else {
					finishOnce({ type: 'gate-failed', summary: summaryReceived, exitCode });
				}
				return;
			}
			finishOnce({ type: 'failed', exitCode, stderrTail });
		})();
		try {
			await Promise.race([normalPath, terminatedPromise]);
		} finally {
			// Backstop: guarantees `whenComplete` always corresponds to a
			// dispatched terminal event, even on paths that bypass finishOnce.
			finishOnce({
				type: 'failed',
				exitCode: 1,
				stderrTail: 'subprocess ended without terminal event',
			});
		}
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
