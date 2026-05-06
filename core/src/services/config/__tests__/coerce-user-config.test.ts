import { describe, expect, it } from 'vitest';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { coerceUserConfigValue } from '../coerce-user-config.js';

function entry(overrides: Partial<ManifestUserConfig> & Pick<ManifestUserConfig, 'type'>): ManifestUserConfig {
	return {
		key: 'test_key',
		description: 'test',
		default: null,
		...overrides,
	} as ManifestUserConfig;
}

describe('coerceUserConfigValue — boolean', () => {
	const e = entry({ type: 'boolean' });

	it.each([
		[true, true],
		[false, false],
		['true', true],
		['false', false],
		['True', true],
		['FALSE', false],
		['on', true],
		['off', false],
		['ON', true],
		['OFF', false],
		['1', true],
		['0', false],
	])('accepts %p → %p', (raw, expected) => {
		const result = coerceUserConfigValue(e, raw);
		expect(result).toEqual({ ok: true, coerced: expected });
	});

	it.each([
		['yes'],
		['no'],
		['enabled'],
		['2'],
		[''],
		[0],
		[1],
		[{}],
		[[]],
		['banana'],
	])('rejects %p', (raw) => {
		const result = coerceUserConfigValue(e, raw);
		expect(result.ok).toBe(false);
	});
});

describe('coerceUserConfigValue — number', () => {
	const e = entry({ type: 'number' });

	it.each([
		[42, 42],
		[0, 0],
		[-7, -7],
		[3.14, 3.14],
		['42', 42],
		['0', 0],
		['-7', -7],
		['3.14', 3.14],
	])('accepts %p → %p', (raw, expected) => {
		const result = coerceUserConfigValue(e, raw);
		expect(result).toEqual({ ok: true, coerced: expected });
	});

	it.each([
		[NaN],
		[Infinity],
		[-Infinity],
		['NaN'],
		['Infinity'],
		['abc'],
		[''],
		['  '],
		[null],
		[undefined],
		[true],
		[{}],
	])('rejects %p', (raw) => {
		const result = coerceUserConfigValue(e, raw);
		expect(result.ok).toBe(false);
	});
});

describe('coerceUserConfigValue — string', () => {
	const e = entry({ type: 'string' });

	it('accepts a plain string', () => {
		expect(coerceUserConfigValue(e, 'hello')).toEqual({ ok: true, coerced: 'hello' });
	});

	it('trims whitespace', () => {
		expect(coerceUserConfigValue(e, '  hello  ')).toEqual({ ok: true, coerced: 'hello' });
	});

	it('rejects empty string', () => {
		expect(coerceUserConfigValue(e, '').ok).toBe(false);
	});

	it('rejects whitespace-only string', () => {
		expect(coerceUserConfigValue(e, '   ').ok).toBe(false);
	});

	it.each([[null], [undefined], [42], [true], [{}]])('rejects non-string %p', (raw) => {
		expect(coerceUserConfigValue(e, raw).ok).toBe(false);
	});
});

describe('coerceUserConfigValue — select', () => {
	const e = entry({ type: 'select', options: ['alpha', 'beta', 'gamma'] });

	it('accepts a valid option', () => {
		expect(coerceUserConfigValue(e, 'alpha')).toEqual({ ok: true, coerced: 'alpha' });
	});

	it('trims whitespace before checking options', () => {
		expect(coerceUserConfigValue(e, ' beta ')).toEqual({ ok: true, coerced: 'beta' });
	});

	it('rejects a value not in options', () => {
		const result = coerceUserConfigValue(e, 'delta');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('alpha');
	});

	it('rejects empty string', () => {
		expect(coerceUserConfigValue(e, '').ok).toBe(false);
	});

	it('allows any string when options list is empty', () => {
		const eNoOpts = entry({ type: 'select', options: [] });
		expect(coerceUserConfigValue(eNoOpts, 'anything')).toEqual({ ok: true, coerced: 'anything' });
	});

	it.each([[null], [undefined], [42]])('rejects non-string %p', (raw) => {
		expect(coerceUserConfigValue(e, raw).ok).toBe(false);
	});
});

