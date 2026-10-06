import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { PersonaCase } from '@core/types/regression.js';
import { hashRepoRelative } from './git-hash.js';
import type { TierModelSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Today as YYYY-MM-DD in the supplied timezone. Shared between the cache
 * key, the receipt-runner's date-fallback assertion, and `buildRecallAdapter`'s
 * default `today`. Exported so the regression workspace doesn't have three
 * byte-identical copies drifting.
 */
export function todayInTimezone(tz: string): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(new Date());
}

/**
 * Bucket-specific cache-key salts. Today only the `receipt` bucket uses a
 * salt — it binds the cache to today's date + timezone so the parser's
 * `isValidReceiptDate` rejection branch (which depends on `today`) re-runs
 * after a date rollover. Returning `undefined` means no salt is mixed in
 * (the default behavior for routing / recall / chatbot).
 *
 * Both `runSuite()` and `emitCaseList()` call this so cache-key parity holds
 * between `--list` (used by the GUI for the "currently-cached?" indicator)
 * and the actual run.
 */
export function bucketCacheSalt(
	bucket: PersonaCase['bucket'],
	timezone: string,
): string | undefined {
	if (bucket === 'receipt') {
		return `today:${todayInTimezone(timezone)}:tz:${timezone}`;
	}
	return undefined;
}

/**
 * Harness sources whose behaviour shapes a bucket's verdicts (REQ-REG-024).
 * Mixed into every case's key so a fix in a runner, oracle, seed, the LLM
 * layer, or the system under test invalidates stale grades. The chatbot and
 * agent buckets also hash `core/src/` and every app's `src/` plus its
 * manifest (`SUT_HARNESS_PATHS`): those trials grade the live PAS process, so
 * a change under core or an app must not be served a grade from before the
 * change. Entries ending in `/` expand to every tracked or untracked
 * (non-ignored) file below them, excluding `__tests__/`.
 * A contract test asserts each entry exists in the real repository.
 *
 * The expanded-and-hashed harness digest is memoized per path list and repo
 * root for the life of the process, so a run pays for the ~1000 system-under-test
 * files once, not once per case.
 */
export const COMMON_HARNESS_PATHS: readonly string[] = [
	'regression/src/runner/index.ts',
	'regression/src/shared/cache-key.ts',
	'core/src/services/llm/',
];

/**
 * Agent harness import rule (review C24): hashing a file does not hash its
 * imports, so every `regression/src` module that an agent-specific harness
 * file value-imports must itself be listed in `BUCKET_HARNESS_PATHS.agent`.
 * `cache-key.test.ts` enforces this with `HARNESS_IMPORT_RE`. The only
 * exemption is the type re-export module (it carries the `VERDICT` constant
 * and no grading logic).
 */
export const HARNESS_IMPORT_EXEMPT: ReadonlySet<string> = new Set([
	'regression/src/shared/types.ts',
]);
/** Group 1 = `type ` for type-only imports; group 2 = the module specifier. */
export const HARNESS_IMPORT_RE = /import\s+(type\s+)?[\s\S]*?\sfrom\s+'([^']+)'/g;

/**
 * Apps graded as the system under test. Must equal every `apps/<id>` that
 * has both `src/` and `manifest.yaml` — `cache-key.test.ts` checks the list
 * against the tree so a new app cannot be omitted silently.
 */
export const SUT_APP_IDS: readonly string[] = ['echo', 'food', 'notes'];

/** `core/src/` plus each app's sources and manifest. Directory entries end in `/`. */
export const SUT_HARNESS_PATHS: readonly string[] = [
	'core/src/',
	...SUT_APP_IDS.flatMap((id) => [`apps/${id}/src/`, `apps/${id}/manifest.yaml`]),
];

// Keyed by bucket name as a string so the `agent` entry can land before Task 6
// adds `'agent'` to the bucket union.
export const BUCKET_HARNESS_PATHS: Readonly<Record<string, readonly string[]>> = {
	routing: [
		...COMMON_HARNESS_PATHS,
		'regression/src/runner/case-runners/routing-runner.ts',
		'regression/src/runner/dispatch.ts',
		'regression/src/oracles/structural.ts',
	],
	recall: [
		...COMMON_HARNESS_PATHS,
		'regression/src/runner/case-runners/recall-runner.ts',
		'regression/src/runner/dispatch.ts',
		'regression/src/oracles/structural.ts',
	],
	receipt: [
		...COMMON_HARNESS_PATHS,
		'regression/src/runner/case-runners/receipt-runner.ts',
		'regression/src/oracles/structural.ts',
		'regression/src/oracles/transcription.ts',
	],
	chatbot: [
		...COMMON_HARNESS_PATHS,
		...SUT_HARNESS_PATHS,
		'regression/src/runner/case-runners/chatbot-runner.ts',
		'regression/src/runner/chatbot-environment.ts',
		'regression/src/runner/seeded-runtime.ts', // Task 5 extracts the runtime builder here
		'regression/src/oracles/rubric.ts',
		'regression/fixtures/chatbot/seed.json',
	],
	agent: [
		...COMMON_HARNESS_PATHS,
		...SUT_HARNESS_PATHS,
		'regression/src/runner/case-runners/agent-runner.ts',
		'regression/src/runner/agent-trial.ts',
		'regression/src/runner/agent-trial-worker.ts',
		'regression/src/runner/agent-trial-spawn.ts',
		'regression/src/runner/parent-liveness.ts',
		'regression/src/runner/agent-environment.ts',
		'regression/src/runner/seeded-runtime.ts',
		'regression/src/runner/seed.ts',
		// Worker-side provider plumbing (Task 10): error capture + drain, and the registry builder.
		'regression/src/runner/provider-call-tracker.ts',
		'regression/src/runner/provider-registry.ts',
		'regression/src/oracles/outcome.ts',
		// Ground-truth derivation and photo inputs determine the grade too.
		'regression/src/cases/agent/seed-facts.ts',
		'regression/fixtures/agent/seed.sha256',
		'regression/fixtures/receipts/',
	],
};

