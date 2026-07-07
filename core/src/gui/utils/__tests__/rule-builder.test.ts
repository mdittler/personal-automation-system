/**
 * Rule builder mapping (Batch 4, Task 4.1) — deterministic-grammar picker
 * mapped 1:1 to the EXACT six patterns `evaluateDeterministic`
 * (`core/src/services/condition-evaluator/evaluator.ts`) recognizes:
 *   'is empty' | 'is not empty' | 'contains "X"' | 'not contains "X"' |
 *   'line count > N' | 'line count < N'.
 * Anything else is out of scope for the rule builder and renders as
 * Advanced (raw expression) in the wizard.
 */
import { describe, expect, it } from 'vitest';
import { RULE_PATTERNS, buildExpression, parseExpression } from '../rule-builder.js';

describe('RULE_PATTERNS', () => {
	it('has exactly six entries with plain-language labels', () => {
		expect(RULE_PATTERNS).toHaveLength(6);
		const ids = RULE_PATTERNS.map((p) => p.id);
		expect(new Set(ids).size).toBe(6);
		for (const p of RULE_PATTERNS) {
			expect(p.label.length).toBeGreaterThan(0);
		}
	});
});

describe('buildExpression', () => {
	it('emits exactly the six expressions evaluateDeterministic recognizes', () => {
		expect(buildExpression({ pattern: 'is_empty' })).toBe('is empty');
		expect(buildExpression({ pattern: 'not_empty' })).toBe('is not empty');
		expect(buildExpression({ pattern: 'contains', text: 'milk' })).toBe('contains "milk"');
		expect(buildExpression({ pattern: 'not_contains', text: 'milk' })).toBe('not contains "milk"');
		expect(buildExpression({ pattern: 'more_lines', n: 10 })).toBe('line count > 10');
		expect(buildExpression({ pattern: 'fewer_lines', n: 3 })).toBe('line count < 3');
	});

	it('round-trips every pattern through parseExpression', () => {
		const cases = [
			{ pattern: 'is_empty' as const },
			{ pattern: 'not_empty' as const },
			{ pattern: 'contains' as const, text: 'expired' },
			{ pattern: 'not_contains' as const, text: 'expired' },
			{ pattern: 'more_lines' as const, n: 7 },
			{ pattern: 'fewer_lines' as const, n: 2 },
		];
		for (const c of cases) {
			const expr = buildExpression(c);
			const parsed = parseExpression(expr);
			expect(parsed).toEqual(c);
		}
	});

	it('rejects unquotable text (embedded double quote) with a friendly error', () => {
		expect(() => buildExpression({ pattern: 'contains', text: 'says "hi"' })).toThrow(/quote/i);
		expect(() => buildExpression({ pattern: 'not_contains', text: 'a "b"' })).toThrow(/quote/i);
	});

	it('rejects empty contains/not_contains text', () => {
		expect(() => buildExpression({ pattern: 'contains', text: '' })).toThrow();
		expect(() => buildExpression({ pattern: 'not_contains', text: '   ' })).toThrow();
	});

	it('rejects negative or non-integer N for line-count patterns', () => {
		expect(() => buildExpression({ pattern: 'more_lines', n: -1 })).toThrow();
		expect(() => buildExpression({ pattern: 'fewer_lines', n: 1.5 })).toThrow();
	});
});

describe('parseExpression', () => {
	it('parses all six recognized forms', () => {
		expect(parseExpression('is empty')).toEqual({ pattern: 'is_empty' });
		expect(parseExpression('is not empty')).toEqual({ pattern: 'not_empty' });
		expect(parseExpression('contains "milk"')).toEqual({ pattern: 'contains', text: 'milk' });
		expect(parseExpression('not contains "milk"')).toEqual({
			pattern: 'not_contains',
			text: 'milk',
		});
		expect(parseExpression('line count > 10')).toEqual({ pattern: 'more_lines', n: 10 });
		expect(parseExpression('line count < 3')).toEqual({ pattern: 'fewer_lines', n: 3 });
	});

	it('returns null for anything else (renders as Advanced)', () => {
		expect(parseExpression('some legacy free text')).toBeNull();
		expect(parseExpression('')).toBeNull();
		expect(parseExpression('line count >= 5')).toBeNull();
		expect(parseExpression('contains milk')).toBeNull();
	});

	it('is whitespace/case tolerant like evaluateDeterministic', () => {
		expect(parseExpression('  Is Empty  ')).toEqual({ pattern: 'is_empty' });
		expect(parseExpression('LINE COUNT > 5')).toEqual({ pattern: 'more_lines', n: 5 });
	});
});
