/**
 * Target-user and target-household authorization helpers.
 *
 * Used by message-dispatch and telegram-send routes to ensure a per-user API
 * key can only dispatch messages / send Telegrams on behalf of its own userId.
 *
 * Platform-admin and platform-system actors bypass all target checks.
 */

import type { AuthenticatedActor } from '../../types/auth-actor.js';

/**
 * Returns true when the actor is allowed to act on behalf of targetUserId.
 *
 * Bypassed for: isPlatformAdmin or authMethod === 'legacy-api-token'.
 */
export function assertCallerIsTargetUser(
	actor: AuthenticatedActor,
	targetUserId: string,
): boolean {
	if (actor.isPlatformAdmin || actor.authMethod === 'legacy-api-token') return true;
	return actor.userId === targetUserId;
}

/**
 * Returns true when the actor belongs to targetHouseholdId.
 *
 * Bypassed for: isPlatformAdmin or authMethod === 'legacy-api-token'.
 */
export function assertCallerInTargetHousehold(
	actor: AuthenticatedActor,
	targetHouseholdId: string,
): boolean {
	if (actor.isPlatformAdmin || actor.authMethod === 'legacy-api-token') return true;
	return actor.householdId === targetHouseholdId;
}
