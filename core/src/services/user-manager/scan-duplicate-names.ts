/**
 * Boot-time duplicate-name scan. Returns the duplicate groups (empty when
 * none), logging a structured Pino error when any are found. Names are
 * compared via `normalizeDisplayName`; blank names are skipped (validateConfig
 * already warns about them).
 *
 * Recovery: when duplicates are flagged, callers should disable login-by-name
 * but keep numeric-id login working so the operator can fix `pas.yaml`.
 */

import type { Logger } from 'pino';
import { normalizeDisplayName } from '../invite/normalize.js';

export interface ScanUser {
	id: string;
	name: string;
}

export interface DuplicateNameGroup {
	name: string;
	ids: string[];
}

export function scanForDuplicateNames(args: {
	users: ReadonlyArray<ScanUser>;
	logger: Pick<Logger, 'error'>;
}): DuplicateNameGroup[] {
	const byNormalizedName = new Map<string, string[]>();
	for (const user of args.users) {
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
		if (ids.length >= 2) duplicates.push({ name, ids });
	}

	if (duplicates.length > 0) {
		args.logger.error(
			{ duplicates },
			'Boot scan found duplicate display names — login-by-name should be disabled until pas.yaml is corrected. Numeric-id login still works.',
		);
	}

	return duplicates;
}
