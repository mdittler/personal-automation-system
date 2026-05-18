/**
 * Resolve the auto_detect_pas user-config setting.
 *
 * Honors the manifest-declared default (`true`) for unset / undefined / null
 * values, missing config service, throws, and unexpected value shapes.
 * Unexpected outcomes (throws or unrecognized values) are logged via the
 * optional logger so the operator can spot misconfigured config files.
 *
 * Explicit `false` / `"false"` from the user is preserved — opt-outs are
 * never silently flipped back to `true`.
 */

import type { Logger } from 'pino';
import type { AppConfigService } from '../../types/config.js';
import { CONVERSATION_USER_CONFIG } from './manifest.js';

/** Derive the manifest default so this constant can never drift from the source of truth. */
const MANIFEST_DEFAULT: boolean = (() => {
	const entry = CONVERSATION_USER_CONFIG.find((e) => e.key === 'auto_detect_pas');
	if (!entry || typeof entry.default !== 'boolean') {
		throw new Error(
			'auto_detect_pas manifest entry missing or has non-boolean default — refusing to silently fall back',
		);
	}
	return entry.default;
})();

export async function getAutoDetectSetting(
	userId: string,
	deps: { config?: AppConfigService; logger?: Pick<Logger, 'warn'> },
): Promise<boolean> {
	if (!deps.config) return MANIFEST_DEFAULT;
	try {
		const all = await deps.config.getAll(userId);
		const value = all.auto_detect_pas;
		if (value === undefined || value === null) return MANIFEST_DEFAULT;
		if (value === true || value === 'true') return true;
		if (value === false || value === 'false') return false;
		deps.logger?.warn(
			{ userId, value },
			'auto_detect_pas had unexpected value; using manifest default',
		);
		return MANIFEST_DEFAULT;
	} catch (err) {
		deps.logger?.warn(
			{ userId, err: String(err) },
			'auto_detect_pas resolver threw; using manifest default',
		);
		return MANIFEST_DEFAULT;
	}
}
