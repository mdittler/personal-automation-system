import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the GUI test-file import-style cleanup.
 *
 * Inline `import('…').TypeName` type expressions force Biome's formatter to
 * keep them on one line (esbuild cannot parse a split inline import type),
 * which previously required `// biome-ignore format:` suppressions. The fix
 * is top-of-file `import type { … }` declarations. This guard fails if the
 * inline type imports (AST `ImportTypeNode`s — a runtime `import()` is a
 * CallExpression and is NOT matched) or the esbuild/import format
 * suppressions reappear.
 *
 * See docs/open-items.md — Unfinished Corrections — "GUI test files —
 * inline dynamic-import type casts need import type conversion".
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = 'inline-type-import-guard.test.ts';

// Only the import-type suppressions added by the 2026-05-20 cleanup; a
// future legitimate `biome-ignore format:` for another reason is allowed.
const IMPORT_TYPE_SUPPRESSION = /biome-ignore\s+format:[^\n]*\b(?:esbuild|import)\b/i;

function inlineImportTypeLines(source: string, fileName: string): number[] {
	const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
	const lines: number[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isImportTypeNode(n)) {
			lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return lines;
}

const files = readdirSync(TEST_DIR)
	.filter((f) => f.endsWith('.test.ts') && f !== SELF)
	.sort();

describe('GUI test files — no inline import() type casts', () => {
	it('finds GUI test files to scan', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		const source = readFileSync(join(TEST_DIR, file), 'utf8');

		it(`${file}: no inline import() type expressions`, () => {
			expect(inlineImportTypeLines(source, file)).toEqual([]);
		});

		it(`${file}: no esbuild/import-type format suppressions`, () => {
			expect(IMPORT_TYPE_SUPPRESSION.test(source)).toBe(false);
		});
	}
});
