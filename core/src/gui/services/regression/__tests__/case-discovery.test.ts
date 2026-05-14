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

const VALID_ENTRY = (caseId: string, inputCount = 1): string =>
	JSON.stringify({
		type: 'case-list-entry',
		caseId,
		bucket: 'routing',
		routingTarget: 'food-shadow',
		description: `${caseId} desc`,
		oracle: 'structural',
		coverage: ['regression/src/cases/x.case.ts'],
		inputs: Array.from({ length: inputCount }, (_, i) => ({
			payload: `p${i}`,
			expected: { intent: 'x' },
		})),
		inputCount,
		budgetUsd: 0.05,
		currentCacheKey: 'a'.repeat(64),
	});

// Note: `totalInputs` is intentionally omitted from this default fixture so
// pre-totalInputs tests don't trigger the new sum-of-inputCount sanity check.
// Tests asserting REQ-REG-GUI-V2-023 use `VALID_END_WITH(cases, inputs)` to
// pin both fields and exercise the mismatch detection.
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

	it('silently skips non-JSON noise (e.g. dotenv banner) before NDJSON', async () => {
		// Pre-NDJSON noise from loader/dotenv plugins is common — the fail-
		// closed signal is the missing terminator + validateEntry rejection,
		// not the presence of an unparseable line.
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [
					'[dotenv@17.3.1] injecting env (0) from .env',
					'some startup log line that is not JSON',
					VALID_ENTRY('case-a'),
					VALID_END,
				],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeUndefined();
		expect(out.cases).toHaveLength(1);
	});

	it('silently skips JSON-shaped lines whose `type` is unknown (e.g. Pino log)', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [
					JSON.stringify({ level: 30, msg: 'unexpected pino on stdout' }),
					VALID_ENTRY('case-a'),
					VALID_END,
				],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeUndefined();
		expect(out.cases).toHaveLength(1);
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
						inputCount: 1,
						budgetUsd: 0.05,
						currentCacheKey: key,
					}),
					JSON.stringify({
						type: 'case-list-end',
						totalCases: 1,
						totalInputs: 1,
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
			inputCount: 1,
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		};
		expect(minimal.caseId).toBe('a');
	});
});

describe('case-discovery — inputCount + totalInputs (REQ-REG-GUI-V2-023)', () => {
	it('parses inputCount per case and propagates it to ListedCase', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [VALID_ENTRY('case-a', 3), VALID_END_WITH(1, 3)],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeUndefined();
		expect(out.cases[0]?.inputCount).toBe(3);
	});

	it('parses totalInputs on the terminator and exposes it on DiscoveryResult', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [VALID_ENTRY('case-a', 4), VALID_ENTRY('case-b', 2), VALID_END_WITH(2, 6)],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.totalInputs).toBe(6);
		expect(out.totalCases).toBe(2);
	});

	it('fails closed when inputCount disagrees with inputs.length (fail-closed C11)', async () => {
		const skewed = JSON.stringify({
			type: 'case-list-entry',
			caseId: 'skewed',
			bucket: 'routing',
			routingTarget: 'food-shadow',
			description: 'd',
			oracle: 'structural',
			coverage: ['x.ts'],
			inputs: [{ payload: 'p', expected: {} }], // length=1
			inputCount: 5, // claims 5 — mismatch
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		});
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [skewed, VALID_END_WITH(1, 1)],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toMatch(/inputCount.*disagrees/);
		expect(out.cases).toEqual([]);
	});

	it('fails closed when totalInputs disagrees with sum of inputCount', async () => {
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [
					VALID_ENTRY('case-a', 3),
					VALID_END_WITH(1, 999), // wrong total
				],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toMatch(/totalInputs.*disagrees/);
		expect(out.cases).toEqual([]);
	});

	it('fails closed when inputCount is missing entirely', async () => {
		const noCount = JSON.stringify({
			type: 'case-list-entry',
			caseId: 'no-count',
			bucket: 'routing',
			routingTarget: 'food-shadow',
			description: 'd',
			oracle: 'structural',
			coverage: ['x.ts'],
			inputs: [{ payload: 'p', expected: {} }],
			// no inputCount
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		});
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [noCount, VALID_END_WITH(1, 1)],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toMatch(/inputCount missing/);
	});

	it('fails closed when inputCount is non-integer (e.g. 2.5)', async () => {
		const float = JSON.stringify({
			type: 'case-list-entry',
			caseId: 'float',
			bucket: 'routing',
			routingTarget: 'food-shadow',
			description: 'd',
			oracle: 'structural',
			coverage: ['x.ts'],
			inputs: [{ payload: 'p', expected: {} }],
			inputCount: 2.5,
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		});
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [float, VALID_END_WITH(1, 1)],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toMatch(/inputCount.*integer/);
	});

	it('accumulates multiple validation errors instead of surfacing only the last', async () => {
		// Three malformed entries in a row — without accumulation we'd only see
		// the last error and operators would chase the wrong drift symptom.
		const noOracle = JSON.stringify({
			type: 'case-list-entry',
			caseId: 'a',
			bucket: 'routing',
			routingTarget: 'food-shadow',
			description: 'd',
			coverage: ['x.ts'],
			inputs: [{ payload: 'p', expected: {} }],
			inputCount: 1,
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		});
		const noDescription = JSON.stringify({
			type: 'case-list-entry',
			caseId: 'b',
			bucket: 'routing',
			oracle: 'structural',
			coverage: ['x.ts'],
			inputs: [{ payload: 'p', expected: {} }],
			inputCount: 1,
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		});
		const noCacheKey = JSON.stringify({
			type: 'case-list-entry',
			caseId: 'c',
			bucket: 'routing',
			description: 'd',
			oracle: 'structural',
			coverage: ['x.ts'],
			inputs: [{ payload: 'p', expected: {} }],
			inputCount: 1,
			budgetUsd: 0.05,
		});
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [noOracle, noDescription, noCacheKey, VALID_END_WITH(3, 3)],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeDefined();
		expect(out.error).toContain('oracle missing');
		expect(out.error).toContain('description missing');
		expect(out.error).toContain('currentCacheKey missing or invalid');
	});

	it('caps accumulated validation errors at 5 with an overflow marker', async () => {
		const malformedEntries = Array.from({ length: 8 }, (_, i) =>
			JSON.stringify({
				type: 'case-list-entry',
				caseId: `case-${i}`,
				bucket: 'routing',
				description: 'd',
				oracle: 'structural',
				coverage: ['x.ts'],
				inputs: [{ payload: 'p', expected: {} }],
				inputCount: 1,
				budgetUsd: 0.05,
				// missing currentCacheKey → 8 instances of the same error
			}),
		);
		const disc = createCaseDiscovery({
			spawnFn: fakeSpawn({
				stdoutLines: [...malformedEntries, VALID_END_WITH(8, 8)],
				exitCode: 0,
			}),
		});
		const out = await disc.discover();
		expect(out.error).toBeDefined();
		expect(out.error).toContain('additional entries beyond the first 5');
		// First 5 errors appear; the 6th/7th/8th do NOT.
		const matches = out.error!.match(/currentCacheKey missing or invalid/g);
		expect(matches?.length).toBe(5);
	});
});

function VALID_END_WITH(totalCases: number, totalInputs: number): string {
	return JSON.stringify({
		type: 'case-list-end',
		totalCases,
		totalInputs,
		modelIds: { fast: 'f', standard: 's', reasoning: null },
	});
}
