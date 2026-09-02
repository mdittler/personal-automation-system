/**
 * Read-only access to `data/system/regression-runs/<runId>.json` manifests
 * written by the subprocess after each regression run (REQ-REG-GUI-V2-004).
 *
 * Strict validator: malformed JSON, wrong shape, or schema-violating values
 * → skip + warn. Never throws on a single bad file; the GUI degrades to
 * "leaderboard misses that run" rather than failing the page.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import {
	EVALUATED_TIER_VALUES,
	type EvaluatedTier,
	type RunManifest,
	SAFE_RUN_ID_RE,
	VALID_BUCKETS,
	VERDICT_VALUES,
	isPlainObject,
} from '../../../types/regression.js';

const VERDICTS = new Set<string>(VERDICT_VALUES);
const SOURCES = new Set(['cached', 'fresh']);
const TIERS = new Set(EVALUATED_TIER_VALUES as readonly string[]);
const BUCKETS = new Set(VALID_BUCKETS as readonly string[]);

interface ListFilters {
	tier?: EvaluatedTier;
	modelId?: string;
	since?: string; // ISO-8601; only manifests with completedAt >= since
	limit?: number;
}

export interface RunHistoryStore {
	list(filters?: ListFilters): Promise<RunManifest[]>;
	getById(runId: string): Promise<RunManifest | null>;
	latestPerTierAndModel(): Promise<Map<string, RunManifest>>;
}

export function createRunHistoryStore(opts: {
	rootDir: string;
	logger: Logger;
}): RunHistoryStore {
	const { rootDir, logger } = opts;

	async function listManifestFiles(): Promise<string[]> {
		try {
			const entries = await readdir(rootDir);
			return entries
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.replace(/\.json$/, ''))
				.filter((id) => SAFE_RUN_ID_RE.test(id));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw err;
		}
	}

	async function readOne(runId: string): Promise<RunManifest | null> {
		const path = join(rootDir, `${runId}.json`);
		let buf: string;
		try {
			buf = await readFile(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			logger.warn({ runId, err: (err as Error).message }, 'run-history-store: read failed');
			return null;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(buf);
		} catch (err) {
			logger.warn({ runId, err: (err as Error).message }, 'run-history-store: JSON parse failed');
			return null;
		}
		if (!isValidManifest(parsed, runId)) {
			logger.warn({ runId, path }, 'run-history-store: manifest shape invalid');
			return null;
		}
		return parsed;
	}

	return {
		async list(filters?: ListFilters): Promise<RunManifest[]> {
			const ids = await listManifestFiles();
			const all = await Promise.all(ids.map((id) => readOne(id)));
			let manifests: RunManifest[] = all.filter((m): m is RunManifest => m !== null);
			if (filters?.since) {
				const since = filters.since;
				manifests = manifests.filter((m) => m.completedAt >= since);
			}
			if (filters?.tier || filters?.modelId) {
				manifests = manifests.filter((m) =>
					matchesTierAndModel(m, filters?.tier, filters?.modelId),
				);
			}
			manifests.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
			if (filters?.limit !== undefined && manifests.length > filters.limit) {
				return manifests.slice(0, filters.limit);
			}
			return manifests;
		},

		getById(runId): Promise<RunManifest | null> {
			if (!SAFE_RUN_ID_RE.test(runId)) return Promise.resolve(null);
			return readOne(runId);
		},

		async latestPerTierAndModel(): Promise<Map<string, RunManifest>> {
			const all = await this.list();
			// `all` is already sorted by completedAt desc — first-write-wins is
			// therefore latest-wins. Key by `${tier}:${model-for-tier}`.
			const out = new Map<string, RunManifest>();
			for (const m of all) {
				for (const key of tierModelKeys(m)) {
					if (!out.has(key)) out.set(key, m);
				}
			}
			return out;
		},
	};
}

/**
 * Compose deterministic `${tier}:${modelId}` keys for each tier slot that
 * actually participated in this run. A tier participated when
 * at least one of its caseResults has `evaluatedTier === tier`. A
 * routing-only run therefore yields just `fast:<model>` even though the
 * `modelIds` snapshot also records a standard model that was unused.
 *
 * `reasoning` is always skipped when null.
 */
