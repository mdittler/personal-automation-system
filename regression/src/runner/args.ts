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

export const VALID_BUCKETS = new Set<string>(['routing', 'receipt', 'chatbot', 'recall']);

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
			if (!VALID_BUCKETS.has(v)) {
				throw new Error(`unknown bucket: ${v} (expected one of ${[...VALID_BUCKETS].join(', ')})`);
			}
			opts.bucketFilter = v as CliOptions['bucketFilter'];
			i++;
			continue;
		}
		if (a === '--bucket') {
			const v = argv[i + 1];
			if (v === undefined || !VALID_BUCKETS.has(v)) {
				throw new Error(
					`--bucket requires one of ${[...VALID_BUCKETS].join(', ')} (got: ${String(v)})`,
				);
			}
			opts.bucketFilter = v as CliOptions['bucketFilter'];
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
		throw new Error(`unknown flag: ${a}`);
	}
	if (rerunIds.size > 0) opts.rerunIds = rerunIds;
	return opts;
}
