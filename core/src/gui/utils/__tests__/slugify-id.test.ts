/**
 * `slugifyForId` — turns a human-entered name into a REPORT_ID_PATTERN /
 * ALERT_ID_PATTERN-compatible id (`^[a-z][a-z0-9-]*$`), and
 * `uniqueSlugForId` layers on a `-2`/`-3`/... collision suffix by probing an
 * injected lookup function. Used by report-wizard.ts / alert-wizard.ts's
 * step-3/step-4 handlers so a blank "ID" field auto-derives from the name
 * instead of silently failing HTML5 `required` + `pattern` validation
 * (B1 live-verification fix).
 */
import { describe, expect, it } from 'vitest';
import { slugifyForId, uniqueSlugForId } from '../slugify-id.js';

describe('slugifyForId', () => {
	it('lowercases and hyphenates spaces', () => {
		expect(slugifyForId('Weekly Digest')).toBe('weekly-digest');
	});

	it('strips characters outside [a-z0-9-]', () => {
		expect(slugifyForId('Pantry Check! (v2)')).toBe('pantry-check-v2');
	});

	it('collapses consecutive hyphens', () => {
		expect(slugifyForId('Foo   ---   Bar')).toBe('foo-bar');
	});

	it('trims leading/trailing hyphens', () => {
		expect(slugifyForId('  -Leading and trailing-  ')).toBe('leading-and-trailing');
	});

	it('prefixes with "r" when the slug would not start with a letter (e.g. leads with a digit)', () => {
		// REQ pattern is ^[a-z][a-z0-9-]*$ — a name like "2026 Summary" slugifies
		// to a leading digit, which is invalid; prefix with a letter instead of
		// producing an id the service will reject.
		expect(slugifyForId('2026 Summary')).toBe('r-2026-summary');
		expect(slugifyForId('2026 Summary')).toMatch(/^[a-z][a-z0-9-]*$/);
	});

	it('falls back to a generic id when the name has no sluggable characters', () => {
		expect(slugifyForId('!!!')).toBe('item');
		expect(slugifyForId('')).toBe('item');
	});
});

describe('uniqueSlugForId', () => {
	it('returns the base slug when it is not taken', async () => {
		const slug = await uniqueSlugForId('weekly-digest', async () => null);
		expect(slug).toBe('weekly-digest');
	});

	it('appends -2 when the base slug is taken', async () => {
		const taken = new Set(['weekly-digest']);
		const slug = await uniqueSlugForId('weekly-digest', async (id) =>
			taken.has(id) ? { id } : null,
		);
		expect(slug).toBe('weekly-digest-2');
	});

	it('keeps incrementing the suffix until a free slug is found', async () => {
		const taken = new Set(['weekly-digest', 'weekly-digest-2', 'weekly-digest-3']);
		const slug = await uniqueSlugForId('weekly-digest', async (id) =>
			taken.has(id) ? { id } : null,
		);
		expect(slug).toBe('weekly-digest-4');
	});
});