export function tierModelKeys(m: RunManifest): string[] {
	const evaluated = new Set<string>();
	for (const cr of m.caseResults) {
		if (cr.evaluatedTier === 'fast' || cr.evaluatedTier === 'standard') {
			evaluated.add(cr.evaluatedTier);
		} else if (cr.evaluatedTier === 'reasoning' && m.modelIds.reasoning !== null) {
			evaluated.add('reasoning');
		}
	}
	const keys: string[] = [];
	if (evaluated.has('fast')) keys.push(`fast:${m.modelIds.fast}`);
	if (evaluated.has('standard')) keys.push(`standard:${m.modelIds.standard}`);
	if (evaluated.has('reasoning') && m.modelIds.reasoning !== null) {
		keys.push(`reasoning:${m.modelIds.reasoning}`);
	}
	return keys;
}

function matchesTierAndModel(
	m: RunManifest,
	tier: EvaluatedTier | undefined,
	modelId: string | undefined,
): boolean {
	if (!tier && !modelId) return true;
	const checkTiers: Array<'fast' | 'standard' | 'reasoning'> = tier
		? tier === 'mixed' || tier === 'unknown'
			? []
			: [tier]
		: ['fast', 'standard', 'reasoning'];
	for (const t of checkTiers) {
		const modelForTier = m.modelIds[t];
		if (modelForTier === null || modelForTier === undefined) continue;
		if (!modelId || modelForTier === modelId) return true;
	}
	return false;
}

function isValidManifest(v: unknown, expectedRunId: string): v is RunManifest {
	if (!isPlainObject(v)) return false;
	if (v.runId !== expectedRunId) return false;
	if (!isIso8601(v.startedAt) || !isIso8601(v.completedAt)) return false;
	if (typeof v.judgeOverrideApplied !== 'boolean') return false;
	if (v.judgeModelId !== undefined && typeof v.judgeModelId !== 'string') return false;
	if (!isPlainObject(v.modelIds)) return false;
	const mi = v.modelIds as Record<string, unknown>;
	if (typeof mi.fast !== 'string' || typeof mi.standard !== 'string') return false;
	if (mi.reasoning !== null && typeof mi.reasoning !== 'string') return false;
	if (!Array.isArray(v.bucketsRequested)) return false;
	for (const b of v.bucketsRequested) {
		if (typeof b !== 'string') return false;
	}
	if (!Array.isArray(v.caseResults)) return false;
	for (const cr of v.caseResults) {
		if (!isValidCaseResult(cr)) return false;
	}
	if (!isValidRunSummary(v.summary)) return false;
	return true;
}

/**
 * Strict validator for `RunSummary` shape. Every counter must
 * be a finite non-negative integer; `totalCostUsd` and `totalDurationMs`
 * must be finite non-negative numbers; `routingAccuracy` must be `null` OR a
 * finite number in [0, 1]; `routingInputsEvaluated` must be a finite
 * non-negative integer.
 */
function isValidRunSummary(v: unknown): boolean {
	if (!isPlainObject(v)) return false;
	const nonNegInt = (x: unknown): boolean =>
		typeof x === 'number' && Number.isFinite(x) && x >= 0 && Number.isInteger(x);
	const nonNegNum = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0;
	if (!nonNegInt(v.totalCases)) return false;
	if (!nonNegInt(v.pass)) return false;
	if (!nonNegInt(v.fail)) return false;
	if (!nonNegInt(v.error)) return false;
	if (!nonNegInt(v.budgetExceeded)) return false;
	if (!nonNegInt(v.routingInputsEvaluated)) return false;
	if (!nonNegNum(v.totalCostUsd)) return false;
	if (!nonNegNum(v.totalDurationMs)) return false;
	if (v.routingAccuracy !== null) {
		const ra = v.routingAccuracy;
		if (typeof ra !== 'number' || !Number.isFinite(ra) || ra < 0 || ra > 1) return false;
	}
	return true;
}

function isValidCaseResult(cr: unknown): boolean {
	if (!isPlainObject(cr)) return false;
	if (typeof cr.caseId !== 'string' || !cr.caseId.length) return false;
	if (typeof cr.bucket !== 'string' || !BUCKETS.has(cr.bucket)) return false;
	if (typeof cr.cacheKey !== 'string') return false;
	if (typeof cr.evaluatedTier !== 'string' || !TIERS.has(cr.evaluatedTier)) return false;
	if (typeof cr.verdict !== 'string' || !VERDICTS.has(cr.verdict)) return false;
	if (typeof cr.source !== 'string' || !SOURCES.has(cr.source)) return false;
	if (typeof cr.costUsd !== 'number' || !Number.isFinite(cr.costUsd) || cr.costUsd < 0) {
		return false;
	}
	if (typeof cr.timestamp !== 'string' || !isIso8601(cr.timestamp)) return false;
	return true;
}

function isIso8601(v: unknown): v is string {
	return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}
