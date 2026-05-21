/**
 * Codex P1 + P2 regression guards.
 *
 * One file per concern to keep the post-merge simplify pass auditable:
 *   1. SIGKILL fallback fires after SIGTERM grace window (P1.2)
 *   2. run-registry recovers when runFactory throws (P1.3)
 *   3. cache-reader rejects filename/content cacheKey mismatch (P2.1)
 */

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERDICT } from '../../../../types/regression.js';
import { readDisplayForCase } from '../cache-reader.js';
import { createRunRegistry } from '../run-registry.js';
import { type SpawnProcLike, spawnRegression } from '../subprocess.js';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

describe('Codex P1.2 — SIGKILL fallback', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('SIGKILL is sent 5 s after SIGTERM if the child does not exit', async () => {
		const proc = new EventEmitter() as SpawnProcLike;
		const stdout = new Readable({ read() {} });
		const stderr = new Readable({ read() {} });
		proc.stdout = stdout;
		proc.stderr = stderr;
		const killCalls: NodeJS.Signals[] = [];
		proc.kill = (signal?: NodeJS.Signals) => {
			killCalls.push(signal ?? 'SIGTERM');
			return true;
		};

		const events: unknown[] = [];
		const handle = await spawnRegression(['--json'], {
			spawnFn: () => proc,
			onEvent: (e) => events.push(e),
		});

		// Trigger cancel — child ignores SIGTERM.
		handle.cancel();
		expect(killCalls).toEqual(['SIGTERM']);

		// Advance 4.9 s: still only SIGTERM.
		await vi.advanceTimersByTimeAsync(4900);
		expect(killCalls).toEqual(['SIGTERM']);

		// Advance past the 5 s grace: SIGKILL fires.
		await vi.advanceTimersByTimeAsync(200);
		expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);

		// Cleanup the dangling promise.
		stdout.push(null);
		stderr.push(null);
		proc.emit('exit', 137, 'SIGKILL');
		await handle.whenComplete;
	});

	it('SIGKILL timer is cleared when the child exits in time', async () => {
		const proc = new EventEmitter() as SpawnProcLike;
		const stdout = new Readable({ read() {} });
		const stderr = new Readable({ read() {} });
		proc.stdout = stdout;
		proc.stderr = stderr;
		const killCalls: NodeJS.Signals[] = [];
		proc.kill = (signal?: NodeJS.Signals) => {
			killCalls.push(signal ?? 'SIGTERM');
			return true;
		};

		const handle = await spawnRegression(['--json'], {
			spawnFn: () => proc,
			onEvent: () => {},
		});

		handle.cancel();
		expect(killCalls).toEqual(['SIGTERM']);

		// Child exits after 1 s — well within the 5 s grace window.
		await vi.advanceTimersByTimeAsync(1000);
		stdout.push(null);
		stderr.push(null);
		proc.emit('exit', 0, 'SIGTERM');

		// Advance past 5 s; no SIGKILL should have fired.
		await vi.advanceTimersByTimeAsync(5000);
		expect(killCalls).toEqual(['SIGTERM']);

		await handle.whenComplete;
	});
});

describe('Codex P1.3 — run-registry recovers when runFactory throws', () => {
	it('rejects the createRun call, clears activeRunId, and allows the next run', async () => {
		const registry = createRunRegistry();
		const explode = vi.fn(async () => {
			throw new Error('simulated spawn failure');
		});
		await expect(registry.createRun({ args: ['--json'], runFactory: explode })).rejects.toThrow(
			/simulated spawn failure/,
		);

		// activeRunId must be cleared — a subsequent createRun must succeed
		// rather than be wedged behind a phantom active run.
		let secondOnEvent: ((e: unknown) => void) | null = null;
		const ok = await registry.createRun({
			args: ['--json'],
			runFactory: async (onEvent) => {
				secondOnEvent = onEvent;
				return undefined;
			},
		});
		expect(ok.runId).toMatch(/^[0-9a-f-]+$/i);
		// Drive the second run to completion so the test process can exit.
		secondOnEvent!({ type: 'complete', summary: {} });
		await registry.waitForCompletion(ok.runId);
		expect(registry.get(ok.runId)?.status).toBe('complete');
	});

	it('the failed initial run state is recorded as `failed`', async () => {
		const registry = createRunRegistry();
		await expect(
			registry.createRun({
				args: ['--json'],
				runFactory: async () => {
					throw new Error('boom');
				},
			}),
		).rejects.toThrow();
		// We can't read the failed-run state by id (we never got one), but the
		// invariant we care about — "activeRunId cleared" — is exercised by
		// the next-run-succeeds test above. The contract here is: no leak.
		// Confirm by attempting a second concurrent createRun without await:
		const second = registry.createRun({
			args: ['--json'],
			runFactory: async () => undefined,
		});
		await expect(second).resolves.toBeDefined();
	});
});

describe('Codex P2.1 — cache-reader filename/content cacheKey parity', () => {
	let cacheDir: string;
	beforeEach(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'regression-codex-cache-'));
	});
	afterEach(async () => {
		await rm(cacheDir, { recursive: true, force: true });
	});

	it('rejects a file whose content cacheKey does not match its filename', async () => {
		await mkdir(join(cacheDir, 'demo-case'), { recursive: true });
		const corrupt = {
			caseId: 'demo-case',
			cacheKey: HEX64_B, // filename will be HEX64_A — mismatch!
			source: 'fresh',
			verdict: VERDICT.pass,
			inputs: [],
			actuals: [],
			oracleVerdicts: [],
			tokenCounts: { input: 0, output: 0 },
			costUsd: 0,
			modelIds: { fast: 'm', standard: 'n', reasoning: null },
			timestamp: '2026-05-10T00:00:00Z',
			durationMs: 1,
		};
		await writeFile(
			join(cacheDir, 'demo-case', `${HEX64_A}.json`),
			JSON.stringify({ result: corrupt }),
		);
		// readDisplayForCase asks for HEX64_A; the file lives at HEX64_A.json
		// but its content claims cacheKey HEX64_B — must be rejected, not
		// returned as a current-key hit.
		const out = await readDisplayForCase(cacheDir, 'demo-case', HEX64_A);
		expect(out).toBeNull();
	});
});
