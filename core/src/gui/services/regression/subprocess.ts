import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

const VALID_BUCKETS = ['routing', 'receipt', 'chatbot', 'recall'] as const;
const SAFE_RERUN_ID = /^[a-z][a-z0-9-]{0,127}$/;

const ALLOWED_SCALAR_ARGS = new Set(['--json', '--dry-run', '--list']);
const ALLOWED_BUCKET_PREFIX = '--bucket=';
const ALLOWED_RERUN_PREFIX = '--rerun=';

/** Throws when any arg is not on the spawn allowlist (defense in depth). */
export function validateSpawnArgs(args: readonly string[]): void {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (ALLOWED_SCALAR_ARGS.has(a)) continue;
		if (a.startsWith(ALLOWED_BUCKET_PREFIX)) {
			const v = a.slice(ALLOWED_BUCKET_PREFIX.length);
			if (!(VALID_BUCKETS as readonly string[]).includes(v)) {
				throw new Error(`spawn allowlist: unknown bucket "${v}"`);
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

export interface SpawnRegressionOptions {
	spawnFn?: SpawnFn;
	cliPath?: string;
	cwd?: string;
	tsconfigPath?: string;
	onEvent: (event: RegressionEvent) => void;
	signal?: AbortSignal;
}

function defaultSpawn(args: readonly string[], options: SpawnRegressionOptions): SpawnProcLike {
	if (!options.cliPath) {
		throw new Error('spawnRegression: cliPath is required when no spawnFn override is set');
	}
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (options.tsconfigPath) env.TSX_TSCONFIG_PATH = options.tsconfigPath;
	return nodeSpawn(process.execPath, ['--import=tsx/esm', options.cliPath, ...args], {
		cwd: options.cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	}) as unknown as SpawnProcLike;
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
		stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4096);
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

	const whenComplete = (async () => {
		// Wire cancel BEFORE awaiting in case the caller fires it synchronously.
		options.signal?.addEventListener('abort', () => {
			cancelled = true;
			proc.kill('SIGTERM');
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
			proc.kill('SIGTERM');
		},
		whenComplete,
	};
}
