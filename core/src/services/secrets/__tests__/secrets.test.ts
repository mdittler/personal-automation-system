import { describe, expect, it } from 'vitest';
import { SecretsServiceImpl } from '../index.js';

describe('SecretsService', () => {
	// -- Standard --

	it('returns value for a declared secret', () => {
		const svc = new SecretsServiceImpl({
			values: new Map([['weather-api', 'abc123']]),
		});
		expect(svc.get('weather-api')).toBe('abc123');
	});

	it('has() returns true for declared secret', () => {
		const svc = new SecretsServiceImpl({
			values: new Map([['weather-api', 'abc123']]),
		});
		expect(svc.has('weather-api')).toBe(true);
	});

	it('supports multiple secrets', () => {
		const svc = new SecretsServiceImpl({
			values: new Map([
				['weather-api', 'key1'],
				['calendar-api', 'key2'],
			]),
		});
		expect(svc.get('weather-api')).toBe('key1');
		expect(svc.get('calendar-api')).toBe('key2');
		expect(svc.has('weather-api')).toBe(true);
		expect(svc.has('calendar-api')).toBe(true);
	});

	// -- Edge cases --

	it('returns undefined for undeclared secret ID', () => {
		const svc = new SecretsServiceImpl({
			values: new Map([['weather-api', 'abc123']]),
		});
		expect(svc.get('nonexistent')).toBeUndefined();
	});

	it('has() returns false for undeclared secret ID', () => {
		const svc = new SecretsServiceImpl({
			values: new Map([['weather-api', 'abc123']]),
		});
		expect(svc.has('nonexistent')).toBe(false);
	});

	it('handles empty values map', () => {
		const svc = new SecretsServiceImpl({ values: new Map() });
		expect(svc.get('anything')).toBeUndefined();
		expect(svc.has('anything')).toBe(false);
	});

	it('preserves empty string as a valid secret value', () => {
		const svc = new SecretsServiceImpl({
			values: new Map([['api', '']]),
		});
		expect(svc.get('api')).toBe('');
		expect(svc.has('api')).toBe(true);
	});

	// -- Security --

	it('makes a defensive copy of input map', () => {
		const input = new Map([['weather-api', 'original']]);
		const svc = new SecretsServiceImpl({ values: input });

		// Mutate the input map after construction
		input.set('weather-api', 'mutated');
		input.set('injected', 'bad');

		// Service should still have the original values
		expect(svc.get('weather-api')).toBe('original');
		expect(svc.has('injected')).toBe(false);
	});
});
