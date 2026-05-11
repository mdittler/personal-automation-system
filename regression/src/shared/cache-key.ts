import { createHash } from 'node:crypto';
import { hashRepoRelative } from './git-hash.js';
import type { TierModelSnapshot } from './types.js';

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
	return h.digest('hex');
}
