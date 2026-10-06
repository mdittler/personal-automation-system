import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	METER_INTERVAL_MS,
	WORKER_TIMEOUT_MS,
	installWorkerTeardown,
	killLiveWorkers,
	liveWorkerCount,
	parseMeterLine,
	spawnAgentTrial,
} from '../runner/agent-trial-spawn.js';

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'spawn-'));
});
afterEach(async () => {
	killLiveWorkers('test cleanup');
	await rm(dir, { recursive: true, force: true });
});

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

async function worker(src: string): Promise<string> {
	const p = join(dir, 'w.mjs');
	await writeFile(p, src);
	return p;
}

describe('spawnAgentTrial (REQ-REG-AGENT-002)', () => {
	it('sends the request on stdin and parses the trial-result line', async () => {
		const p = await worker(`
			let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => {
				const req = JSON.parse(s);
				console.log('noise line');
				console.log(JSON.stringify({ type: 'trial-result', outcome: { verdict: 'pass', details: 'trial ' + req.trial.trial, transcript: '', costUsd: 0.01, tokenIn: 5, tokenOut: 6, durationMs: 1 } }));
			});`);
		const out = await spawnAgentTrial(
			{ workerPath: p, execArgv: [], cwd: dir, timeoutMs: 10_000 },
			request,
		);
		expect(out).toMatchObject({ verdict: 'pass', details: 'trial 2', costUsd: 0.01, tokenIn: 5 });
	});

	it('maps a crashing worker to an error outcome carrying the stderr tail', async () => {
		const p = await worker(
			`process.stdin.resume(); process.stdin.on('end', () => { console.error('boom: compose failed'); process.exit(3); });`,
		);
		const out = await spawnAgentTrial(
			{ workerPath: p, execArgv: [], cwd: dir, timeoutMs: 10_000 },
			request,
		);
		expect(out.verdict).toBe('error');
		expect(out.details).toMatch(/trial 2\/3: worker exited 3.*boom: compose failed/s);
	});

	it('charges the last reported meter when the worker crashes mid-trial', async () => {
		const p = await worker(`process.stdin.resume(); process.stdin.on('end', () => {
			console.log(JSON.stringify({ type: 'meter', costUsd: 0.02, tokenIn: 10, tokenOut: 4 }));
			console.log(JSON.stringify({ type: 'meter', costUsd: 0.05, tokenIn: 30, tokenOut: 9 }));
			process.exit(1);
		});`);
		const out = await spawnAgentTrial(
			{ workerPath: p, execArgv: [], cwd: dir, timeoutMs: 10_000 },
			request,
		);
		expect(out.verdict).toBe('error');
		expect(out).toMatchObject({ costUsd: 0.05, tokenIn: 30, tokenOut: 9 });
	});

	it('kills a hung worker after the timeout and reports error', async () => {
		const p = await worker('setInterval(() => {}, 1000);');
		const out = await spawnAgentTrial(
			{ workerPath: p, execArgv: [], cwd: dir, timeoutMs: 300 },
			request,
		);
		expect(out.verdict).toBe('error');
		expect(out.details).toMatch(/timed out after 300 ms/);
		expect(liveWorkerCount()).toBe(0);
	});

	it('kills a hung worker that ignores SIGTERM (timeout uses SIGKILL; review R4-1)', async () => {
		const pidFile = join(dir, 'hung.pid');
		const p = await worker(
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
		);
		const out = await spawnAgentTrial(
			{ workerPath: p, execArgv: [], cwd: dir, timeoutMs: 300 },
			request,
		);
		expect(out.verdict).toBe('error');
		const pid = Number(await readFile(pidFile, 'utf8'));
		let alive = true;
		for (let i = 0; i < 40 && alive; i++) {
			try {
				process.kill(pid, 0);
				await new Promise((r) => setTimeout(r, 25));
			} catch {
				alive = false;
			}
		}
		if (alive) process.kill(pid, 'SIGKILL');
		expect(alive).toBe(false);
	});

	it('forwards each meter line to onMeter as it arrives, before the result (heartbeat source; review C25)', async () => {
		const p = await worker(`process.stdin.resume(); process.stdin.on('end', () => {
			let n = 0;
			const t = setInterval(() => {
				n++;
				console.log(JSON.stringify({ type: 'meter', costUsd: n / 100, tokenIn: n, tokenOut: n }));
				if (n === 3) {
					clearInterval(t);
					console.log(JSON.stringify({ type: 'trial-result', outcome: { verdict: 'pass', details: 'ok', transcript: '', costUsd: 0.03, tokenIn: 3, tokenOut: 3, durationMs: 1 } }));
				}
			}, 20);
		});`);
		let resolved = false;
		const seen: Array<{ costUsd: number; resolvedYet: boolean }> = [];
		const pending = spawnAgentTrial(
			{
				workerPath: p,
				execArgv: [],
				cwd: dir,
				timeoutMs: 10_000,
				onMeter: (m) => seen.push({ costUsd: m.costUsd, resolvedYet: resolved }),
			},
			request,
		);
		const out = await pending;
		resolved = true;
		expect(out.verdict).toBe('pass');
		expect(seen.map((s) => s.costUsd)).toEqual([0.01, 0.02, 0.03]);
		expect(seen.every((s) => s.resolvedYet === false)).toBe(true);
	});

	it('parseMeterLine accepts only meter lines', () => {
		expect(parseMeterLine('{"type":"meter","costUsd":0.5,"tokenIn":1,"tokenOut":2}')).toEqual({
			costUsd: 0.5,
			tokenIn: 1,
			tokenOut: 2,
		});
		expect(parseMeterLine('{"type":"trial-result"}')).toBeUndefined();
		expect(parseMeterLine('noise')).toBeUndefined();
	});

	it('installWorkerTeardown kills live workers on a parent signal, logs their last meter, and exits 128+signal', async () => {
		const p = await worker(`process.stdin.resume(); process.stdin.on('end', () => {
			console.log(JSON.stringify({ type: 'meter', costUsd: 0.02, tokenIn: 10, tokenOut: 4 }));
			setInterval(() => {}, 1000);
		});`);
		const handlers: Partial<Record<NodeJS.Signals, () => void>> = {};
		const fakeProc = {
			once: vi.fn((sig: NodeJS.Signals, fn: () => void) => {
				handlers[sig] = fn;
				return fakeProc;
			}),
			on: vi.fn(() => fakeProc),
			exit: vi.fn(),
		};
		const log = vi.fn();
		const dispose = installWorkerTeardown(fakeProc as unknown as NodeJS.Process, { log });
		let metered = false;
		const pending = spawnAgentTrial(
			{
				workerPath: p,
				execArgv: [],
				cwd: dir,
				timeoutMs: 10_000,
				onMeter: () => {
					metered = true;
				},
			},
			request,
		);
		await vi.waitFor(() => expect(metered).toBe(true), { timeout: 5000 });
		expect(liveWorkerCount()).toBe(1);

		handlers.SIGTERM!();

		expect(fakeProc.exit).toHaveBeenCalledWith(143);
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/"type":"worker-terminated".*"costUsd":0\.02/),
		);
		const out = await pending; // SIGKILLed child closes → promise settles as error, charging the last meter
		expect(out.verdict).toBe('error');
		expect(out).toMatchObject({ costUsd: 0.02, tokenIn: 10, tokenOut: 4 });
		expect(liveWorkerCount()).toBe(0);
		dispose();
	});

	it('pins the production timers (review C27)', () => {
		expect(METER_INTERVAL_MS).toBe(2000);
		expect(WORKER_TIMEOUT_MS).toBe(15 * 60_000);
	});

	it('settles as an error verdict when spawn emits error (ENOENT) and does not hang', async () => {
		const out = await spawnAgentTrial(
			{
				workerPath: join(dir, 'missing-worker.mjs'),
				execArgv: [],
				cwd: join(dir, 'no-such-cwd'),
				timeoutMs: 5_000,
			},
			request,
		);
		expect(out.verdict).toBe('error');
		expect(out.details).toMatch(/ENOENT/);
		expect(liveWorkerCount()).toBe(0);
	});

	async function meteredWorker(): Promise<{
		pending: ReturnType<typeof spawnAgentTrial>;
		handlers: Record<string, (...args: unknown[]) => void>;
		fakeProc: { exit: ReturnType<typeof vi.fn> };
		log: ReturnType<typeof vi.fn>;
		dispose: () => void;
	}> {
		const p = await worker(`process.stdin.resume(); process.stdin.on('end', () => {
			console.log(JSON.stringify({ type: 'meter', costUsd: 0.02, tokenIn: 10, tokenOut: 4 }));
			setInterval(() => {}, 1000);
		});`);
		const handlers: Record<string, (...args: unknown[]) => void> = {};
		const fakeProc = {
			once: vi.fn((ev: string, fn: (...args: unknown[]) => void) => {
				handlers[ev] = fn;
				return fakeProc;
			}),
			on: vi.fn((ev: string, fn: (...args: unknown[]) => void) => {
				handlers[ev] = fn;
				return fakeProc;
			}),
			exit: vi.fn(),
		};
		const log = vi.fn();
		const dispose = installWorkerTeardown(fakeProc as unknown as NodeJS.Process, { log });
		let metered = false;
		const pending = spawnAgentTrial(
			{
				workerPath: p,
				execArgv: [],
				cwd: dir,
				timeoutMs: 10_000,
				onMeter: () => {
					metered = true;
				},
			},
			request,
		);
		await vi.waitFor(() => expect(metered).toBe(true), { timeout: 5000 });
		expect(liveWorkerCount()).toBe(1);
		return { pending, handlers, fakeProc, log, dispose };
	}

	it('kills registered workers and logs their last meter on uncaughtException, then exits non-zero', async () => {
		const { pending, handlers, fakeProc, log, dispose } = await meteredWorker();
		const onUncaught = handlers.uncaughtException;
		expect(onUncaught, 'uncaughtException handler').toBeTypeOf('function');
		onUncaught?.(new Error('boom'));
		expect(fakeProc.exit).toHaveBeenCalledWith(1);
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/"type":"worker-terminated".*"costUsd":0\.02/),
		);
		expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/boom/);
		const out = await pending;
		expect(out.verdict).toBe('error');
		expect(out).toMatchObject({ costUsd: 0.02, tokenIn: 10, tokenOut: 4 });
		expect(liveWorkerCount()).toBe(0);
		dispose();
	});

	it('kills registered workers and logs their last meter on unhandledRejection, then exits non-zero', async () => {
		const { pending, handlers, fakeProc, log, dispose } = await meteredWorker();
		const onRejection = handlers.unhandledRejection;
		expect(onRejection, 'unhandledRejection handler').toBeTypeOf('function');
		onRejection?.('rejection-boom');
		expect(fakeProc.exit).toHaveBeenCalledWith(1);
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/"type":"worker-terminated".*"costUsd":0\.02/),
		);
		expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/rejection-boom/);
		await pending;
		expect(liveWorkerCount()).toBe(0);
		dispose();
	});

	it('kills registered workers and logs their last meter on process exit without exiting again', async () => {
		const { pending, handlers, fakeProc, log, dispose } = await meteredWorker();
		const onExit = handlers.exit;
		expect(onExit, 'exit handler').toBeTypeOf('function');
		onExit?.(0);
		expect(fakeProc.exit).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/"type":"worker-terminated".*"costUsd":0\.02/),
		);
		const out = await pending;
		expect(out.verdict).toBe('error');
		expect(liveWorkerCount()).toBe(0);
		dispose();
	});
});
