/**
 * RunManifest writer (REQ-REG-GUI-V2-003).
 *
 * The regression subprocess writes one manifest per invocation when
 * `--run-id=<uuid>` is set. The GUI's `run-history-store` reads them to
 * build the per-tier leaderboard. Pure CLI invocations omit `--run-id`
 * and no manifest is written (no disk side-effects for interactive use).
 *
 * Manifest write is atomic (mkdir + tmp + rename) via `atomicWriteJson`,
 * so the GUI never observes a torn file.
 */

import { join } from 'node:path';
import type {
	ManifestCaseResult,
	PersonaCase,
	RunManifest,
	RunResult,
	RunSummary,
	TierModelSnapshot,
} from '@core/types/regression.js';
import { getEvaluatedTier } from '@core/types/regression.js';
import { atomicWriteJson } from './atomic-write.js';

export interface BuildManifestInput {
	runId: string;
	startedAt: string;
	completedAt: string;
	modelIds: TierModelSnapshot;
	judgeOverrideApplied: boolean;
	bucketsRequested: readonly string[];
	results: readonly RunResult[];
	/** Each result's PersonaCase — needed only for its `bucket`. */
	cases: ReadonlyMap<string, PersonaCase>;
	summary: RunSummary;
}

export function buildManifest(input: BuildManifestInput): RunManifest {
	const caseResults: ManifestCaseResult[] = input.results.map((r) => {
		const c = input.cases.get(r.caseId);
		if (!c) {
			throw new Error(`buildManifest: missing PersonaCase for result caseId=${r.caseId}`);
		}
		return {
			caseId: r.caseId,
			bucket: c.bucket,
			cacheKey: r.cacheKey,
			evaluatedTier: getEvaluatedTier(r),
			verdict: r.verdict,
			source: r.source,
			costUsd: r.costUsd,
			timestamp: r.timestamp,
		};
	});

	return {
		runId: input.runId,
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		modelIds: input.modelIds,
		judgeOverrideApplied: input.judgeOverrideApplied,
		bucketsRequested: input.bucketsRequested,
		caseResults,
		summary: input.summary,
	};
}

/**
 * Atomically write the manifest to `<rootDir>/<runId>.json`. Caller is
 * responsible for validating `runId` (the CLI does this via the UUID regex
 * in `args.ts`).
 */
export async function writeManifest(rootDir: string, manifest: RunManifest): Promise<string> {
	const path = join(rootDir, `${manifest.runId}.json`);
	await atomicWriteJson(path, manifest);
	return path;
}
