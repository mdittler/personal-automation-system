import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killLiveWorkers, spawnAgentTrial } from '../runner/agent-trial-spawn.js';

const LIVENESS_HREF = pathToFileURL(
	fileURLToPath(new URL('../runner/parent-liveness.ts', import.meta.url)),
).href;
const REGRESSION_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSCONFIG = join(REGRESSION_ROOT, 'tsconfig.json');

/**
 * Real worker: imports installParentLiveness (fd 3, not an injected stream)
 * and never calls process.exit. `finish` prints a trial-result and returns;
 * `busy` stays alive on a ref'd interval until the parent pipe closes.
 */
function workerSource(mode: 'finish' | 'busy', pidFile: string, statusFile: string): string {
	const afterInstall =
		mode === 'busy'
			? `setInterval(() => {}, 500);
  process.stdout.write('ready\\n');`
			: `process.stdin.resume();
  process.stdin.on('end', () => {
    console.log(JSON.stringify({ type: 'trial-result', outcome: { verdict: 'pass', details: 'natural-return', transcript: '', costUsd: 0, tokenIn: 0, tokenOut: 0, durationMs: 1 } }));
  });`;
	return `
import { fstatSync, writeFileSync } from 'node:fs';
import { installParentLiveness } from ${JSON.stringify(LIVENESS_HREF)};
let kind = 'fd3-absent';
try {
  const st = fstatSync(3);
  // Node stdio pipes are socketpairs on macOS (S_IFSOCK), FIFOs elsewhere.
  kind = st.isSocket() || st.isFIFO() ? 'fd3-pipe' : 'fd3-not-pipe';
} catch {}
writeFileSync(${JSON.stringify(statusFile)}, kind);
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (kind !== 'fd3-pipe') {
  console.log(JSON.stringify({ type: 'trial-result', outcome: { verdict: 'error', details: kind, transcript: '', costUsd: 0, tokenIn: 0, tokenOut: 0, durationMs: 1 } }));
} else {
  installParentLiveness();
  ${afterInstall}
}
`;
}

const request = {
	trial: {
		caseId: 'agent-t',
		trial: 2,
		repeats: 3,
		payload: { turns: [{ text: 'q' }] },
		expectation: { set: 'regression' as const, category: 'no-tool' as const },
	},
	fixturesDir: '/x',
	productionConfigPath: '/x/pas.yaml',
	repoRoot: '/x',
};

let dir: string;
let pidFile: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'liveness-'));
	pidFile = join(dir, 'worker.pid');
});

afterEach(async () => {
	killLiveWorkers('test cleanup');
	try {
		const pid = Number(await readFile(pidFile, 'utf8'));
		if (pid > 0) process.kill(pid, 'SIGKILL');
	} catch {
		// already exited, or the worker never wrote a pid
	}
	await rm(dir, { recursive: true, force: true });
});

async function statusText(statusFile: string, fallback: string): Promise<string> {
	try {
		return (await readFile(statusFile, 'utf8')).trim();
	} catch {
		return fallback;
	}
}

function childAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('parent liveness on a real fd-3 pipe (R6-1)', () => {
	it('settles a naturally returning worker in under 3s with the trial result, and the child has exited', async () => {
		const statusFile = join(dir, 'fd3.status');
		const workerPath = join(dir, 'finish.mjs');
		await writeFile(workerPath, workerSource('finish', pidFile, statusFile));
		const started = Date.now();
		const out = await spawnAgentTrial(
			{
				workerPath,
				execArgv: ['--import=tsx/esm'],
				cwd: REPO_ROOT,
				tsconfigPath: TSCONFIG,
				timeoutMs: 10_000,
			},
			request,
		);
		const elapsed = Date.now() - started;
		const status = await statusText(statusFile, `missing; ${out.verdict}: ${out.details}`);
		expect(status).toBe('fd3-pipe');
		expect(elapsed, out.details).toBeLessThan(3000);
		expect(out).toMatchObject({ verdict: 'pass', details: 'natural-return' });
		const pid = Number(await readFile(pidFile, 'utf8'));
		expect(childAlive(pid)).toBe(false);
	}, 20_000);

	it('exits within 2s when the parent destroys the fd-3 write end', async () => {
		const statusFile = join(dir, 'fd3.status');
		const workerPath = join(dir, 'busy.mjs');
		await writeFile(workerPath, workerSource('busy', pidFile, statusFile));
		const child = spawn(process.execPath, ['--import=tsx/esm', workerPath], {
			cwd: REPO_ROOT,
			env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
			stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
		});
		const errBox = { text: '' };
		child.stderr?.on('data', (c: Buffer) => {
			errBox.text = `${errBox.text}${c.toString()}`.slice(-2000);
		});
		await waitUntilReady(child, errBox);
		const status = await statusText(statusFile, `missing; stderr: ${errBox.text}`);
		expect(status).toBe('fd3-pipe');
		const pipe = child.stdio[3];
		expect(pipe && 'destroy' in pipe).toBe(true);
		const started = Date.now();
		(pipe as { destroy: () => void }).destroy();
		const code = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`worker still alive 2s after parent pipe closed; stderr: ${errBox.text}`));
			}, 2000);
			if (child.exitCode !== null) {
				clearTimeout(timer);
				resolve(child.exitCode);
				return;
			}
			child.once('exit', (c) => {
				clearTimeout(timer);
				resolve(c);
			});
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(code).toBe(1);
		const pid = Number(await readFile(pidFile, 'utf8'));
		expect(childAlive(pid)).toBe(false);
	}, 15_000);
});

function waitUntilReady(child: ChildProcess, stderr: { text: string }): Promise<void> {
	return new Promise((resolve, reject) => {
		let out = '';
		const timer = setTimeout(() => {
			reject(new Error(`worker did not become ready; stderr: ${stderr.text}`));
		}, 8_000);
		child.stdout?.on('data', (c: Buffer) => {
			out += c.toString();
			if (out.includes('ready')) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`worker exited ${code} before ready; stderr: ${stderr.text}`));
		});
	});
}
