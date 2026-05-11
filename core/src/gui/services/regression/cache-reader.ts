/**
 * Read cached regression `RunResult`s from disk for the GUI.
 *
 * `data/system/regression-cache/<caseId>/<cacheKey>.json` is the source
 * of truth. Both the regression CLI (write path) and the GUI (read path)
 * agree on the shape via `RunResult` in `core/src/types/regression.ts`.
 *
 * **Codex C2 (current-key-first):** `readDisplayForCase(caseId, currentCacheKey)`
 * first looks up the entry for `currentCacheKey`; only if absent does it
 * fall back to the newest-any entry (and signal `coverageChanged: true`).
 * Older "latest-by-timestamp" logic would have masked the current pass
 * with a newer stale entry.
 *
 * **Codex I5 (strict validation):** the RunResult shape check mirrors
 * `regression/src/runner/cache.ts` byte-for-byte. Invalid files are
 * SKIPPED with a warning; never normalized into UI state. Negative
 * cost, unknown verdict, missing required fields all fail the check.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type RunResult,
	SAFE_CACHE_KEY_RE,
	SAFE_CASE_ID_RE,
	isPlainObject,
	looksLikeRunResult,
} from '../../../types/regression.js';

function assertValidCaseId(id: string): void {
	if (!SAFE_CASE_ID_RE.test(id)) throw new Error(`invalid case id: ${id}`);
}
function assertValidCacheKey(key: string): void {
	if (!SAFE_CACHE_KEY_RE.test(key)) throw new Error(`invalid cache key: ${key}`);
}

async function readOne(
	cacheDir: string,
	caseId: string,
	cacheKey: string,
): Promise<RunResult | null> {
	const path = join(cacheDir, caseId, `${cacheKey}.json`);
	let buf: string;
	try {
		buf = await readFile(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		// biome-ignore lint/suspicious/noConsole: cache-reader observability — REQ-REG-002/010
		console.warn(`[regression-gui] cache read error ${path}: ${(err as Error).message}`);
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(buf);
	} catch (err) {
		// biome-ignore lint/suspicious/noConsole: cache-reader observability — REQ-REG-002/010
		console.warn(`[regression-gui] cache JSON parse failed ${path}: ${(err as Error).message}`);
		return null;
	}
	if (!isPlainObject(parsed)) {
		// biome-ignore lint/suspicious/noConsole: cache-reader observability — REQ-REG-002/010
		console.warn(`[regression-gui] cache shape invalid (not object) ${path}`);
		return null;
	}
	const inner = (parsed as { result?: unknown }).result;
	// Codex P2: pass the filename cacheKey to looksLikeRunResult so a stale
	// or tampered file whose `result.cacheKey` doesn't match its filename is
	// rejected — otherwise readDisplayForCase could report `coverageChanged: false`
	// for a file whose contents disagree with the cache-key it lives under.
	if (!looksLikeRunResult(inner, caseId, cacheKey)) {
		// biome-ignore lint/suspicious/noConsole: cache-reader observability — REQ-REG-002/010
		console.warn(`[regression-gui] cache shape invalid (RunResult schema mismatch) ${path}`);
		return null;
	}
	return inner;
}

export interface DisplayResult {
	result: RunResult;
	coverageChanged: boolean;
}

/**
 * Codex C2: first try the entry matching `currentCacheKey`; if absent,
 * return the newest-valid entry with `coverageChanged: true`.
 */
export async function readDisplayForCase(
	cacheDir: string,
	caseId: string,
	currentCacheKey: string,
): Promise<DisplayResult | null> {
	assertValidCaseId(caseId);
	assertValidCacheKey(currentCacheKey);
	const current = await readOne(cacheDir, caseId, currentCacheKey);
	if (current) return { result: current, coverageChanged: false };
	const all = await readHistoryForCase(cacheDir, caseId);
	if (all.length === 0) return null;
	return { result: all[0]!, coverageChanged: true };
}

/** All valid entries for a case, DESC by `timestamp`. Skip + warn for invalid. */
export async function readHistoryForCase(cacheDir: string, caseId: string): Promise<RunResult[]> {
	assertValidCaseId(caseId);
	const dir = join(cacheDir, caseId);
	let files: string[];
	try {
		files = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
	const keys = files
		.filter((f) => f.endsWith('.json'))
		.map((f) => f.slice(0, -'.json'.length))
		.filter((k) => SAFE_CACHE_KEY_RE.test(k));
	const results = await Promise.all(keys.map((k) => readOne(cacheDir, caseId, k)));
	const valid = results.filter((r): r is RunResult => r !== null);
	valid.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	return valid;
}
