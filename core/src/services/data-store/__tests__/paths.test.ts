import { describe, expect, it } from 'vitest';
import type { ManifestDataScope } from '../../../types/manifest.js';
import { ScopeViolationError, findMatchingScope, warnScopePathPrefix } from '../paths.js';

describe('findMatchingScope', () => {
	it('matches an exact file path', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'log.md', access: 'read-write', description: 'Log' },
		];
		const match = findMatchingScope('log.md', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('matches a file within a directory scope', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
		];
		const match = findMatchingScope('daily-notes/2026-04-11.md', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('returns undefined for a path outside all scopes', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'notes/', access: 'read-write', description: 'Notes' },
		];
		expect(findMatchingScope('test.md', scopes)).toBeUndefined();
	});

	it('returns undefined for empty scopes array', () => {
		expect(findMatchingScope('anything.md', [])).toBeUndefined();
	});

	it('matches the directory itself for list operations', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'daily-notes/', access: 'read-write', description: 'Notes' },
		];
		// list('daily-notes') passes 'daily-notes' (no trailing slash)
		const match = findMatchingScope('daily-notes', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('normalizes backslashes to forward slashes', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'sub/dir/', access: 'read-write', description: 'Sub' },
		];
		const match = findMatchingScope('sub\\dir\\file.md', scopes);
		expect(match).toEqual(scopes[0]);
	});

	it('does not match a sibling directory with a shared prefix', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'notes/', access: 'read-write', description: 'Notes' },
		];
		// 'notes-archive/old.md' should NOT match 'notes/' scope
		expect(findMatchingScope('notes-archive/old.md', scopes)).toBeUndefined();
	});

	it('matches first matching scope when multiple scopes declared', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'history.json', access: 'read-write', description: 'History' },
			{ path: 'daily-notes/', access: 'read', description: 'Notes' },
		];
		expect(findMatchingScope('history.json', scopes)).toEqual(scopes[0]);
		expect(findMatchingScope('daily-notes/today.md', scopes)).toEqual(scopes[1]);
	});

	it('rejects traversal out of directory scope via ..', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'grocery/', access: 'read-write', description: 'Grocery' },
		];
		expect(findMatchingScope('grocery/../pantry.yaml', scopes)).toBeUndefined();
	});

	it('rejects traversal with backslashes', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'grocery/', access: 'read-write', description: 'Grocery' },
		];
		expect(findMatchingScope('grocery\\..\\pantry.yaml', scopes)).toBeUndefined();
	});

	it('resolves . segments and still matches', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'grocery/', access: 'read-write', description: 'Grocery' },
		];
		expect(findMatchingScope('grocery/./list.md', scopes)).toEqual(scopes[0]);
	});

	it('resolves nested .. that stays within scope', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'grocery/', access: 'read-write', description: 'Grocery' },
		];
		expect(findMatchingScope('grocery/sub/../list.md', scopes)).toEqual(scopes[0]);
	});

	it('rejects double traversal escaping scope entirely', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'grocery/', access: 'read-write', description: 'Grocery' },
		];
		expect(findMatchingScope('grocery/../../secret.md', scopes)).toBeUndefined();
	});

	it('rejects traversal from different scope', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'logs/', access: 'read-write', description: 'Logs' },
		];
		expect(findMatchingScope('logs/../secret.md', scopes)).toBeUndefined();
	});

	it('exact file scope with normalized path still matches', () => {
		const scopes: ManifestDataScope[] = [
			{ path: 'grocery/items.yaml', access: 'read-write', description: 'Items' },
		];
		expect(findMatchingScope('grocery/items.yaml', scopes)).toEqual(scopes[0]);
	});
});

describe('ScopeViolationError', () => {
	it('has correct name and message', () => {
		const err = new ScopeViolationError('secret.md', 'write', 'echo');
		expect(err.name).toBe('ScopeViolationError');
		expect(err.message).toContain('echo');
		expect(err.message).toContain('secret.md');
		expect(err.message).toContain('write');
		expect(err.attemptedPath).toBe('secret.md');
		expect(err.operation).toBe('write');
		expect(err.appId).toBe('echo');
	});
});

describe('warnScopePathPrefix', () => {
	it('returns warnings for paths starting with appId/', () => {
		const warnings = warnScopePathPrefix('echo', [
			{ path: 'echo/log.md', access: 'read-write', description: 'Log' },
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('echo/log.md');
	});

	it('returns empty array for correctly scoped paths', () => {
		const warnings = warnScopePathPrefix('echo', [
			{ path: 'log.md', access: 'read-write', description: 'Log' },
		]);
		expect(warnings).toHaveLength(0);
	});

	it('does not warn for paths that merely contain the appId', () => {
		const warnings = warnScopePathPrefix('notes', [
			{ path: 'release-notes/', access: 'read-write', description: 'Release notes' },
		]);
		expect(warnings).toHaveLength(0);
	});

	it('handles empty scopes array', () => {
		expect(warnScopePathPrefix('echo', [])).toHaveLength(0);
	});

	it('warns for multiple offending paths', () => {
		const warnings = warnScopePathPrefix('chatbot', [
			{ path: 'chatbot/history.json', access: 'read-write', description: 'History' },
			{ path: 'chatbot/daily-notes/', access: 'read-write', description: 'Notes' },
		]);
		expect(warnings).toHaveLength(2);
	});
});
