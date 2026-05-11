/**
 * case-discovery tests (Codex C4 + I4).
 *
 * C4: NO TTL caching of `currentCacheKey`. Every call spawns the
 * subprocess. Coalescing in-flight requests is OK; caching past
 * results is not.
 *
 * I4: list mode fails CLOSED. Malformed lines, missing terminator,
 * non-zero exit → return `{error, cases: []}`. The page renders an
 * error banner and disables Run controls.
 */

import { describe, expect, it } from 'vitest';
import { type ListedCase, createCaseDiscovery } from '../case-discovery.js';

// A minimal fake of node:child_process.spawn that emits canned NDJSON
// to stdout and exits with the given code. We use it instead of mocking
// child_process so tests stay deterministic and don't depend on tsx.
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

interface FakeProc extends EventEmitter {
	stdout: Readable;
	stderr: Readable;
	stdin: Writable;
	kill: (signal?: NodeJS.Signals) => boolean;
}

function fakeSpawn(opts: {
	stdoutLines: string[];
	stderrLines?: string[];
	exitCode: number;
	delayMs?: number;
}): () => FakeProc {
	return () => {
		const proc = new EventEmitter() as FakeProc;
		const stdout = new Readable({ read() {} });
		const stderr = new Readable({ read() {} });
		proc.stdout = stdout;
		proc.stderr = stderr;
		proc.stdin = new Writable({
			write(_c, _e, cb) {
				cb();
			},
		});
		proc.kill = () => true;
		setTimeout(() => {
			for (const line of opts.stdoutLines) stdout.push(`${line}\n`);
			for (const line of opts.stderrLines ?? []) stderr.push(`${line}\n`);
			stdout.push(null);
			stderr.push(null);
			setImmediate(() => proc.emit('exit', opts.exitCode, null));
		}, opts.delayMs ?? 1);
		return proc;
	};
}

const VALID_ENTRY = (caseId: string): string =>
	JSON.stringify({
		type: 'case-list-entry',
		caseId,
		bucket: 'routing',
		routingTarget: 'food-shadow',
		description: `${caseId} desc`,
		oracle: 'structural',
		coverage: ['regression/src/cases/x.case.ts'],
		inputs: [{ payload: 'p', expected: { intent: 'x' } }],
		budgetUsd: 0.05,
		currentCacheKey: 'a'.repeat(64),
	});

const VALID_END = JSON.stringify({
	type: 'case-list-end',
	totalCases: 1,
	modelIds: { fast: 'f', standard: 's', reasoning: null },
});

describe('case-discovery — happy path', () => {
	it('parses case-list-entry + case-list-end into ListedCase[]', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [VALID_ENTRY('case-a'), VALID_ENTRY('case-b'), VALID_END],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeUndefined();
		expect(out.cases).toHaveLength(2);
		expect(out.cases[0]?.caseId).toBe('case-a');
		expect(out.cases[0]?.inputs).toHaveLength(1);
		expect(out.cases[0]?.oracle).toBe('structural');
		expect(out.cases[0]?.currentCacheKey).toBe('a'.repeat(64));
	});

	it('returns modelIds from the terminator line', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [VALID_ENTRY('case-a'), VALID_END],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.modelIds).toEqual({ fast: 'f', standard: 's', reasoning: null });
	});

	it('returns empty list + terminator for zero-case workspace', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [
					JSON.stringify({
						type: 'case-list-end',
						totalCases: 0,
						modelIds: { fast: 'f', standard: 's', reasoning: null },
					}),
				],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeUndefined();
		expect(out.cases).toEqual([]);
	});
});

describe('case-discovery — fail closed (I4)', () => {
	it('returns error when subprocess exits non-zero', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({ stdoutLines: [], stderrLines: ['boom'], exitCode: 1 }),
		});
		const out = await disc.discover();
		expect(out.error).toBeDefined();
		expect(out.cases).toEqual([]);
	});

	it('returns error when terminator is missing', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [VALID_ENTRY('case-a')], // no case-list-end
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toMatch(/terminator|case-list-end/i);
		expect(out.cases).toEqual([]);
	});

	it('returns error when a line is malformed JSON', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [VALID_ENTRY('case-a'), 'not-json', VALID_END],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toMatch(/malformed|parse/i);
		expect(out.cases).toEqual([]);
	});

	it('returns error when a case-list-entry has missing fields (defensive)', async () => {
		const partial = JSON.stringify({ type: 'case-list-entry', caseId: 'broken' });
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [partial, VALID_END],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeDefined();
		expect(out.cases).toEqual([]);
	});
});

describe('case-discovery — no TTL on cacheKey (C4)', () => {
	it('does NOT reuse a previous discover() result', async () => {
		// Two distinct fake spawns; second emits a different currentCacheKey.
		// If discover() were caching by case-id, the second call would return
		// the first call's cacheKey — which is the bug C4 guards against.
		let invocation = 0;
		const spawnFn = (): FakeProc => {
			invocation++;
			const key = invocation === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
			const factory = fakeSpawn({
				stdoutLines: [
					JSON.stringify({
						type: 'case-list-entry',
						caseId: 'demo',
						bucket: 'routing',
						routingTarget: 'food-shadow',
						description: 'demo',
						oracle: 'structural',
						coverage: ['x.ts'],
						inputs: [{ payload: 'p', expected: {} }],
						budgetUsd: 0.05,
						currentCacheKey: key,
					}),
					JSON.stringify({
						type: 'case-list-end',
						totalCases: 1,
						modelIds: { fast: 'f', standard: 's', reasoning: null },
					}),
				],
				exitCode: 0,
			});
			return factory();
		};
		const disc = createCaseDiscovery({ spawnFn });
		const first = await disc.discover();
		const second = await disc.discover();
		expect(first.cases[0]?.currentCacheKey).toBe('a'.repeat(64));
		expect(second.cases[0]?.currentCacheKey).toBe('b'.repeat(64));
		expect(invocation).toBe(2); // both calls spawned fresh
	});

	it('coalesces concurrent in-flight requests (only one spawn)', async () => {
		let spawnCount = 0;
		const spawnFn = (): FakeProc => {
			spawnCount++;
			return fakeSpawn({
				stdoutLines: [VALID_ENTRY('case-a'), VALID_END],
				exitCode: 0,
				delayMs: 30,
			})();
		};
		const disc = createCaseDiscovery({ spawnFn });
		const [a, b] = await Promise.all([disc.discover(), disc.discover()]);
		expect(a.cases).toHaveLength(1);
		expect(b.cases).toHaveLength(1);
		// In-flight coalescing — at most one spawn for two concurrent callers.
		expect(spawnCount).toBe(1);
	});
});

describe('case-discovery — unknown JSON types tolerated mid-stream', () => {
	it('skips lines whose type is unknown (e.g. a Pino-shaped JSON)', async () => {
		const pinoLine = JSON.stringify({ level: 30, msg: 'hi' });
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [pinoLine, VALID_ENTRY('case-a'), VALID_END],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeUndefined();
		expect(out.cases).toHaveLength(1);
	});
});

// Type check: ListedCase shape is exported and stable for the GUI.
describe('ListedCase shape', () => {
	it('exposes the required fields for the GUI page + drilldown', () => {
		// This is a compile-time check; if the type changes, this test fails.
		const minimal: ListedCase = {
			caseId: 'a',
			bucket: 'routing',
			description: 'd',
			oracle: 'structural',
			coverage: ['x'],
			inputs: [{ payload: 'p', expected: {} }],
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		};
		expect(minimal.caseId).toBe('a');
	});
});
