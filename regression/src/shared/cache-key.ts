import { createHash } from 'node:crypto';
import { hashRepoRelative } from './git-hash.js';
import type { TierModelSnapshot } from './types.js';

export interface ComputeCacheKeyArgs {
	casePath: string; // repo-relative
	coveragePaths: string[]; // all repo-relative
	modelIds: TierModelSnapshot;
	repoRoot: string;
}

export async function computeCacheKey(args: ComputeCacheKeyArgs): Promise<string> {
	const caseHash = await hashRepoRelative(args.casePath, { repoRoot: args.repoRoot });
	const sortedCoverage = [...args.coveragePaths].sort();
	const coverageEntries: string[] = [];
	for (const p of sortedCoverage) {
		const h = await hashRepoRelative(p, { repoRoot: args.repoRoot });
		coverageEntries.push(`${p}:${h}`);
	}

	const modelStr = `fast=${args.modelIds.fast},standard=${args.modelIds.standard},reasoning=${args.modelIds.reasoning ?? 'none'}`;

	const h = createHash('sha256');
	h.update(caseHash);
	h.update('\0');
	h.update(coverageEntries.join('\n'));
	h.update('\0');
	h.update(modelStr);
	return h.digest('hex');
}
