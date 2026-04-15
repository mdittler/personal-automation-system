/**
 * Path resolution and traversal protection for the data store.
 *
 * Resolves relative paths to absolute paths within the data directory,
 * and rejects any path that would escape the expected scope.
 */

import { posix, relative, resolve, sep } from 'node:path';
import type { ManifestDataScope } from '../../types/manifest.js';
import { HouseholdBoundaryError } from '../household/index.js';

/**
 * Resolve a relative path within a base directory.
 * Throws if the resolved path escapes the base directory (path traversal).
 *
 * @param baseDir - The root directory for this scope (e.g., data/users/123/echo/)
 * @param relativePath - The user-provided relative path
 * @returns The resolved absolute path
 */
export function resolveScopedPath(baseDir: string, relativePath: string): string {
	const resolvedBase = resolve(baseDir);
	const resolvedPath = resolve(resolvedBase, relativePath);

	// Normalize for comparison: the resolved path must start with the base dir
	const rel = relative(resolvedBase, resolvedPath);

	// If the relative path starts with '..' or is absolute, it escapes the scope
	if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
		throw new PathTraversalError(relativePath, baseDir);
	}

	// Household boundary check: if the base dir is rooted under a household subtree,
	// verify the resolved path has not escaped that subtree.
	const householdMatch = /[/\\]households[/\\]([^/\\]+)[/\\]/.exec(resolvedBase);
	if (householdMatch) {
		const hhId = householdMatch[1] ?? null;
		// Find the households/<hhId>/ prefix in the base path (trim trailing sep from matched group)
		const hhRoot = resolvedBase.slice(0, resolvedBase.indexOf(householdMatch[0]) + householdMatch[0].length - 1);
		const hhRel = relative(hhRoot, resolvedPath);
		if (hhRel.startsWith('..') || hhRel.startsWith(sep) || hhRel.startsWith('/')) {
			throw new HouseholdBoundaryError(
				hhId,
				null,
				`Path "${relativePath}" escapes household subtree for household "${hhId ?? 'unknown'}"`,
			);
		}
	}

	return resolvedPath;
}

/**
 * Error thrown when a path traversal attempt is detected.
 */
export class PathTraversalError extends Error {
	constructor(
		public readonly attemptedPath: string,
		public readonly baseDir: string,
	) {
		super(`Path traversal detected: "${attemptedPath}" escapes base directory "${baseDir}"`);
		this.name = 'PathTraversalError';
	}
}

/**
 * Error thrown when an app attempts an operation outside its declared data scopes.
 */
export class ScopeViolationError extends Error {
	constructor(
		public readonly attemptedPath: string,
		public readonly operation: string,
		public readonly appId: string,
	) {
		super(
			`Scope violation: app "${appId}" attempted ${operation} on "${attemptedPath}" outside declared scopes`,
		);
		this.name = 'ScopeViolationError';
	}
}

/**
 * Normalize a path using virtual POSIX rules (no OS cwd resolution).
 * Replaces backslashes, collapses . and .. segments, strips leading ./.
 */
function normalizePosix(p: string): string {
	// Reject null bytes — they can interfere with string comparison
	if (p.includes('\0')) return '..'; // forces rejection by the caller's startsWith('..') check
	const normalized = posix.normalize(p.replace(/\\/g, '/'));
	return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

/**
 * Find the first declared scope that matches a given path.
 *
 * @param path - The file path to check (relative to app data root)
 * @param scopes - Declared scopes from the app's manifest
 * @returns The matching scope (with access level), or undefined if no match
 */
export function findMatchingScope(
	path: string,
	scopes: ManifestDataScope[],
): ManifestDataScope | undefined {
	if (scopes.length === 0) return undefined;

	const normalizedPath = normalizePosix(path);

	// Reject paths that escape upward or are absolute
	if (normalizedPath.startsWith('..') || normalizedPath.startsWith('/')) return undefined;

	return scopes.find((scope) => {
		const normalizedScope = normalizePosix(scope.path);
		// Re-append trailing / if the original scope had it (directory semantics)
		const scopeDir =
			scope.path.endsWith('/') && !normalizedScope.endsWith('/')
				? normalizedScope + '/'
				: normalizedScope;

		// Exact file match
		if (normalizedPath === scopeDir) return true;

		// Directory scope: path is under the scope directory
		if (scopeDir.endsWith('/')) {
			if (normalizedPath.startsWith(scopeDir)) return true;
			if (normalizedPath === scopeDir.slice(0, -1)) return true;
		}

		return false;
	});
}

/**
 * Check for scope paths that incorrectly use the {appId}/ prefix.
 * Returns human-readable warning strings for each offending path.
 */
export function warnScopePathPrefix(appId: string, scopes: ManifestDataScope[]): string[] {
	const prefix = `${appId}/`;
	return scopes
		.filter((s) => s.path.startsWith(prefix))
		.map(
			(s) =>
				`Scope path "${s.path}" starts with "${prefix}" — paths should be relative to the app data directory, which is already rooted at <dataDir>/<userId>/${appId}/.`,
		);
}
