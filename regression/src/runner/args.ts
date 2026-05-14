/**
 * CLI arg parser for `pnpm test:regression`.
 *
 * Supports:
 *   --bucket=<name>  or  --bucket <name>   (routing | receipt | chatbot | recall)
 *   --rerun=<id>     or  --rerun <id>      (repeatable — accumulates into a Set)
 *   --dry-run        (skip dispatch; print estimate)
 *   --json           (emit line-delimited JSON events; used by the GUI subprocess)
 *   --list           (emit case-list NDJSON only; no dispatch — used by the GUI)
 *   --help           (print HELP_TEXT and exit 0)
 *   --run-id=<uuid>  Tag this run with a UUID; writes a RunManifest.
 *   --no-manifest    (REQ-REG-CLI-MAN-001) Suppress manifest writing; wins
 *                    over both --run-id and --manifest-dir.
 *   --manifest-dir=<path>  Override manifest output directory; otherwise
 *                    resolved from `DATA_DIR` env or `<repoRoot>/data/system/regression-runs`.
 *
 * `--model-matrix` and `--judge-model` parsing lives in
 * `core/src/services/regression/model-spec.ts` — same parser is used by the
 * GUI POST handler (REQ-REG-GUI-OV-003).
 *
 * Default-manifest resolution (run-id + manifestDir) is handled in
 * `runner-options.ts` (REQ-REG-CLI-MAN-001) so the precedence + DATA_DIR
 * env logic is unit-testable separately from the CLI shell.
 */

import {
	type ModelMatrix,
	parseJudgeModelValue,
	parseModelMatrixValue,
} from '@core/services/regression/model-spec.js';
import type { ModelRef } from '@core/types/llm.js';
import { SAFE_RUN_ID_RE } from '@core/types/regression.js';
import { VALID_BUCKETS, isValidBucket } from '../shared/types.js';

/** Mirrors `validatePersonaCase`'s ID_RE so a `--rerun=<id>` value cannot
 * escape the case-id allowlist when forwarded to the subprocess. */
const RERUN_ID_RE = /^[a-z][a-z0-9-]{0,127}$/;

/**
 * Re-export of the canonical UUID allowlist used by the regression workspace
 * (REQ-REG-GUI-V2-003). The single source of truth lives in
 * `core/src/types/regression.ts` so every call site validates identically.
 */
export { SAFE_RUN_ID_RE as RUN_ID_RE };

export interface CliOptions {
	bucketFilter?: 'routing' | 'receipt' | 'chatbot' | 'recall';
	rerunIds?: Set<string>;
	dryRun: boolean;
	json: boolean;
	help: boolean;
	listOnly: boolean;
	/** Force fresh dispatch for every case (no cache reads). */
	noCache: boolean;
	modelMatrix?: ModelMatrix;
	judgeModel?: ModelRef;
	/** Caller-supplied run UUID. When absent and `noManifest === false`,
	 *  `resolveManifestDefaults` synthesizes one. */
	runId?: string;
	/** Suppress manifest writes. Wins over `runId` and `manifestDir`. */
	noManifest: boolean;
	/** Manifest output directory override. */
	manifestDir?: string;
}

