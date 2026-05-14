/**
 * Manifest-default resolver for the regression CLI. Lifted out of
 * `cli-main.ts` so precedence + DATA_DIR logic is unit-testable
 * without the top-level-await + process.exit dance of the shell.
 *
 * Precedence:
 *   1. `--no-manifest`     → no manifest written; runId preserved for logs.
 *   2. `--manifest-dir`    → use as-is.
 *   3. `DATA_DIR` env      → `<DATA_DIR>/system/regression-runs` (matches
 *                            `loadSystemConfig` in core).
 *   4. fallback            → `<repoRoot>/data/system/regression-runs`.
 *
 * `runId` defaults to `crypto.randomUUID()` when not supplied.
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { CliOptions } from './args.js';

export interface ManifestEnv {
	DATA_DIR?: string;
}

export interface ManifestDefaults {
	runId: string | null;
	manifestDir: string | null;
}

export function resolveManifestDefaults(
	cli: Pick<CliOptions, 'noManifest' | 'runId' | 'manifestDir'>,
	env: ManifestEnv,
	repoRoot: string,
): ManifestDefaults {
	if (cli.noManifest) {
		return { runId: cli.runId ?? null, manifestDir: null };
	}
	const manifestDir = cli.manifestDir
		? resolve(cli.manifestDir)
		: env.DATA_DIR
			? resolve(env.DATA_DIR, 'system', 'regression-runs')
			: resolve(repoRoot, 'data', 'system', 'regression-runs');
	const runId = cli.runId ?? randomUUID();
	return { runId, manifestDir };
}
