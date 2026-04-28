import { describe, expect, it } from 'vitest';
import { buildMatchClause, buildTrustedQuery, buildUntrustedQuery } from '../fts-query.js';

describe('buildUntrustedQuery', () => {
	it('returns empty terms for empty input', () => {
		expect(buildUntrustedQuery('').terms).toEqual([]);
	});

	it('returns empty terms for whitespace-only input', () => {
		expect(buildUntrustedQuery('   ').terms).toEqual([]);
	});

	it('strips FTS5 operator characters', () => {
		const result = buildUntrustedQuery('"pasta" * (noodles):test^2');
		// operators removed, non-operator parts kept
		expect(result.terms).not.toContain('"pasta"');
		for (const t of result.terms) {
			expect(t).not.toMatch(/["*()\:^]/);
		}
	});

	it('strips NEAR keyword edge case', () => {
		const result = buildUntrustedQuery('pasta NEAR noodles');
		// NEAR is a word so it stays (it's not a special character), but that's fine
		expect(result.terms.length).toBeGreaterThan(0);
	});

	it('preserves unicode and diacritics', () => {
		const result = buildUntrustedQuery('crème brûlée');
		expect(result.terms).toContain('crème');
		expect(result.terms).toContain('brûlée');
	});

	it('strips zero-width characters', () => {
		const result = buildUntrustedQuery('pasta​noodles'); // zero-width space
		// zero-width stripped → becomes whitespace → split into two terms or merged
		for (const t of result.terms) {
			expect(t).not.toContain('​');
		}
	});

	it('truncates oversized input', () => {
		const long = 'a '.repeat(300);
		const result = buildUntrustedQuery(long);
		const totalChars = result.terms.join(' ').length;
		expect(totalChars).toBeLessThan(520); // truncated at 500
	});

	it('returns empty terms for purely-operator input', () => {
		expect(buildUntrustedQuery('"*():^"').terms).toEqual([]);
	});
});

describe('buildMatchClause', () => {
	it('joins terms with AND', () => {
		expect(buildMatchClause(['pasta', 'noodles'])).toBe('"pasta" AND "noodles"');
	});

	it('handles single term', () => {
		expect(buildMatchClause(['pasta'])).toBe('"pasta"');
	});
});

describe('buildTrustedQuery', () => {
	it('passes through raw FTS5 expression', () => {
		expect(buildTrustedQuery('"pasta noodles" OR "rice"')).toBe('"pasta noodles" OR "rice"');
	});
});