export const HELP_TEXT = `\
pnpm test:regression — Persona Regression Suite runner

Usage:
  pnpm test:regression                 Run all buckets, respect cache, exit 0/1 per REQ-REG-011.
  pnpm test:regression -- --help       Show this help.
  pnpm test:regression -- --dry-run    Print estimated cost without dispatching.
  pnpm test:regression -- --json       Emit line-delimited JSON events (used by GUI).
  pnpm test:regression -- --list       List cases as JSON (used by GUI; no dispatch).
  pnpm test:regression -- --bucket=<b> Run only cases with bucket=<b> (routing|receipt|chatbot|recall).
  pnpm test:regression -- --rerun <id> Force fresh dispatch for case <id> (repeatable).
  pnpm test:regression -- --rerun=<id> Same, in equals form (used by GUI subprocess).
  pnpm test:regression -- --model-matrix=<list>
                                       Override tier model IDs. Forms:
                                         provider/model[,provider/model[,provider/model]]
                                           (positional — fast, standard, reasoning)
                                         tier=provider/model[,tier=provider/model]
                                           (tier is fast|standard|reasoning)
  pnpm test:regression -- --judge-model=<provider/model>
                                       Override the rubric-oracle judge model (standard tier).
  pnpm test:regression -- --no-cache   Force fresh dispatch for every case (skip all cache reads).
  pnpm test:regression -- --run-id=<uuid>
                                       Tag this run with a UUID; subprocess writes a RunManifest
                                       JSON file at $DATA_DIR/system/regression-runs/<uuid>.json so the
                                       GUI leaderboard can attribute results to this run. When omitted,
                                       a UUID is auto-generated (REQ-REG-CLI-MAN-001) — pass
                                       --no-manifest to opt out.
  pnpm test:regression -- --no-manifest
                                       Suppress manifest writing for this run. Takes precedence over
                                       --run-id and --manifest-dir.
  pnpm test:regression -- --manifest-dir=<path>
                                       Override the manifest output directory. Defaults to
                                       $DATA_DIR/system/regression-runs (or <repoRoot>/data/system/regression-runs
                                       when DATA_DIR is unset).

Exit code:
  0  REQ-REG-011 gate met (or below floor).
  1  REQ-REG-011 gate failed (routing accuracy < 0.95 across food-shadow inputs).
`;

function validateRerunId(v: string): string {
	if (!RERUN_ID_RE.test(v)) {
		throw new Error(
			`--rerun requires an id matching ${RERUN_ID_RE.source} (got: ${JSON.stringify(v)})`,
		);
	}
	return v;
}

const MAX_MANIFEST_DIR_LEN = 1024;

