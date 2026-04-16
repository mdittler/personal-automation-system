/**
 * resolveViewerScope — D5b-5.
 *
 * Helper that derives the effective scope constraints from an authenticated actor.
 * Every data-bearing route should call this and apply the returned constraints
 * instead of duplicating the resource-kind rules inline.
 */

import type { AuthenticatedActor } from '../../types/auth-actor.js';

export interface ViewerScope {
	/** The actor's own userId. */
	effectiveUserId: string;
	/** The household the actor belongs to. */
	effectiveHouseholdId: string;
	/**
	 * True when the actor has platform-wide visibility (platform-admin or platform-system).
	 * When true, callers MUST NOT apply per-user or per-household filters.
	 */
	isUnrestricted: boolean;
}

/** Derive the effective data visibility scope from a validated actor. */
export function resolveViewerScope(actor: AuthenticatedActor): ViewerScope {
	return {
		effectiveUserId: actor.userId,
		effectiveHouseholdId: actor.householdId,
		isUnrestricted: actor.isPlatformAdmin,
	};
}

/**
 * Returns true when the report/alert is visible to the given actor.
 * A report/alert is visible when:
 *   - the actor is a platform admin (sees all), OR
 *   - the actor's userId appears in the delivery list.
 */
export function isDeliveryVisible(
	delivery: string[],
	actor: AuthenticatedActor,
): boolean {
	if (actor.isPlatformAdmin) return true;
	return delivery.includes(actor.userId);
}
