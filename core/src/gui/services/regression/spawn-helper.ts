/**
 * Shared subprocess scaffolding for the regression CLI.
 *
 * Both `case-discovery.ts` (one-shot `--list` mode) and `subprocess.ts`
 * (long-running run mode) need to spawn the regression CLI the same way:
 *
 *   - via `process.execPath --import=tsx/esm <abs cli path>` so we don't
 *     depend on `tsx` being on PATH (Codex M4)
 *   - with `TSX_TSCONFIG_PATH` set so tsx finds the `@core/*` aliases
 *     (the worktree's regression/tsconfig.json)
 *   - with `stdio: ['ignore', 'pipe', 'pipe']`
 *
 * This helper centralises the invocation. Each caller still does its
 * own readline NDJSON parsing because the per-line result shape differs
 * (case-list vs case-result/summary).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Maximum number of bytes of child stderr kept for diagnostics. */
export const STDERR_TAIL_MAX_BYTES = 4096;

export interface RegressionSpawnTarget {
	/** Absolute path to `regression/src/runner/cli-main.ts`. */
	cliPath: string;
	/** Working directory for the subprocess (typically the repo root). */
	cwd?: string;
	/** Path to `regression/tsconfig.json` — sets `TSX_TSCONFIG_PATH`. */
	tsconfigPath?: string;
}

export type RegressionChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export function spawnRegressionCli(
	target: RegressionSpawnTarget,
	args: readonly string[],
): RegressionChildProcess {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (target.tsconfigPath) env.TSX_TSCONFIG_PATH = target.tsconfigPath;
	return nodeSpawn(process.execPath, ['--import=tsx/esm', target.cliPath, ...args], {
		cwd: target.cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	}) as RegressionChildProcess;
}

/**
 * Bounded-buffer stderr appender. Used by both `case-discovery` and
 * `subprocess` to keep the last 4 KiB of stderr available for the
 * terminal `failed` event payload without unbounded memory growth.
 */
export function appendStderrTail(prev: string, chunk: Buffer | string): string {
	return `${prev}${chunk.toString()}`.slice(-STDERR_TAIL_MAX_BYTES);
}
