/**
 * Boot-time duplicate-name scan tests.
 *
 * Verifies the pure function contract:
 *   - Returns `[]` when names are unique.
 *   - Returns the duplicate groups and logs a structured Pino error
 *     when ANY normalized name has 2+ user ids.
 *   - Detection is case-insensitive and whitespace-insensitive (per
 *     `normalizeDisplayName`).
 *   - Empty/blank names are skipped (validateConfig covers that policy).
 */

import { describe, expect, it, vi } from 'vitest';
import { scanForDuplicateNames } from '../scan-duplicate-names.js';

function makeLogger() {
	return {
		error: vi.fn(),
	};
}

describe('scanForDuplicateNames — duplicate-free case', () => {
	it('returns [] with no logs when names are all unique', () => {
		const logger = makeLogger();
		const result = scanForDuplicateNames({
			users: [
				{ id: '111', name: 'Matt' },
				{ id: '222', name: 'Sarah' },
				{ id: '333', name: 'Carol' },
			],
			logger,
		});

		expect(result).toEqual([]);
		expect(result).toEqual([]);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('returns [] for an empty users list', () => {
		const logger = makeLogger();
		const result = scanForDuplicateNames({ users: [], logger });

		expect(result).toEqual([]);
		expect(result).toEqual([]);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('returns [] for a single user', () => {
		const logger = makeLogger();
		const result = scanForDuplicateNames({
			users: [{ id: '111', name: 'Matt' }],
			logger,
		});

		expect(result).toEqual([]);
		expect(result).toEqual([]);
		expect(logger.error).not.toHaveBeenCalled();
	});
});

describe('scanForDuplicateNames — duplicates detected', () => {
	it('returns duplicates and logs an error when a case-insensitive duplicate exists', () => {
		const logger = makeLogger();
		const result = scanForDuplicateNames({
			users: [
				{ id: '111', name: 'Matt' },
				{ id: '222', name: 'matt' },
			],
			logger,
		});

		expect(result.length).toBeGreaterThan(0);
		expect(result).toEqual([{ name: 'matt', ids: ['111', '222'] }]);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				duplicates: expect.arrayContaining([
					expect.objectContaining({ name: 'matt', ids: ['111', '222'] }),
				]),
			}),
			expect.stringContaining('duplicate display names'),
		);
	});

	it('detects duplicates that differ only in whitespace padding', () => {
		const logger = makeLogger();
		const result = scanForDuplicateNames({
			users: [
				{ id: '111', name: 'Sarah' },
				{ id: '222', name: '  Sarah  ' },
			],
			logger,
		});

		expect(result.length).toBeGreaterThan(0);
		expect(result).toEqual([{ name: 'sarah', ids: ['111', '222'] }]);
		expect(logger.error).toHaveBeenCalled();
	});

	it('groups 3+ duplicates under one entry', () => {
		const logger = makeLogger();
		const result = scanForDuplicateNames({
			users: [
				{ id: '111', name: 'Matt' },
				{ id: '222', name: 'matt' },
				{ id: '333', name: 'MATT' },
			],
			logger,
		});

		expect(result.length).toBeGreaterThan(0);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ name: 'matt', ids: ['111', '222', '333'] });
	});

	it('reports multiple independent duplicate groups', () => {
		const logger = makeLogger();
		const result = scanForDuplicateNames({
			users: [
				{ id: '111', name: 'Matt' },
				{ id: '222', name: 'matt' },
				{ id: '333', name: 'Sarah' },
				{ id: '444', name: 'SARAH' },
				{ id: '555', name: 'Carol' }, // unique
			],
			logger,
		});

		expect(result.length).toBeGreaterThan(0);
		expect(result).toHaveLength(2);

		const matt = result.find((d) => d.name === 'matt');
		const sarah = result.find((d) => d.name === 'sarah');
		expect(matt?.ids).toEqual(['111', '222']);
		expect(sarah?.ids).toEqual(['333', '444']);
		// Carol is not in the duplicates list.
		expect(result.find((d) => d.name === 'carol')).toBeUndefined();
	});

	it('skips empty/blank names when computing duplicates', () => {
		const logger = makeLogger();
		// Two users with empty names should NOT count as duplicates — that policy
		// is owned by validateConfig's "empty name" warning.
		const result = scanForDuplicateNames({
			users: [
				{ id: '111', name: '' },
				{ id: '222', name: '   ' },
				{ id: '333', name: 'Carol' },
			],
			logger,
		});

		expect(result).toEqual([]);
		expect(result).toEqual([]);
		expect(logger.error).not.toHaveBeenCalled();
	});
});
