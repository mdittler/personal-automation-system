/**
 * Resource-kind authorization gate.
 *
 * Enforces the D5b-0 access contract:
 *   - system   → platform-admin / platform-system only
 *   - user     → self only (actor.userId === targetUserId)
 *   - shared   → same household (actor.householdId === targetHouseholdId)
 *   - space    → space membership (spaceService.isMember(spaceId, actor.userId))
 *
 * Platform-admin and platform-system actors bypass all resource checks.
 */

import type { SpaceService } from '../../services/spaces/index.js';
import type { AuthenticatedActor } from '../../types/auth-actor.js';

export type ResourceKind = 'user' | 'shared' | 'space' | 'system';

export interface ResourceAccessOpts {
	kind: ResourceKind;
	/** Required for kind='user' — the target userId in the path. */
	userId?: string;
	/** Required for kind='shared' — the target householdId in the path. */
	householdId?: string;
	/** Required for kind='space' — the spaceId being accessed. */
	spaceId?: string;
}

/**
 * Returns true when the actor is authorized to access the described resource.
 *
 * @param actor - The authenticated actor from request.actor.
 * @param opts  - Resource descriptor.
 * @param spaceService - Required when opts.kind === 'space'.
 */
export function authorizeResourceAccess(
	actor: AuthenticatedActor,
	opts: ResourceAccessOpts,
	spaceService?: Pick<SpaceService, 'isMember'>,
): boolean {
	// Platform-admin and platform-system bypass all resource checks.
	if (actor.isPlatformAdmin || actor.authMethod === 'legacy-api-token') return true;

	switch (opts.kind) {
		case 'system':
			return false;

		case 'user':
			return actor.userId === opts.userId;

		case 'shared':
			return actor.householdId === opts.householdId;

		case 'space':
			if (!opts.spaceId || !spaceService) return false;
			return spaceService.isMember(opts.spaceId, actor.userId);
	}
}
