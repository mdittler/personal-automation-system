import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBareVerdictLiterals } from '@core/testing/verdict-literal-scan.js';
import { describe, expect, it } from 'vitest';

/**
 * Guards the core-side GUI regression-services production code: verdict values
 * must be referenced through the `VERDICT` constant, never bare string
 * literals. The companion guard for the regression workspace's own oracle and
 * runner files is `regression/src/__tests__/verdict-literal-guard.test.ts` —
 * the root vitest config omits `regression`, so the two workspaces have
 * disjoint test runs and each guards its own files. Shared scan logic:
 * `@core/testing/verdict-literal-scan.ts`.
 *
 * See docs/open-items.md — "Regression oracle verdict literals".
 */
const SERVICES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED_FILES = [
	'leaderboard-aggregator.ts',
	'trend-aggregator.ts',
	'weakness-summarizer.ts',
	'run-history-store.ts',
];

describe('GUI regression services — verdict literals → VERDICT constant', () => {
	for (const file of GUARDED_FILES) {
		const source = readFileSync(join(SERVICES_DIR, file), 'utf8');
		it(`${file}: no bare verdict string literals`, () => {
			expect(findBareVerdictLiterals(source, file)).toEqual([]);
		});
	}
});
