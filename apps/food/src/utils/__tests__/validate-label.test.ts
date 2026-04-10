/**
 * Regression tests for the shared label validator.
 *
 * Added as part of finding C1 (slugifyLabel was throwing inside the
 * confirm-save callback because the awaiting_label step only checked
 * length > 0). Centralizing the validation lets every entry point reject
 * bad labels at the boundary instead of crashing deep in a callback.
 */

import { describe, it, expect } from 'vitest';
import { validateLabel } from '../validate-label.js';

describe('validateLabel', () => {
	it('accepts a normal label and returns the slug', () => {
		expect(validateLabel('Chipotle Bowl')).toEqual({
			ok: true,
			slug: 'chipotle-bowl',
		});
	});

	it('rejects empty / whitespace-only', () => {
		expect(validateLabel('').ok).toBe(false);
		expect(validateLabel('   ').ok).toBe(false);
	});

	it('rejects all-symbol labels that produce no safe slug (finding C1)', () => {
		const r = validateLabel('!!!!!');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/at least one letter/i);
	});

	it('rejects labels with markdown special characters (finding H6)', () => {
		const cases = ['my *favorite*', 'with _emphasis_', 'has [brackets]', 'with `code`'];
		for (const c of cases) {
			const r = validateLabel(c);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/cannot contain/i);
		}
	});

	it('rejects labels longer than 100 chars', () => {
		const r = validateLabel('a'.repeat(101));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/100 characters/);
	});

	it('accepts labels containing unicode (validation only blocks markdown specials)', () => {
		const r = validateLabel('Pâté de campagne');
		expect(r.ok).toBe(true);
	});
});
