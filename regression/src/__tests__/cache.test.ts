import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheStore } from '../runner/cache.js';
import type { RunResult } from '../shared/types.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'regression-cache-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const VALID_KEY_A = 'a'.repeat(64);
const VALID_KEY_B = 'b'.repeat(64);
const VALID_KEY_C = 'c'.repeat(64);

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		caseId: 'case-1',
		cacheKey: VALID_KEY_A,
		source: 'fresh',
		verdict: 'pass',
		inputs: [],
		actuals: [],
		oracleVerdicts: [],
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds: { fast: 'f', standard: 's', reasoning: null },
		timestamp: '2026-05-08T00:00:00.000Z',
		durationMs: 0,
		...overrides,
	};
}

describe('CacheStore.read', () => {
	it('returns null on cache miss (file does not exist)', async () => {
		const store = new CacheStore(tempDir);
		const r = await store.read('case-1', VALID_KEY_A);
		expect(r).toBeNull();
	});

	it('round-trips a written RunResult', async () => {
		const store = new CacheStore(tempDir);
		const result = makeRunResult({ caseId: 'case-1', cacheKey: VALID_KEY_A, costUsd: 0.0123 });
		await store.write(result);
		const loaded = await store.read('case-1', VALID_KEY_A);
		expect(loaded).toEqual(result);
	});

	it('returns null + warns on unparseable JSON', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = new CacheStore(tempDir);
		await mkdir(join(tempDir, 'case-1'), { recursive: true });
		await writeFile(join(tempDir, 'case-1', `${VALID_KEY_A}.json`), '{not valid json');
		const r = await store.read('case-1', VALID_KEY_A);
		expect(r).toBeNull();
		expect(warnSpy).toHaveBeenCalled();
	});

	it('returns null + warns on schema-violating JSON (missing fields)', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = new CacheStore(tempDir);
		await mkdir(join(tempDir, 'case-1'), { recursive: true });
		// Wrong shape: not wrapped in { result: ... }, no required fields
		await writeFile(
			join(tempDir, 'case-1', `${VALID_KEY_A}.json`),
			JSON.stringify({ result: { caseId: 'case-1', cacheKey: VALID_KEY_A } }),
		);
		const r = await store.read('case-1', VALID_KEY_A);
		expect(r).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/shape|invalid|schema/i));
	});

	it('returns null + warns when payload caseId does not match request', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = new CacheStore(tempDir);
		// Write a valid RunResult under case-1's directory but with caseId = 'evil'
		const tamperedResult = makeRunResult({ caseId: 'evil', cacheKey: VALID_KEY_A });
		await mkdir(join(tempDir, 'case-1'), { recursive: true });
		await writeFile(
			join(tempDir, 'case-1', `${VALID_KEY_A}.json`),
			JSON.stringify({ result: tamperedResult }, null, 2),
		);
		const r = await store.read('case-1', VALID_KEY_A);
		expect(r).toBeNull();
		expect(warnSpy).toHaveBeenCalled();
	});
});

describe('CacheStore path-traversal guards', () => {
	it('rejects caseId with path traversal characters', async () => {
		const store = new CacheStore(tempDir);
		await expect(store.read('../escape', VALID_KEY_A)).rejects.toThrow(/invalid case id/i);
		await expect(store.read('foo/bar', VALID_KEY_A)).rejects.toThrow(/invalid case id/i);
		await expect(
			store.write(makeRunResult({ caseId: '../escape', cacheKey: VALID_KEY_A })),
		).rejects.toThrow(/invalid case id/i);
		await expect(store.listAllForCase('..')).rejects.toThrow(/invalid case id/i);
	});

	it('rejects cacheKey not matching 64-hex pattern', async () => {
		const store = new CacheStore(tempDir);
		await expect(store.read('case-1', '../bad')).rejects.toThrow(/invalid cache key/i);
		await expect(store.read('case-1', 'short')).rejects.toThrow(/invalid cache key/i);
		await expect(store.read('case-1', `${VALID_KEY_A}/extra`)).rejects.toThrow(
			/invalid cache key/i,
		);
		await expect(
			store.write(makeRunResult({ caseId: 'case-1', cacheKey: 'not-hex' })),
		).rejects.toThrow(/invalid cache key/i);
	});
});

describe('CacheStore.write', () => {
	it('creates the case directory and writes the file atomically', async () => {
		const store = new CacheStore(tempDir);
		const result = makeRunResult();
		await store.write(result);
		const files = await readdir(join(tempDir, 'case-1'));
		// No leftover .tmp.* files
		expect(files.filter((f) => f.includes('.tmp.'))).toHaveLength(0);
		expect(files).toContain(`${VALID_KEY_A}.json`);
	});
});

describe('CacheStore.listAllForCase', () => {
	it('returns all valid entries sorted by timestamp ascending', async () => {
		const store = new CacheStore(tempDir);
		const r1 = makeRunResult({
			caseId: 'case-1',
			cacheKey: VALID_KEY_A,
			timestamp: '2026-05-08T00:00:00.000Z',
		});
		const r2 = makeRunResult({
			caseId: 'case-1',
			cacheKey: VALID_KEY_B,
			timestamp: '2026-05-07T00:00:00.000Z',
		});
		const r3 = makeRunResult({
			caseId: 'case-1',
			cacheKey: VALID_KEY_C,
			timestamp: '2026-05-09T00:00:00.000Z',
		});
		await store.write(r1);
		await store.write(r2);
		await store.write(r3);
		const all = await store.listAllForCase('case-1');
		expect(all).toHaveLength(3);
		expect(all[0]?.timestamp).toBe('2026-05-07T00:00:00.000Z');
		expect(all[1]?.timestamp).toBe('2026-05-08T00:00:00.000Z');
		expect(all[2]?.timestamp).toBe('2026-05-09T00:00:00.000Z');
	});

	it('returns an empty array when the case directory does not exist', async () => {
		const store = new CacheStore(tempDir);
		const all = await store.listAllForCase('nonexistent-case');
		expect(all).toEqual([]);
	});

	it('listAllForCase skips files with non-hex names defensively', async () => {
		const store = new CacheStore(tempDir);
		await store.write(makeRunResult({ cacheKey: VALID_KEY_A }));
		await writeFile(join(tempDir, 'case-1', 'not-hex.json'), '{"result":{}}');
		const all = await store.listAllForCase('case-1');
		expect(all).toHaveLength(1);
		expect(all[0]?.cacheKey).toBe(VALID_KEY_A);
	});

	it('listAllForCase returns valid results and skips corrupt ones (with warn)', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = new CacheStore(tempDir);
		await store.write(makeRunResult({ cacheKey: VALID_KEY_A }));
		await store.write(makeRunResult({ cacheKey: VALID_KEY_B }));
		// Overwrite one with garbage AFTER both are written
		await writeFile(join(tempDir, 'case-1', `${VALID_KEY_A}.json`), 'not json{');
		const all = await store.listAllForCase('case-1');
		expect(all).toHaveLength(1);
		expect(all[0]?.cacheKey).toBe(VALID_KEY_B);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
