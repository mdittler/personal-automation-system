/**
 * Path resolution and traversal protection for the data store.
 *
 * Resolves relative paths to absolute paths within the data directory,
 * and rejects any path that would escape the expected scope.
 */

import { relative, resolve, sep } from 'node:path';

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

	return resolvedPath;
}

/**
 * Check if a path is within a list of declared scopes.
 *
 * @param path - The file path to check (relative to app root in data dir)
 * @param declaredScopes - Paths declared in the app's manifest data scopes
 * @returns true if the path falls within any declared scope
 */
export function isWithinDeclaredScopes(path: string, declaredScopes: string[]): boolean {
	if (declaredScopes.length === 0) return false;

	const normalizedPath = path.replace(/\\/g, '/');

	return declaredScopes.some((scope) => {
		const normalizedScope = scope.replace(/\\/g, '/');

		// Exact file match
		if (normalizedPath === normalizedScope) return true;

		// Directory scope: path is under the scope directory
		if (normalizedScope.endsWith('/')) {
			return normalizedPath.startsWith(normalizedScope);
		}

		// File scope: check if the path matches the specific file
		return normalizedPath === normalizedScope;
	});
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
