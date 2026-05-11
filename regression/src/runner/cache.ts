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
import {
	type RunResult,
	SAFE_CACHE_KEY_RE,
	SAFE_CASE_ID_RE,
	isPlainObject,
	looksLikeRunResult,
} from '../shared/types.js';

function assertValidCaseId(id: string): void {
	if (!SAFE_CASE_ID_RE.test(id)) throw new Error(`invalid case id: ${id}`);
}
function assertValidCacheKey(key: string): void {
	if (!SAFE_CACHE_KEY_RE.test(key)) throw new Error(`invalid cache key: ${key}`);
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
		const cacheKeys = files
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.replace(/\.json$/, ''))
			.filter((k) => SAFE_CACHE_KEY_RE.test(k));
		const results = await Promise.all(cacheKeys.map((k) => this.read(caseId, k)));
		for (const r of results) {
			if (r) out.push(r);
		}
		out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		return out;
	}
}
