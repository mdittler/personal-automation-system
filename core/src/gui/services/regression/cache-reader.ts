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
import type { RunResult, Verdict } from '../../../types/regression.js';

// Mirrors `regression/src/runner/cache.ts` SAFE_ID_RE / SAFE_KEY_RE. We
// can't import them because the GUI must not depend on the regression
// workspace (boundary preservation — Codex C4-adjacent).
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const SAFE_KEY_RE = /^[a-f0-9]{64}$/i;
const VALID_VERDICTS: Verdict[] = ['pass', 'fail', 'error', 'budget-exceeded'];

function assertValidCaseId(id: string): void {
	if (!SAFE_ID_RE.test(id)) throw new Error(`invalid case id: ${id}`);
}
function assertValidCacheKey(key: string): void {
	if (!SAFE_KEY_RE.test(key)) throw new Error(`invalid cache key: ${key}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Mirrors `looksLikeRunResult` in `regression/src/runner/cache.ts`. */
function looksLikeRunResult(v: unknown, expectedCaseId: string): v is RunResult {
	if (!isPlainObject(v)) return false;
	if (v.caseId !== expectedCaseId) return false;
	if (typeof v.cacheKey !== 'string' || !SAFE_KEY_RE.test(v.cacheKey)) return false;
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
	if (!looksLikeRunResult(inner, caseId)) {
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
		.filter((k) => SAFE_KEY_RE.test(k));
	const results = await Promise.all(keys.map((k) => readOne(cacheDir, caseId, k)));
	const valid = results.filter((r): r is RunResult => r !== null);
	valid.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	return valid;
}