function validateManifestDirValue(v: string): string {
	if (!v) throw new Error('--manifest-dir requires a non-empty path');
	if (v.length > MAX_MANIFEST_DIR_LEN) {
		throw new Error(`--manifest-dir value exceeds ${MAX_MANIFEST_DIR_LEN} chars`);
	}
	// Absolute paths are intentionally allowed — operators may want to write
	// to a sibling artifact dir. The manifest-writer's atomic create handles
	// missing parents.
	if (v.split(/[\\/]/).includes('..')) {
		throw new Error('--manifest-dir must not contain path-traversal segments (..)');
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit guard
	if (/[\x00-\x1f]/.test(v)) {
		throw new Error('--manifest-dir must not contain control characters');
	}
	return v;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
	const opts: CliOptions = {
		dryRun: false,
		json: false,
		help: false,
		listOnly: false,
		noCache: false,
		noManifest: false,
	};
	const rerunIds = new Set<string>();
	let i = 0;
	// pnpm's `--` separator is sometimes forwarded to the script depending on
	// the pnpm version. Skip a single leading `--` so users don't have to
	// know whether `pnpm test:regression -- --help` or `pnpm test:regression --help`
	// is the right invocation in their environment.
	if (argv[0] === '--') i = 1;
	while (i < argv.length) {
		const a = argv[i];
		if (a === undefined) break;
		if (a === '--help' || a === '-h') {
			opts.help = true;
			i++;
			continue;
		}
		if (a === '--dry-run') {
			opts.dryRun = true;
			i++;
			continue;
		}
		if (a === '--json') {
			opts.json = true;
			i++;
			continue;
		}
		if (a === '--list') {
			opts.listOnly = true;
			i++;
			continue;
		}
		if (a === '--no-cache') {
			opts.noCache = true;
			i++;
			continue;
		}
		if (a.startsWith('--bucket=')) {
			const v = a.slice('--bucket='.length);
			if (!isValidBucket(v)) {
				throw new Error(`unknown bucket: ${v} (expected one of ${VALID_BUCKETS.join(', ')})`);
			}
			opts.bucketFilter = v;
			i++;
			continue;
		}
		if (a === '--bucket') {
			const v = argv[i + 1];
			if (v === undefined || !isValidBucket(v)) {
				throw new Error(`--bucket requires one of ${VALID_BUCKETS.join(', ')} (got: ${String(v)})`);
			}
			opts.bucketFilter = v;
			i += 2;
			continue;
		}
		if (a.startsWith('--rerun=')) {
			const v = a.slice('--rerun='.length);
			if (!v) throw new Error('--rerun requires an id (e.g. --rerun=food-save-recipe)');
			rerunIds.add(validateRerunId(v));
			i++;
			continue;
		}
		if (a === '--rerun') {
			const v = argv[i + 1];
			if (!v || v.startsWith('--')) {
				throw new Error('--rerun requires an id (e.g. --rerun food-save-recipe)');
			}
			rerunIds.add(validateRerunId(v));
			i += 2;
			continue;
		}
		if (a.startsWith('--model-matrix=')) {
			const v = a.slice('--model-matrix='.length);
			opts.modelMatrix = parseModelMatrixValue(v);
			i++;
			continue;
		}
		if (a === '--model-matrix') {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) {
				throw new Error(
					'--model-matrix requires a value (e.g. --model-matrix provider/model[,...])',
				);
			}
			opts.modelMatrix = parseModelMatrixValue(v);
			i += 2;
			continue;
		}
		if (a.startsWith('--judge-model=')) {
			const v = a.slice('--judge-model='.length);
			opts.judgeModel = parseJudgeModelValue(v);
			i++;
			continue;
		}
		if (a === '--judge-model') {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) {
				throw new Error('--judge-model requires a provider/model value');
			}
			opts.judgeModel = parseJudgeModelValue(v);
			i += 2;
			continue;
		}
		if (a.startsWith('--run-id=')) {
			const v = a.slice('--run-id='.length);
			if (!SAFE_RUN_ID_RE.test(v)) {
				throw new Error(`--run-id must be a UUID (got: ${JSON.stringify(v)})`);
			}
			opts.runId = v;
			i++;
			continue;
		}
		if (a === '--run-id') {
			const v = argv[i + 1];
			if (v === undefined || !SAFE_RUN_ID_RE.test(v)) {
				throw new Error(`--run-id requires a UUID (got: ${String(v)})`);
			}
			opts.runId = v;
			i += 2;
			continue;
		}
		if (a === '--no-manifest') {
			opts.noManifest = true;
			i++;
			continue;
		}
		if (a.startsWith('--manifest-dir=')) {
			opts.manifestDir = validateManifestDirValue(a.slice('--manifest-dir='.length));
			i++;
			continue;
		}
		if (a === '--manifest-dir') {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) {
				throw new Error('--manifest-dir requires a path value');
			}
			opts.manifestDir = validateManifestDirValue(v);
			i += 2;
			continue;
		}
		throw new Error(`unknown flag: ${a}`);
	}
	if (rerunIds.size > 0) opts.rerunIds = rerunIds;
	return opts;
}

/**
 * Combine `--model-matrix` and `--judge-model` flags into a single
 * `tierOverride` object for `buildProductionDeps`. `--judge-model` wins over
 * `--model-matrix=standard=` for the standard slot (the rubric oracle is the
 * primary consumer of standard tier in the regression run, so the dedicated
 * flag takes precedence).
 *
 * Extracted from `cli-main.ts` so the precedence logic is unit-testable
 * (Codex correction #3).
 */
export function buildTierOverrideFromCli(
	opts: CliOptions,
):
	| Partial<Record<'fast' | 'standard' | 'reasoning', { provider: string; model: string }>>
	| undefined {
	if (!opts.modelMatrix && !opts.judgeModel) return undefined;
	const out: Partial<
		Record<'fast' | 'standard' | 'reasoning', { provider: string; model: string }>
	> = {};
	if (opts.modelMatrix?.fast) out.fast = opts.modelMatrix.fast;
	if (opts.judgeModel) out.standard = opts.judgeModel;
	else if (opts.modelMatrix?.standard) out.standard = opts.modelMatrix.standard;
	if (opts.modelMatrix?.reasoning) out.reasoning = opts.modelMatrix.reasoning;
	return out;
}
