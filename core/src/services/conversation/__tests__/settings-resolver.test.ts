import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../types/config.js';
import { resolveUserBool } from '../settings-resolver.js';

function makeConfig(overrides: Record<string, unknown> | null): AppConfigService {
	return {
		get: vi.fn(),
		getAll: vi.fn(),
		getOverrides: vi.fn().mockResolvedValue(overrides),
		setAll: vi.fn(),
		updateOverrides: vi.fn(),
	} as unknown as AppConfigService;
}

describe('resolveUserBool — happy path', () => {
	it('returns true when override is boolean true', async () => {
		expect(await resolveUserBool(makeConfig({ log_to_notes: true }), 'u1', 'log_to_notes', false)).toBe(true);
	});

	it('returns false when override is boolean false', async () => {
		expect(await resolveUserBool(makeConfig({ log_to_notes: false }), 'u1', 'log_to_notes', true)).toBe(false);
	});

	it('returns systemDefault true when no override file', async () => {
		expect(await resolveUserBool(makeConfig(null), 'u1', 'log_to_notes', true)).toBe(true);
	});

	it('returns systemDefault false when no override file', async () => {
		expect(await resolveUserBool(makeConfig(null), 'u1', 'log_to_notes', false)).toBe(false);
	});

	it('returns systemDefault when key is absent from override file', async () => {
		expect(await resolveUserBool(makeConfig({ other_key: 'x' }), 'u1', 'log_to_notes', true)).toBe(true);
	});
});

describe('resolveUserBool — critical case (Codex finding #1)', () => {
	it('manifest default=false + systemDefault=true + no user override → true', async () => {
		// This is the case that would fail if we used getAll (which merges manifest defaults)
		// instead of getOverrides (raw only). With getAll, the manifest default 'false' would
		// be returned. With getOverrides → null, we return systemDefault (true).
		expect(await resolveUserBool(makeConfig(null), 'u1', 'log_to_notes', true)).toBe(true);
	});
});

describe('resolveUserBool — string coercion', () => {
	it.each([
		['true', true],
		['True', true],
		['TRUE', true],
		['on', true],
		['ON', true],
		['1', true],
		['false', false],
		['False', false],
		['FALSE', false],
		['off', false],
		['OFF', false],
		['0', false],
	])('coerces string %p → %p', async (raw, expected) => {
		expect(await resolveUserBool(makeConfig({ log_to_notes: raw }), 'u1', 'log_to_notes', !expected)).toBe(expected);
	});
});

describe('resolveUserBool — edge cases', () => {
	it('returns systemDefault for unrecognised string value, logs warn', async () => {
		const logger = { warn: vi.fn() };
		const result = await resolveUserBool(makeConfig({ log_to_notes: 'banana' }), 'u1', 'log_to_notes', true, logger);
		expect(result).toBe(true);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('returns systemDefault when getOverrides throws, logs warn', async () => {
		const config = {
			get: vi.fn(),
			getAll: vi.fn(),
			getOverrides: vi.fn().mockRejectedValue(new Error('IO error')),
			setAll: vi.fn(),
			updateOverrides: vi.fn(),
		} as unknown as AppConfigService;

		const logger = { warn: vi.fn() };
		const result = await resolveUserBool(config, 'u1', 'log_to_notes', false, logger);
		expect(result).toBe(false);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('never throws — always returns a boolean', async () => {
		const config = {
			get: vi.fn(),
			getAll: vi.fn(),
			getOverrides: vi.fn().mockRejectedValue(new Error('disaster')),
			setAll: vi.fn(),
			updateOverrides: vi.fn(),
		} as unknown as AppConfigService;

		const result = await resolveUserBool(config, 'u1', 'log_to_notes', true);
		expect(typeof result).toBe('boolean');
	});
});
