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
 */

import { VALID_BUCKETS, isValidBucket } from '../shared/types.js';

/** Mirrors `validatePersonaCase`'s ID_RE so a `--rerun=<id>` value cannot
 * escape the case-id allowlist when forwarded to the subprocess. */
const RERUN_ID_RE = /^[a-z][a-z0-9-]{0,127}$/;

export interface CliOptions {
	bucketFilter?: 'routing' | 'receipt' | 'chatbot' | 'recall';
	rerunIds?: Set<string>;
	dryRun: boolean;
	json: boolean;
	help: boolean;
	listOnly: boolean;
	modelMatrix?: Partial<
		Record<'fast' | 'standard' | 'reasoning', { provider: string; model: string }>
	>;
	judgeModel?: { provider: string; model: string };
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

function parseModelRef(s: string): { provider: string; model: string } {
	const idx = s.indexOf('/');
	if (idx <= 0 || idx === s.length - 1) {
		throw new Error(`--model-matrix entry must be provider/model (got: ${JSON.stringify(s)})`);
	}
	return { provider: s.slice(0, idx), model: s.slice(idx + 1) };
}

function parseModelMatrixValue(v: string): NonNullable<CliOptions['modelMatrix']> {
	if (!v) throw new Error('--model-matrix requires a value (empty string rejected)');
	const out: NonNullable<CliOptions['modelMatrix']> = {};
	const entries = v
		.split(',')
		.map((e) => e.trim())
		.filter(Boolean);
	const positional: Array<keyof NonNullable<CliOptions['modelMatrix']>> = [
		'fast',
		'standard',
		'reasoning',
	];
	let positionalIdx = 0;
	for (const entry of entries) {
		const eqIdx = entry.indexOf('=');
		if (eqIdx > 0) {
			const tierStr = entry.slice(0, eqIdx);
			if (tierStr !== 'fast' && tierStr !== 'standard' && tierStr !== 'reasoning') {
				throw new Error(`--model-matrix tier must be fast/standard/reasoning (got ${tierStr})`);
			}
			out[tierStr] = parseModelRef(entry.slice(eqIdx + 1));
		} else {
			const tier = positional[positionalIdx++];
			if (!tier) throw new Error('--model-matrix: too many positional entries (max 3)');
			out[tier] = parseModelRef(entry);
		}
	}
	return out;
}

function parseJudgeModelValue(v: string): { provider: string; model: string } {
	if (!v) throw new Error('--judge-model requires a value (empty string rejected)');
	const idx = v.indexOf('/');
	if (idx <= 0 || idx === v.length - 1) {
		throw new Error(`--judge-model requires provider/model (got: ${JSON.stringify(v)})`);
	}
	return { provider: v.slice(0, idx), model: v.slice(idx + 1) };
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
	const opts: CliOptions = { dryRun: false, json: false, help: false, listOnly: false };
	const rerunIds = new Set<string>();
	let i = 0;
	// pnpm's `--` separator is sometimes forwarded to the script depending on
	// the pnpm version. Skip a single leading `--` so users don't have to
	// know whether `pnpm test:regression -- --help` or `pnpm test:regression --help`
	// is the right invocation in their environment.
	if (argv[0] === '--') i = 1;
	while (i < argv.length) {
		const a = argv[i]!;
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
		throw new Error(`unknown flag: ${a}`);
	}
	if (rerunIds.size > 0) opts.rerunIds = rerunIds;
	return opts;
}
