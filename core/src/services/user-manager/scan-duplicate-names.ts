/**
 * Boot-time duplicate-name scan.
 *
 * Pure function — takes the configured users + a logger, returns
 * `{ loginByNameAllowed, duplicates }`. Used by compose-runtime to decide
 * whether login-by-name should be enabled.
 *
 * Contract:
 *   - Names are compared via `normalizeDisplayName` (trim + locale-lowercase).
 *   - When ANY normalized name has 2+ user ids, login-by-name is disabled and
 *     a structured Pino error is logged listing every offending group.
 *   - When all normalized names are unique, login-by-name is enabled and no
 *     log is emitted.
 *
 * Why it's pure: tests can call it directly with a stub logger; no I/O.
 * compose-runtime threads the returned flag into `registerAuth` so `auth.ts`
 * guards its name-resolution branch on it.
 *
 * Recovery: when duplicates are flagged, numeric-id login still works (the
 * resolve-then-rate-limit path never falls through to name lookup for
 * digit-only input), so the operator can always reach the GUI to fix
 * `pas.yaml`. After fixing the duplicate, a restart re-scans and re-enables
 * login-by-name.
 */

import type { Logger } from 'pino';
import { normalizeDisplayName } from '../invite/normalize.js';

export interface ScanUser {
	id: string;
	name: string;
}

export interface ScanForDuplicateNamesArgs {
	users: ReadonlyArray<ScanUser>;
	logger: Pick<Logger, 'error'>;
}

export interface DuplicateNameGroup {
	/** The normalized (trim+lowercase) display name shared by 2+ users. */
	name: string;
	/** The Telegram ids of all users whose name normalizes to `name`. */
	ids: string[];
}

export interface ScanForDuplicateNamesResult {
	/**
	 * `false` when at least one duplicate group is found; `true` otherwise.
	 * Consumed by `registerAuth` via AuthOptions to guard the name-resolution
	 * branch of POST /login.
	 */
	loginByNameAllowed: boolean;
	duplicates: DuplicateNameGroup[];
}

export function scanForDuplicateNames(
	args: ScanForDuplicateNamesArgs,
): ScanForDuplicateNamesResult {
	const { users, logger } = args;

	// Map normalized name → list of ids. Empty/blank names are skipped because
	// validateConfig already warns about them and they would otherwise produce
	// a spurious "duplicate" group of any users with blank names.
	const byNormalizedName = new Map<string, string[]>();
	for (const user of users) {
		const norm = normalizeDisplayName(user.name);
		if (norm.length === 0) continue;
		const existing = byNormalizedName.get(norm);
		if (existing) {
			existing.push(user.id);
		} else {
			byNormalizedName.set(norm, [user.id]);
		}
	}

	const duplicates: DuplicateNameGroup[] = [];
	for (const [name, ids] of byNormalizedName) {
		if (ids.length >= 2) {
			duplicates.push({ name, ids });
		}
	}

	if (duplicates.length > 0) {
		logger.error(
			{ duplicates },
			'Boot scan found duplicate display names — login-by-name is disabled until pas.yaml is corrected. Numeric-id login still works.',
		);
		return { loginByNameAllowed: false, duplicates };
	}

	return { loginByNameAllowed: true, duplicates: [] };
}
