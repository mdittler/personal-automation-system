/**
 * Persona Regression Suite — CacheStore.
 *
 * Persists RunResult JSON files keyed by (caseId, cacheKey). History is
 * retained forever (REQ-REG-010). Reads validate the loaded JSON shape and
 * reject corrupt or tampered files (treat as miss + warn).
 *
 * REQ-REG-002, REQ-REG-010.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResult, Verdict } from '../shared/types.js';

const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const SAFE_KEY_RE = /^[a-f0-9]{64}$/i;

function assertValidCaseId(id: string): void {
	if (!SAFE_ID_RE.test(id)) throw new Error(`invalid case id: ${id}`);
}
function assertValidCacheKey(key: string): void {
	if (!SAFE_KEY_RE.test(key)) throw new Error(`invalid cache key: ${key}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const VALID_VERDICTS: Verdict[] = ['pass', 'fail', 'error', 'budget-exceeded'];

function looksLikeRunResult(
	v: unknown,
	expectedCaseId: string,
	expectedCacheKey: string,
): v is RunResult {
	if (!isPlainObject(v)) return false;
	if (v.caseId !== expectedCaseId) return false;
	if (v.cacheKey !== expectedCacheKey) return false;
	if (typeof v.verdict !== 'string') return false;
	if (!VALID_VERDICTS.includes(v.verdict as Verdict)) return false;
	if (typeof v.timestamp !== 'string' || Number.isNaN(Date.parse(v.timestamp))) return false;
	if (!isPlainObject(v.modelIds)) return false;
	const m = v.modelIds as Record<string, unknown>;
	if (typeof m.fast !== 'string' || typeof m.standard !== 'string') return false;
	if (m.reasoning !== null && typeof m.reasoning !== 'string') return false;
	if (typeof v.costUsd !== 'number' || !Number.isFinite(v.costUsd) || v.costUsd < 0) return false;
	if (!Array.isArray(v.actuals)) return false;
	if (!Array.isArray(v.oracleVerdicts)) return false;
	if (!Array.isArray(v.inputs)) return false;
	if (!isPlainObject(v.tokenCounts)) return false;
	const t = v.tokenCounts as Record<string, unknown>;
	if (typeof t.input !== 'number' || !Number.isFinite(t.input) || t.input < 0) return false;
	if (typeof t.output !== 'number' || !Number.isFinite(t.output) || t.output < 0) return false;
	if (v.source !== 'cached' && v.source !== 'fresh') return false;
	if (typeof v.durationMs !== 'number' || !Number.isFinite(v.durationMs) || v.durationMs < 0)
		return false;
	return true;
}

export class CacheStore {
	constructor(private readonly rootDir: string) {}

	async read(caseId: string, cacheKey: string): Promise<RunResult | null> {
		assertValidCaseId(caseId);
		assertValidCacheKey(cacheKey);
		const path = join(this.rootDir, caseId, `${cacheKey}.json`);
		let buf: string;
		try {
			buf = await readFile(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			// biome-ignore lint/suspicious/noConsole: cache read observability — REQ-REG-002/010
			console.warn(`[regression] cache read error ${path}: ${(err as Error).message}`);
			return null;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(buf);
		} catch (err) {
			// biome-ignore lint/suspicious/noConsole: cache read observability — REQ-REG-002/010
			console.warn(`[regression] cache JSON parse failed ${path}: ${(err as Error).message}`);
			return null;
		}
		if (!isPlainObject(parsed)) {
			// biome-ignore lint/suspicious/noConsole: cache read observability — REQ-REG-002/010
			console.warn(`[regression] cache shape invalid (not object) ${path}`);
			return null;
		}
		const inner = (parsed as { result?: unknown }).result;
		if (!looksLikeRunResult(inner, caseId, cacheKey)) {
			// biome-ignore lint/suspicious/noConsole: cache read observability — REQ-REG-002/010
			console.warn(`[regression] cache shape invalid (RunResult schema mismatch) ${path}`);
			return null;
		}
		return inner;
	}

	async write(result: RunResult): Promise<void> {
		assertValidCaseId(result.caseId);
		assertValidCacheKey(result.cacheKey);
		const dir = join(this.rootDir, result.caseId);
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${result.cacheKey}.json`);
		const tmpPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
		await writeFile(tmpPath, JSON.stringify({ result }, null, 2));
		await rename(tmpPath, path);
	}

	async listAllForCase(caseId: string): Promise<RunResult[]> {
		assertValidCaseId(caseId);
		const dir = join(this.rootDir, caseId);
		let files: string[];
		try {
			files = await readdir(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw err;
		}
		const out: RunResult[] = [];
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			const cacheKey = f.replace(/\.json$/, '');
			if (!SAFE_KEY_RE.test(cacheKey)) continue;
			const r = await this.read(caseId, cacheKey);
			if (r) out.push(r);
		}
		out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		return out;
	}
}
