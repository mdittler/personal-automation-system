/**
 * Integration tests for the /gui/regression subprocess pipeline (Codex I9).
 *
 * Validates the end-to-end flow without depending on the real LLM stack:
 *   1. spawnRegression() → real Node child_process → NDJSON parsing → events
 *   2. run-registry buffers events → SSE-like attach replay → terminal close
 *   3. case-discovery talks to a real subprocess (--list mode)
 *
 * A fake CLI fixture (__fixtures__/fake-regression-cli.mjs) replaces the real
 * regression CLI so we exercise the same subprocess plumbing without env
 * dependencies or LLM dispatch. One real-CLI smoke test is also included that
 * invokes the actual `regression/src/runner/cli-main.ts --list` — the only
 * mode that does not require API keys.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCaseDiscovery } from '../services/regression/case-discovery.js';
import { type RegressionEvent, createRunRegistry } from '../services/regression/run-registry.js';
import { spawnRegression } from '../services/regression/subprocess.js';

const fakeCliPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'__fixtures__',
	'fake-regression-cli.mjs',
);

function spawnFake(mode: string): NodeJS.Process & {
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
} {
	return nodeSpawn(process.execPath, [fakeCliPath], {
		env: { ...process.env, FAKE_CLI_MODE: mode },
		stdio: ['ignore', 'pipe', 'pipe'],
	}) as unknown as NodeJS.Process & {
		stdout: NodeJS.ReadableStream;
		stderr: NodeJS.ReadableStream;
	};
}

describe('subprocess + run-registry integration (fake CLI)', () => {
	it('happy path: case-result + summary + exit0 → complete', async () => {
		const events: RegressionEvent[] = [];
		const handle = await spawnRegression(['--json'], {
			// biome-ignore lint/suspicious/noExplicitAny: cross-test process shape
			spawnFn: () => spawnFake('happy') as any,
			onEvent: (e) => events.push(e),
		});
		await handle.whenComplete;
		const types = events.map((e) => e.type);
		expect(types).toEqual(['case-result', 'summary', 'complete']);
	});

	it('REQ-REG-011 gate fail: summary + exit1 → gate-failed (Codex C3)', async () => {
		const events: RegressionEvent[] = [];
		const handle = await spawnRegression(['--json'], {
			// biome-ignore lint/suspicious/noExplicitAny: cross-test process shape
			spawnFn: () => spawnFake('gate-failed') as any,
			onEvent: (e) => events.push(e),
		});
		await handle.whenComplete;
		expect(events.map((e) => e.type)).toEqual(['summary', 'gate-failed']);
	});

	it('crash without summary → failed (Codex C3)', async () => {
		const events: RegressionEvent[] = [];
		const handle = await spawnRegression(['--json'], {
			// biome-ignore lint/suspicious/noExplicitAny: cross-test process shape
			spawnFn: () => spawnFake('crash') as any,
			onEvent: (e) => events.push(e),
		});
		await handle.whenComplete;
		const terminal = events[events.length - 1] as { type: string; stderrTail?: string };
		expect(terminal.type).toBe('failed');
		expect(terminal.stderrTail).toContain('simulated crash');
	});

	it('Pino line on stdout is silently dropped (Codex I3)', async () => {
		const events: RegressionEvent[] = [];
		const handle = await spawnRegression(['--json'], {
			// biome-ignore lint/suspicious/noExplicitAny: cross-test process shape
			spawnFn: () => spawnFake('pino-noise') as any,
			onEvent: (e) => events.push(e),
		});
		await handle.whenComplete;
		// Pino line should NOT have produced a spurious event:
		expect(events.map((e) => e.type)).toEqual(['summary', 'complete']);
	});

	it('registry buffers events and replays them to a late attach listener', async () => {
		const registry = createRunRegistry();
		const { runId } = await registry.createRun({
			args: ['--json'],
			runFactory: async (onEvent, signal) => {
				void signal;
				const handle = await spawnRegression(['--json'], {
					// biome-ignore lint/suspicious/noExplicitAny: cross-test process shape
					spawnFn: () => spawnFake('happy') as any,
					onEvent,
				});
				return { whenComplete: handle.whenComplete };
			},
		});
		await registry.waitForCompletion(runId);
		// Now attach AFTER completion — should replay every event from the buffer.
		const replayed: RegressionEvent[] = [];
		registry.attach(runId, (e) => replayed.push(e));
		expect(replayed.map((e) => e.type)).toEqual(['case-result', 'summary', 'complete']);
		expect(registry.get(runId)?.status).toBe('complete');
	});
});

describe('case-discovery integration (fake CLI --list)', () => {
	it('discovers a case via real subprocess + NDJSON parse', async () => {
		const discovery = createCaseDiscovery({
			spawnFn: () =>
				nodeSpawn(process.execPath, [fakeCliPath], {
					env: { ...process.env, FAKE_CLI_MODE: 'list' },
					// biome-ignore lint/suspicious/noExplicitAny: cross-test process shape
					stdio: ['ignore', 'pipe', 'pipe'],
				}) as any,
		});
		const out = await discovery.discover();
		expect(out.error).toBeUndefined();
		expect(out.cases).toHaveLength(1);
		expect(out.cases[0]?.caseId).toBe('fake-case');
		expect(out.cases[0]?.currentCacheKey).toMatch(/^[a-f0-9]{64}$/);
		expect(out.modelIds).toEqual({ fast: 'fake-fast', standard: 'fake-std', reasoning: null });
	});
});

describe('real CLI --list smoke (no LLM dispatch)', () => {
	it('invokes the actual regression CLI in --list mode and parses the output', async () => {
		// Resolve repo root from the worktree layout: this file is at
		// <repo>/core/src/gui/__tests__/regression-integration.test.ts.
		// File is at <repo>/core/src/gui/__tests__/ — go up 4 to the repo root.
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
		const cliPath = resolve(repoRoot, 'regression', 'src', 'runner', 'cli-main.ts');
		const tsconfigPath = resolve(repoRoot, 'regression', 'tsconfig.json');
		const discovery = createCaseDiscovery({
			cliPath,
			cwd: repoRoot,
			tsconfigPath,
		});
		// The real --list mode requires the same env vars `loadSystemConfig`
		// requires. We stub them via process.env so the subprocess inherits
		// them; no real provider call is made because --list short-circuits
		// before dispatch.
		const savedEnv = {
			TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
			GUI_AUTH_TOKEN: process.env.GUI_AUTH_TOKEN,
			ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		};
		process.env.TELEGRAM_BOT_TOKEN ??= 'smoke-token';
		process.env.GUI_AUTH_TOKEN ??= 'smoke-gui-token';
		process.env.ANTHROPIC_API_KEY ??= 'smoke-api-key';
		try {
			const out = await discovery.discover();
			// We don't pin the number of cases — the routing bucket grows as
			// the suite evolves — but we DO assert the contract holds:
			expect(out.error).toBeUndefined();
			expect(out.cases.length).toBeGreaterThan(0);
			expect(out.modelIds?.fast).toBeTypeOf('string');
			expect(out.modelIds?.standard).toBeTypeOf('string');
			for (const c of out.cases) {
				expect(c.caseId).toMatch(/^[a-z][a-z0-9-]{0,127}$/);
				expect(c.currentCacheKey).toMatch(/^[a-f0-9]{64}$/);
				expect(['routing', 'receipt', 'chatbot', 'recall']).toContain(c.bucket);
			}
		} finally {
			// Restore original env for other tests in the same Vitest process.
			// (Setting to '' is good enough — the next subprocess inherits empty
			// strings, which match the original state for these specific vars.)
			process.env.TELEGRAM_BOT_TOKEN = savedEnv.TELEGRAM_BOT_TOKEN ?? '';
			process.env.GUI_AUTH_TOKEN = savedEnv.GUI_AUTH_TOKEN ?? '';
			process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY ?? '';
		}
	}, 30_000);
});
