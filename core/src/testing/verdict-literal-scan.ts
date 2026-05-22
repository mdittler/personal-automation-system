import * as ts from 'typescript';
import { VERDICT_VALUES } from '../types/regression.js';

/**
 * Shared AST scanner for the two verdict-literal guard tests — one in the
 * regression workspace (`regression/src/__tests__/verdict-literal-guard.test.ts`)
 * and one core-side (`core/src/gui/services/regression/__tests__/`). The root
 * vitest config omits the `regression` workspace, so the two workspaces have
 * disjoint test runs and each must guard its own files; this module keeps the
 * flagging predicate a single source of truth.
 *
 * `findBareVerdictLiterals` reports every place a file uses a bare
 * 'pass' | 'fail' | 'error' | 'budget-exceeded' string literal where a
 * `VERDICT.*` / `VERDICT_VALUES` reference belongs.
 *
 * AST-based, so comments (not StringLiteral nodes) and type positions are
 * never matched. A verdict-word string literal is flagged UNLESS it is:
 *  - in type position (`'pass' | 'fail'` union → child of a LiteralTypeNode),
 *  - the value of a non-`verdict` property (e.g. `status: 'error'`), or
 *  - an operand of a comparison whose other side is not a `verdict` reference
 *    (e.g. `v.status !== 'error'`).
 * Flagged: `verdict: 'pass'`, `x.verdict === 'fail'`, ternary branches,
 * `new Set(['pass', …])` — runtime verdict literals.
 *
 * See docs/open-items.md — "Regression oracle verdict literals — bare
 * strings in production code".
 */
const VERDICT_WORDS = new Set<string>(VERDICT_VALUES);

/** Static text of a property name — handles `verdict:`, `'verdict':`, `["verdict"]:`. */
function propertyNameText(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
	if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
		return name.expression.text;
	}
	return undefined;
}

function isBareVerdictLiteral(n: ts.Node): n is ts.StringLiteral {
	if (!ts.isStringLiteral(n) || !VERDICT_WORDS.has(n.text)) return false;
	const p = n.parent;
	if (!p) return false;
	if (ts.isLiteralTypeNode(p)) return false; // type union member
	if (ts.isPropertyAssignment(p) && p.initializer === n) {
		// `verdict: 'pass'` → flag; `status: 'error'` → exempt.
		return propertyNameText(p.name) === 'verdict';
	}
	if (ts.isBinaryExpression(p)) {
		// Equality comparison → flag only when the OTHER operand references
		// `verdict` (`x.verdict === 'fail'` / `verdict === 'fail'`). A
		// `status` comparison (`v.status !== 'error'`) is not a verdict.
		const other = p.left === n ? p.right : p.left;
		return (
			(ts.isPropertyAccessExpression(other) && other.name.text === 'verdict') ||
			(ts.isIdentifier(other) && other.text === 'verdict')
		);
	}
	return true; // ternary branch, array element, etc.
}

/** Returns a `line N: 'verdict'` entry for every bare verdict literal in `source`. */
export function findBareVerdictLiterals(source: string, fileName: string): string[] {
	const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
	const hits: string[] = [];
	const visit = (n: ts.Node): void => {
		if (isBareVerdictLiteral(n)) {
			const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
			hits.push(`line ${line}: '${n.text}'`);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return hits;
}
