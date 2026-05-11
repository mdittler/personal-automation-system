/**
 * CLI arg parser for `pnpm test:regression`.
 *
 * Supports:
 *   --bucket=<name>  or  --bucket <name>   (routing | receipt | chatbot | recall)
 *   --rerun <id>     (repeatable — accumulates into a Set)
 *   --dry-run        (skip dispatch; print estimate)
 *   --json           (emit line-delimited JSON events; used by the GUI subprocess)
 *   --help           (print HELP_TEXT and exit 0)
 */

export const VALID_BUCKETS = new Set<string>(['routing', 'receipt', 'chatbot', 'recall']);

export interface CliOptions {
	bucketFilter?: 'routing' | 'receipt' | 'chatbot' | 'recall';
	rerunIds?: Set<string>;
	dryRun: boolean;
	json: boolean;
	help: boolean;
}

export const HELP_TEXT = `\
pnpm test:regression — Persona Regression Suite runner

Usage:
  pnpm test:regression                 Run all buckets, respect cache, exit 0/1 per REQ-REG-011.
  pnpm test:regression -- --help       Show this help.
  pnpm test:regression -- --dry-run    Print estimated cost without dispatching.
  pnpm test:regression -- --json       Emit line-delimited JSON events (used by GUI).
  pnpm test:regression -- --bucket=<b> Run only cases with bucket=<b> (routing|receipt|chatbot|recall).
  pnpm test:regression -- --rerun <id> Force fresh dispatch for case <id> (repeatable).

Exit code:
  0  REQ-REG-011 gate met (or below floor).
  1  REQ-REG-011 gate failed (routing accuracy < 0.95 across food-shadow inputs).
`;

export function parseCliArgs(argv: readonly string[]): CliOptions {
	const opts: CliOptions = { dryRun: false, json: false, help: false };
	const rerunIds = new Set<string>();
	let i = 0;
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
		if (a === '--rerun') {
			const v = argv[i + 1];
			if (!v || v.startsWith('--')) {
				throw new Error('--rerun requires an id (e.g. --rerun food-save-recipe)');
			}
			rerunIds.add(v);
			i += 2;
			continue;
		}
		throw new Error(`unknown flag: ${a}`);
	}
	if (rerunIds.size > 0) opts.rerunIds = rerunIds;
	return opts;
}
