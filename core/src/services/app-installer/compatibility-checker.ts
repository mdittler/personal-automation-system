/**
 * Compatibility checker for PAS app installation.
 *
 * Validates that an app's declared `pas_core_version` requirement
 * is satisfied by the running CoreServices API version.
 */

import semver from 'semver';

export interface CompatibilityResult {
	compatible: boolean;
	coreVersion: string;
	requiredRange: string;
	message?: string;
}

/**
 * Check whether the running CoreServices version satisfies an app's requirement.
 *
 * @param requiredRange - Semver range from the app manifest (e.g. ">=1.0.0 <2.0.0")
 * @param coreVersion - The running CoreServices version (e.g. "0.1.0")
 * @returns A result indicating compatibility with a human-readable message on failure.
 */
export function checkCompatibility(
	requiredRange: string,
	coreVersion: string,
): CompatibilityResult {
	if (!semver.validRange(requiredRange)) {
		return {
			compatible: false,
			coreVersion,
			requiredRange,
			message: `Invalid semver range "${requiredRange}" in pas_core_version.`,
		};
	}

	if (!semver.valid(coreVersion)) {
		return {
			compatible: false,
			coreVersion,
			requiredRange,
			message: `Invalid CoreServices version "${coreVersion}".`,
		};
	}

	if (semver.satisfies(coreVersion, requiredRange)) {
		return {
			compatible: true,
			coreVersion,
			requiredRange,
		};
	}

	return {
		compatible: false,
		coreVersion,
		requiredRange,
		message: `pas_core_version "${requiredRange}" not satisfied. This PAS instance runs CoreServices v${coreVersion}.`,
	};
}
