import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBareVerdictLiterals } from '@core/testing/verdict-literal-scan.js';
import { describe, expect, it } from 'vitest';

/**
 * Guards the regression workspace's oracle and runner production code: verdict
 * values must be referenced through the `VERDICT` constant, never bare string
 * literals. The companion guard for the core-side GUI regression services is
 * `core/src/gui/services/regression/__tests__/verdict-literal-guard.test.ts` —
 * the root vitest config omits `regression`, so the two workspaces have
 * disjoint test runs and each guards its own files. Shared scan logic:
 * `@core/testing/verdict-literal-scan.ts`.
 *
 * See docs/open-items.md — "Regression oracle verdict literals".
 */
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED_FILES = ['oracles/structural.ts', 'oracles/rubric.ts', 'runner/markdown-report.ts'];

describe('regression oracles + runner — verdict literals → VERDICT constant', () => {
	for (const rel of GUARDED_FILES) {
		const source = readFileSync(join(SRC_DIR, rel), 'utf8');
		it(`${rel}: no bare verdict string literals`, () => {
			expect(findBareVerdictLiterals(source, rel)).toEqual([]);
		});
	}
});
