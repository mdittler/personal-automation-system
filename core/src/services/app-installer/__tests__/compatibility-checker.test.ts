import { describe, expect, it } from 'vitest';
import { checkCompatibility } from '../compatibility-checker.js';

describe('Compatibility Checker', () => {
	// --- Standard (happy path) ---

	it('should return compatible for satisfied range', () => {
		const result = checkCompatibility('>=0.1.0', '0.1.0');
		expect(result.compatible).toBe(true);
		expect(result.coreVersion).toBe('0.1.0');
		expect(result.requiredRange).toBe('>=0.1.0');
		expect(result.message).toBeUndefined();
	});

	it('should return compatible for exact version match', () => {
		const result = checkCompatibility('0.1.0', '0.1.0');
		expect(result.compatible).toBe(true);
	});

	it('should return compatible for range with upper bound', () => {
		const result = checkCompatibility('>=1.0.0 <2.0.0', '1.5.3');
		expect(result.compatible).toBe(true);
	});

	it('should return compatible for caret range', () => {
		const result = checkCompatibility('^1.0.0', '1.9.9');
		expect(result.compatible).toBe(true);
	});

	it('should return compatible for tilde range', () => {
		const result = checkCompatibility('~1.2.0', '1.2.5');
		expect(result.compatible).toBe(true);
	});

	// --- Edge cases: incompatible ---

	it('should return incompatible when version is below range', () => {
		const result = checkCompatibility('>=2.0.0', '1.3.0');
		expect(result.compatible).toBe(false);
		expect(result.message).toContain('">=2.0.0" not satisfied');
		expect(result.message).toContain('v1.3.0');
	});

	it('should return incompatible when version is above range', () => {
		const result = checkCompatibility('>=1.0.0 <2.0.0', '2.0.0');
		expect(result.compatible).toBe(false);
		expect(result.message).toContain('not satisfied');
	});

	it('should return incompatible for caret range major mismatch', () => {
		const result = checkCompatibility('^2.0.0', '1.9.9');
		expect(result.compatible).toBe(false);
	});

	// --- Edge cases: invalid inputs ---

	it('should return incompatible for invalid semver range', () => {
		const result = checkCompatibility('not-a-range', '1.0.0');
		expect(result.compatible).toBe(false);
		expect(result.message).toContain('Invalid semver range');
	});

	it('should return incompatible for invalid core version', () => {
		const result = checkCompatibility('>=1.0.0', 'not-a-version');
		expect(result.compatible).toBe(false);
		expect(result.message).toContain('Invalid CoreServices version');
	});

	// --- Edge cases: complex ranges ---

	it('should handle OR ranges', () => {
		const result = checkCompatibility('>=1.0.0 <2.0.0 || >=3.0.0', '3.1.0');
		expect(result.compatible).toBe(true);
	});

	it('should reject value in gap of OR range', () => {
		const result = checkCompatibility('>=1.0.0 <2.0.0 || >=3.0.0', '2.5.0');
		expect(result.compatible).toBe(false);
	});

	it('should handle pre-release versions', () => {
		const result = checkCompatibility('>=1.0.0-alpha.1', '1.0.0');
		expect(result.compatible).toBe(true);
	});

	it('should handle wildcard ranges', () => {
		const result = checkCompatibility('*', '99.99.99');
		expect(result.compatible).toBe(true);
	});
});
