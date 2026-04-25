/**
 * Build a concise user profile context string for system prompt injection.
 *
 * Uses MessageContext (spaceId/spaceName) and appMetadata.getEnabledApps().
 * Does NOT call SpaceService or UserManager directly.
 * Returns empty string when no useful context is available.
 */

import type { AppMetadataService } from '../../types/app-metadata.js';
import type { AppLogger } from '../../types/app-module.js';
import type { MessageContext } from '../../types/telegram.js';
import { sanitizeInput } from '../prompt-assembly/index.js';

export async function buildUserContext(
	ctx: MessageContext,
	deps: { appMetadata?: AppMetadataService; logger?: AppLogger },
): Promise<string> {
	const parts: string[] = [];

	if (ctx.spaceName) {
		parts.push(`User is a member of the "${sanitizeInput(ctx.spaceName, 200)}" household.`);
	}

	try {
		if (deps.appMetadata) {
			const apps = await deps.appMetadata.getEnabledApps(ctx.userId);
			if (apps.length > 0) {
				parts.push(`Active apps: ${apps.map((a) => sanitizeInput(a.name, 100)).join(', ')}.`);
			}
		}
	} catch (error) {
		// graceful — missing app list is not fatal
		deps.logger?.warn('buildUserContext: failed to enumerate enabled apps: %s', error);
	}

	return parts.join(' ');
}
