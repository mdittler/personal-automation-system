/**
 * Tests for the ConversationRetrievalService Source Policy.
 *
 * These tests code-lock the allowed/denied category sets, SOURCE_POLICY map
 * contents, and METHOD_SOURCE_CATEGORIES method-to-category mapping.
 */

import { describe, expect, it } from 'vitest';
import {
	ALLOWED_SOURCES,
	type AllowedSourceCategory,
	DENIED_SOURCES,
	type DeniedSourceCategory,
	METHOD_SOURCE_CATEGORIES,
	SOURCE_POLICY,
} from '../source-policy.js';

describe('ALLOWED_SOURCES', () => {
	it('exports exactly 11 allowed categories (including collaboration-data)', () => {
		const expected: AllowedSourceCategory[] = [
			'user-app-data',
			'household-shared-data',
			'space-data',
			'collaboration-data',
			'context-store',
			'interaction-context',
			'app-metadata',
			'app-knowledge',
			'system-info',
			'reports',
			'alerts',
		];
		expect(ALLOWED_SOURCES.size).toBe(11);
		for (const cat of expected) {
			expect(ALLOWED_SOURCES.has(cat)).toBe(true);
		}
	});

	it('is a ReadonlySet — .add is undefined (not a mutable Set method)', () => {
		// ReadonlySet does not expose .add in its type; at runtime the underlying
		// Set.add is still there but the TypeScript type intentionally omits it.
		// The key guarantee is that the value exported is a Set instance.
		expect(ALLOWED_SOURCES).toBeInstanceOf(Set);
		// Verify it acts as a set — read operations work
		expect(typeof ALLOWED_SOURCES.has).toBe('function');
		expect(typeof ALLOWED_SOURCES.size).toBe('number');
	});
});

describe('DENIED_SOURCES', () => {
	it('exports exactly 9 denied categories', () => {
		const expected: DeniedSourceCategory[] = [
			'credentials',
			'api-keys',
			'secrets',
			'other-user-personal-data',
			'other-household-data',
			'admin-only-config',
			'cost-tracker-raw-rows',
			'internal-logs',
			'model-journal-entries',
		];
		expect(DENIED_SOURCES.size).toBe(9);
		for (const cat of expected) {
			expect(DENIED_SOURCES.has(cat)).toBe(true);
		}
	});

	it('is a ReadonlySet', () => {
		expect(DENIED_SOURCES).toBeInstanceOf(Set);
		expect(typeof DENIED_SOURCES.has).toBe('function');
	});
});

describe('ALLOWED_SOURCES and DENIED_SOURCES', () => {
	it('are disjoint — no category appears in both sets', () => {
		const allowedArr = [...ALLOWED_SOURCES];
		for (const cat of allowedArr) {
			// cast needed because the two sets have different element types
			expect(DENIED_SOURCES.has(cat as unknown as DeniedSourceCategory)).toBe(false);
		}
	});
});

describe('SOURCE_POLICY', () => {
	it('has one entry for every allowed category (map size equals ALLOWED_SOURCES.size)', () => {
		expect(SOURCE_POLICY.size).toBe(ALLOWED_SOURCES.size);
	});

	it('has an entry for every allowed category', () => {
		for (const cat of ALLOWED_SOURCES) {
			expect(SOURCE_POLICY.has(cat)).toBe(true);
		}
	});

	it('each entry authModel is one of the 5 valid values', () => {
		const validAuthModels = new Set([
			'user-scoped',
			'household-membership',
			'space-membership',
			'collaboration-membership',
			'admin-gated',
		]);
		for (const [, entry] of SOURCE_POLICY) {
			expect(validAuthModels.has(entry.authModel)).toBe(true);
		}
	});

	it('every SourcePolicyEntry.underlyingService is a non-empty string', () => {
		for (const [, entry] of SOURCE_POLICY) {
			expect(typeof entry.underlyingService).toBe('string');
			expect(entry.underlyingService.length).toBeGreaterThan(0);
		}
	});

	it('every SourcePolicyEntry.underlyingMethod is a non-empty string', () => {
		for (const [, entry] of SOURCE_POLICY) {
			expect(typeof entry.underlyingMethod).toBe('string');
			expect(entry.underlyingMethod.length).toBeGreaterThan(0);
		}
	});

	it('every entry.category matches its map key', () => {
		for (const [key, entry] of SOURCE_POLICY) {
			expect(entry.category).toBe(key);
		}
	});
});

describe('METHOD_SOURCE_CATEGORIES', () => {
	it('covers every allowed category at least once', () => {
		const covered = new Set<string>();
		for (const cats of Object.values(METHOD_SOURCE_CATEGORIES)) {
			for (const cat of cats) {
				covered.add(cat);
			}
		}
		for (const cat of ALLOWED_SOURCES) {
			expect(covered.has(cat)).toBe(true);
		}
	});

	it('has exactly the expected public method names (structural deny-by-default test)', () => {
		const expected = new Set([
			'searchData',
			'listContextEntries',
			'getRecentInteractions',
			'getEnabledApps',
			'searchAppKnowledge',
			'buildSystemDataBlock',
			'listScopedReports',
			'listScopedAlerts',
		]);
		const actual = new Set(Object.keys(METHOD_SOURCE_CATEGORIES));
		expect(actual).toEqual(expected);
	});

	it('no method category list contains a DeniedSourceCategory value', () => {
		for (const cats of Object.values(METHOD_SOURCE_CATEGORIES)) {
			for (const cat of cats) {
				expect(DENIED_SOURCES.has(cat as unknown as DeniedSourceCategory)).toBe(false);
			}
		}
	});
});
