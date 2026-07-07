/**
 * Rule builder — deterministic-grammar picker <-> expression string mapping
 * (Batch 4, Task 4.1).
 *
 * Maps EXACTLY the six patterns `evaluateDeterministic`
 * (`core/src/services/condition-evaluator/evaluator.ts`) recognizes:
 *   'is empty' | 'is not empty' | 'contains "X"' | 'not contains "X"' |
 *   'line count > N' | 'line count < N'.
 *
 * `buildExpression` produces the exact expression string the evaluator
 * expects; `parseExpression` is its inverse, returning `null` for anything
 * it can't map 1:1 back to a rule-builder pattern (the wizard renders those
 * as an Advanced raw-expression textarea instead of the rule builder).
 */

export type RulePatternId =
	| 'is_empty'
	| 'not_empty'
	| 'contains'
	| 'not_contains'
	| 'more_lines'
	| 'fewer_lines';

export interface RulePatternDescriptor {
	id: RulePatternId;
	/** Plain-language label for the rule-builder picker UI. */
	label: string;
	/** Whether this pattern needs a free-text value (contains / not_contains). */
	needsText?: boolean;
	/** Whether this pattern needs a line-count integer (more_lines / fewer_lines). */
	needsCount?: boolean;
}

/** The six deterministic patterns, in picker display order. */
export const RULE_PATTERNS: RulePatternDescriptor[] = [
	{ id: 'is_empty', label: 'Is empty' },
	{ id: 'not_empty', label: 'Has anything in it' },
	{ id: 'contains', label: 'Mentions…', needsText: true },
	{ id: 'not_contains', label: "Doesn't mention…", needsText: true },
	{ id: 'more_lines', label: 'Has more than … lines', needsCount: true },
	{ id: 'fewer_lines', label: 'Has fewer than … lines', needsCount: true },
];

export type RuleBuilderValue =
	| { pattern: 'is_empty' }
	| { pattern: 'not_empty' }
	| { pattern: 'contains'; text: string }
	| { pattern: 'not_contains'; text: string }
	| { pattern: 'more_lines'; n: number }
	| { pattern: 'fewer_lines'; n: number };

function assertQuotable(text: string): void {
	if (text.trim().length === 0) {
		throw new Error("This can't be empty. Type what to look for.");
	}
	if (text.includes('"')) {
		throw new Error('This can\'t contain a quote mark ("). Try rephrasing without it.');
	}
}

function assertNonNegativeInteger(n: number): void {
	if (!Number.isInteger(n) || n < 0) {
		throw new Error('Enter a whole number of 0 or more.');
	}
}

/** Build the exact deterministic-grammar expression string for a rule-builder value. */
export function buildExpression(value: RuleBuilderValue): string {
	switch (value.pattern) {
		case 'is_empty':
			return 'is empty';
		case 'not_empty':
			return 'is not empty';
		case 'contains':
			assertQuotable(value.text);
			return `contains "${value.text}"`;
		case 'not_contains':
			assertQuotable(value.text);
			return `not contains "${value.text}"`;
		case 'more_lines':
			assertNonNegativeInteger(value.n);
			return `line count > ${value.n}`;
		case 'fewer_lines':
			assertNonNegativeInteger(value.n);
			return `line count < ${value.n}`;
	}
}

const CONTAINS_RE = /^contains\s+"(.+)"$/;
const NOT_CONTAINS_RE = /^not contains\s+"(.+)"$/;
const MORE_LINES_RE = /^line count\s*>\s*(\d+)$/;
const FEWER_LINES_RE = /^line count\s*<\s*(\d+)$/;

/**
 * Parse a deterministic-grammar expression string back into a rule-builder
 * value, mirroring `evaluateDeterministic`'s case-insensitive, trimmed
 * matching. Returns `null` for anything that doesn't map 1:1 to one of the
 * six patterns — the wizard renders those as Advanced.
 */
export function parseExpression(expression: string): RuleBuilderValue | null {
	const cond = expression.toLowerCase().trim();

	if (cond === 'is empty') return { pattern: 'is_empty' };
	if (cond === 'is not empty') return { pattern: 'not_empty' };

	const notContainsMatch = cond.match(NOT_CONTAINS_RE);
	if (notContainsMatch) {
		return { pattern: 'not_contains', text: notContainsMatch[1] ?? '' };
	}

	const containsMatch = cond.match(CONTAINS_RE);
	if (containsMatch) {
		return { pattern: 'contains', text: containsMatch[1] ?? '' };
	}

	const moreLinesMatch = cond.match(MORE_LINES_RE);
	if (moreLinesMatch) {
		return { pattern: 'more_lines', n: Number.parseInt(moreLinesMatch[1] ?? '0', 10) };
	}

	const fewerLinesMatch = cond.match(FEWER_LINES_RE);
	if (fewerLinesMatch) {
		return { pattern: 'fewer_lines', n: Number.parseInt(fewerLinesMatch[1] ?? '0', 10) };
	}

	return null;
}