describe('coerceUserConfigValue — number bounds (Fix 3)', () => {
	it('rejects number below min', () => {
		const e = entry({ type: 'number', min: 1, max: 7 });
		const result = coerceUserConfigValue(e, 0);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('below minimum');
	});

	it('rejects number above max', () => {
		const e = entry({ type: 'number', min: 1, max: 7 });
		const result = coerceUserConfigValue(e, 10);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('exceeds maximum');
	});

	it('accepts number within bounds', () => {
		const e = entry({ type: 'number', min: 1, max: 7 });
		expect(coerceUserConfigValue(e, 5)).toEqual({ ok: true, coerced: 5 });
	});

	it('accepts number equal to min boundary', () => {
		const e = entry({ type: 'number', min: 1, max: 7 });
		expect(coerceUserConfigValue(e, 1)).toEqual({ ok: true, coerced: 1 });
	});

	it('accepts number equal to max boundary', () => {
		const e = entry({ type: 'number', min: 1, max: 7 });
		expect(coerceUserConfigValue(e, 7)).toEqual({ ok: true, coerced: 7 });
	});

	it('accepts any finite number when no bounds defined', () => {
		const e = entry({ type: 'number' });
		expect(coerceUserConfigValue(e, -9999)).toEqual({ ok: true, coerced: -9999 });
	});

	it('applies bounds check to string-coerced numbers', () => {
		const e = entry({ type: 'number', min: 1, max: 7 });
		expect(coerceUserConfigValue(e, '0').ok).toBe(false);
		expect(coerceUserConfigValue(e, '5')).toEqual({ ok: true, coerced: 5 });
	});
});

describe('coerceUserConfigValue — string clearable (Fix 4)', () => {
	it('allows clearing a string setting whose default is empty string', () => {
		const e = entry({ type: 'string', default: '' });
		expect(coerceUserConfigValue(e, '')).toEqual({ ok: true, coerced: '' });
	});

	it('allows clearing via whitespace-only input when default is empty string', () => {
		const e = entry({ type: 'string', default: '' });
		expect(coerceUserConfigValue(e, '   ')).toEqual({ ok: true, coerced: '' });
	});

	it('rejects empty string for a string setting whose default is non-empty', () => {
		const e = entry({ type: 'string', default: 'some value' });
		expect(coerceUserConfigValue(e, '').ok).toBe(false);
	});

	it('rejects empty string when default is null (not intentionally clearable)', () => {
		const e = entry({ type: 'string', default: null });
		expect(coerceUserConfigValue(e, '').ok).toBe(false);
	});
});

describe('coerceUserConfigValue — null/undefined guard (all types)', () => {
	it.each(['boolean', 'number', 'string', 'select'] as const)('rejects null for type %s', (type) => {
		expect(coerceUserConfigValue(entry({ type }), null).ok).toBe(false);
	});

	it.each(['boolean', 'number', 'string', 'select'] as const)('rejects undefined for type %s', (type) => {
		expect(coerceUserConfigValue(entry({ type }), undefined).ok).toBe(false);
	});
});

describe('coerceUserConfigValue — contract', () => {
	it('returned coerced boolean is a JS boolean, not a string', () => {
		const result = coerceUserConfigValue(entry({ type: 'boolean' }), 'true');
		expect(result.ok).toBe(true);
		if (result.ok) expect(typeof result.coerced).toBe('boolean');
	});

	it('returned coerced number is a JS number', () => {
		const result = coerceUserConfigValue(entry({ type: 'number' }), '42');
		expect(result.ok).toBe(true);
		if (result.ok) expect(typeof result.coerced).toBe('number');
	});

	it('returned coerced string is trimmed', () => {
		const result = coerceUserConfigValue(entry({ type: 'string' }), '  hi  ');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.coerced).toBe('hi');
	});

	it('failure result has ok:false and a non-empty reason string', () => {
		const result = coerceUserConfigValue(entry({ type: 'boolean' }), 'banana');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(typeof result.reason).toBe('string');
			expect(result.reason.length).toBeGreaterThan(0);
		}
	});
});
