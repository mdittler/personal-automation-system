/**
 * Resolves a per-user boolean setting.
 *
 * Reads raw user overrides (not defaults-merged getAll) so the
 * system-level default can differ from the manifest default without
 * being shadowed by it.
 */

import type { Logger } from 'pino';
import type { AppConfigService } from '../../types/config.js';
import { BOOLEAN_FALSY, BOOLEAN_TRUTHY } from '../config/coerce-user-config.js';

export async function resolveUserBool(
	config: AppConfigService,
	userId: string,
	key: string,
	systemDefault: boolean,
	logger?: Pick<Logger, 'warn'>,
): Promise<boolean> {
	try {
		const overrides = await config.getOverrides(userId);
		if (overrides === null || !(key in overrides)) {
			return systemDefault;
		}

		const raw = overrides[key];
		if (typeof raw === 'boolean') return raw;
		if (typeof raw === 'string') {
			const lower = raw.toLowerCase();
			if (BOOLEAN_TRUTHY.has(lower)) return true;
			if (BOOLEAN_FALSY.has(lower)) return false;
		}

		// Unrecognised value — fail closed
		logger?.warn({ userId, key, raw }, 'resolveUserBool: unrecognised value, using systemDefault');
		return systemDefault;
	} catch (err) {
		logger?.warn({ userId, key, err }, 'resolveUserBool: error reading overrides, using systemDefault');
		return systemDefault;
	}
}
