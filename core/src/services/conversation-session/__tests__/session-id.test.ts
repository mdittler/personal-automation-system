import { describe, it, expect } from 'vitest';
import { mintSessionId } from '../session-id.js';

describe('mintSessionId', () => {
	it('formats YYYYMMDD_HHMMSS_<8hex> in UTC', () => {
		const now = new Date(Date.UTC(2026, 3, 27, 15, 45, 0));
		const id = mintSessionId(now, () => 'a1b2c3d4');
		expect(id).toBe('20260427_154500_a1b2c3d4');
	});

	it('produces a valid format with real crypto RNG by default', () => {
		const id = mintSessionId(new Date());
		expect(id).toMatch(/^\d{8}_\d{6}_[0-9a-f]{8}$/);
	});

	it('two consecutive ids in the same second differ in the hex segment', () => {
		const fixed = new Date(Date.UTC(2026, 3, 27, 15, 45, 0));
		const a = mintSessionId(fixed);
		const b = mintSessionId(fixed);
		expect(a).not.toBe(b);
	});

	it('pads single-digit month and day correctly', () => {
		const now = new Date(Date.UTC(2026, 0, 5, 9, 3, 7)); // Jan 5, 09:03:07
		const id = mintSessionId(now, () => '00000000');
		expect(id).toBe('20260105_090307_00000000');
	});

	it('throws when rng returns non-hex output', () => {
		expect(() => mintSessionId(new Date(), () => 'NOTHEXXX')).toThrow();
	});

	it('throws when rng returns output shorter than 8 chars', () => {
		expect(() => mintSessionId(new Date(), () => 'abc')).toThrow();
	});

	it('throws when rng returns output longer than 8 chars', () => {
		expect(() => mintSessionId(new Date(), () => 'a1b2c3d4e5')).toThrow();
	});
});
