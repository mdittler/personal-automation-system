import { createHash } from 'node:crypto';
import type { PersonaCase } from '@core/types/regression.js';
import { hashRepoRelative } from './git-hash.js';
import type { TierModelSnapshot } from './types.js';

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

	const modelStr = `fast=${args.modelIds.fast},standard=${args.modelIds.standard},reasoning=${args.modelIds.reasoning ?? 'none'}`;

	const h = createHash('sha256');
	h.update(caseHash);
	h.update('\0');
	h.update(coverageEntries.join('\n'));
	h.update('\0');
	h.update(modelStr);
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
