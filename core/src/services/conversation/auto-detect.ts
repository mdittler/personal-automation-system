/**
 * Resolve the auto_detect_pas user-config setting.
 *
 * Returns false on any error — graceful degradation so a missing/throwing
 * config service does not break message handling.
 */

import type { AppConfigService } from '../../types/config.js';

export async function getAutoDetectSetting(
	userId: string,
	deps: { config?: AppConfigService },
): Promise<boolean> {
	try {
		if (!deps.config) return false;
		const all = await deps.config.getAll(userId);
		const value = all.auto_detect_pas;
		return value === true || value === 'true';
	} catch {
		return false;
	}
}