/** Expand `dir/` entries into sorted file lists (tracked + untracked, non-ignored). */
export async function expandHarnessPaths(
	paths: readonly string[],
	repoRoot: string,
): Promise<string[]> {
	const out = new Set<string>();
	for (const p of paths) {
		if (!p.endsWith('/')) {
			out.add(p);
			continue;
		}
		const { stdout } = await execFileAsync(
			'git',
			['ls-files', '--cached', '--others', '--exclude-standard', '--', p],
			{ cwd: repoRoot },
		);
		for (const f of stdout.split('\n')) {
			if (f && !f.includes('/__tests__/')) out.add(f);
		}
	}
	return [...out].sort();
}

/**
 * How many times this process actually expanded and hashed a harness path
 * list. Cache hits do not increment. Tests reset via `clearHarnessDigestCache`.
 */
let harnessDigestComputes = 0;
const harnessDigestCache = new Map<string, Promise<string>>();

export function harnessDigestComputeCount(): number {
	return harnessDigestComputes;
}

/** Drop the per-process harness digest memo. A new regression run is a new process. */
export function clearHarnessDigestCache(): void {
	harnessDigestCache.clear();
	harnessDigestComputes = 0;
}

async function memoizedHarnessDigest(
	paths: readonly string[],
	repoRoot: string,
	hash: (p: string) => Promise<string>,
): Promise<string> {
	const key = `${repoRoot}\0${paths.join('\0')}`;
	const cached = harnessDigestCache.get(key);
	if (cached) return cached;
	harnessDigestComputes += 1;
	const pending = (async () => {
		const files = await expandHarnessPaths(paths, repoRoot);
		const entries = await Promise.all(
			files.map(async (p) => {
				try {
					return `${p}:${await hash(p)}`;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${p}:absent`;
					throw err;
				}
			}),
		);
		return entries.join('\n');
	})();
	harnessDigestCache.set(key, pending);
	try {
		return await pending;
	} catch (err) {
		harnessDigestCache.delete(key);
		throw err;
	}
}

export interface ComputeCacheKeyArgs {
	casePath: string; // repo-relative
	coveragePaths: string[]; // all repo-relative
	modelIds: TierModelSnapshot;
	repoRoot: string;
	/**
	 * Optional memo of `repoRelativePath → Promise<hash>`. Pass a shared `Map`
	 * across many `computeCacheKey` calls within one orchestrator invocation
	 * to coalesce repeated `git hash-object` spawns for shared coverage paths.
	 * Map values are promises so concurrent callers awaiting the same path
	 * still only pay the cost once.
	 */
	hashCache?: Map<string, Promise<string>>;
	/**
	 * Optional bucket-specific salt mixed into the hash before model/coverage
	 * components. Used by the receipt bucket to bind cache keys to today's
	 * date + timezone — same-day reruns still hit cache, but date rollover
	 * invalidates so the date-fallback branch (`isValidReceiptDate` →
	 * `rawExtractedDate`) re-exercises. Omitted for routing/recall/chatbot.
	 */
	extraSalt?: string;
	/** Case id — distinguishes cases that share one definition file. */
	caseId?: string;
	/**
	 * Harness sources (see `BUCKET_HARNESS_PATHS`). Unlike `coveragePaths`, a
	 * missing harness file contributes `path:absent` instead of throwing, so
	 * temp-repo unit tests need not recreate the real harness tree.
	 */
	harnessPaths?: readonly string[];
}

export async function computeCacheKey(args: ComputeCacheKeyArgs): Promise<string> {
	const hash = (p: string): Promise<string> => {
		if (!args.hashCache) return hashRepoRelative(p, { repoRoot: args.repoRoot });
		const existing = args.hashCache.get(p);
		if (existing) return existing;
		const pending = hashRepoRelative(p, { repoRoot: args.repoRoot });
		args.hashCache.set(p, pending);
		return pending;
	};
	const caseHash = await hash(args.casePath);
	const sortedCoverage = [...args.coveragePaths].sort();
	const hashes = await Promise.all(sortedCoverage.map(hash));
	const coverageEntries = sortedCoverage.map((p, i) => `${p}:${hashes[i]}`);

	const harnessJoined = args.harnessPaths
		? await memoizedHarnessDigest(args.harnessPaths, args.repoRoot, hash)
		: '';

	const modelStr = `fast=${args.modelIds.fast},standard=${args.modelIds.standard},reasoning=${args.modelIds.reasoning ?? 'none'}`;

	const h = createHash('sha256');
	h.update(caseHash);
	h.update('\0');
	h.update(coverageEntries.join('\n'));
	h.update('\0');
	h.update(modelStr);
	if (args.caseId !== undefined) {
		h.update('\0');
		h.update(`case:${args.caseId}`);
	}
	if (harnessJoined.length > 0) {
		h.update('\0');
		h.update(`harness:${harnessJoined}`);
	}
	// Salt is mixed in last with a distinguishing prefix. `extraSalt` omitted
	// vs `extraSalt: ''` yields different keys (defensive: empty string is a
	// real value, not "unsalted").
	if (args.extraSalt !== undefined) {
		h.update('\0');
		h.update('salt:');
		h.update(args.extraSalt);
	}
	return h.digest('hex');
}
