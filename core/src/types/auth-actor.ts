/**
 * AuthenticatedActor — the resolved caller identity for every authenticated request.
 *
 * Populated by the GUI auth guard (D5b-3) and the API auth hook (D5b-6).
 * Every field except scopes/sessionVersion is ALWAYS present after authentication.
 *
 * The actor is rehydrated from UserManager + HouseholdService on EVERY request.
 * The cookie/token is NOT the authority — it is only a carrier for {userId, sessionVersion}.
 * This means isAdmin revocations, household moves, and session invalidations are
 * reflected immediately on the next request with no cache staleness.
 */
export interface AuthenticatedActor {
	/**
	 * Telegram user id of the authenticated caller, or '__platform_system__' for
	 * the legacy API token actor.
	 */
	userId: string;

	/**
	 * Household the caller currently belongs to, resolved at request time from
	 * HouseholdService. '__platform__' for the platform-system actor.
	 */
	householdId: string;

	/**
	 * True if RegisteredUser.isAdmin === true (resolved at request time, not from cookie).
	 * Platform admins have unrestricted access across all households.
	 */
	isPlatformAdmin: boolean;

	/**
	 * True if Household.adminUserIds includes userId (resolved at request time).
	 * Reserved for future phases — no D5b route consumes this flag.
	 */
	isHouseholdAdmin: boolean;

	/**
	 * How this request was authenticated — informational + audit use only.
	 * Do NOT use authMethod for access-control decisions; use isPlatformAdmin / scopes.
	 */
	authMethod: 'gui-password' | 'legacy-gui-token' | 'api-key' | 'legacy-api-token';

	/**
	 * API scopes this actor is permitted to exercise.
	 * Present for 'api-key' (scopes from the key record) and 'legacy-api-token' (['*']).
	 * Absent for GUI actors (GUI routes are gated by role, not scope).
	 */
	scopes?: string[];

	/**
	 * Session version from CredentialService at the time the cookie was issued.
	 * The GUI guard compares this against the server's current sessionVersion to
	 * detect invalidation (password change, explicit logout of all sessions).
	 * Absent for API actors.
	 */
	sessionVersion?: number;
}

/**
 * Well-known userId for the platform-system actor produced by the legacy API_TOKEN.
 * Never stored in credentials.yaml — this is a synthetic actor only.
 */
export const PLATFORM_SYSTEM_USER_ID = '__platform_system__' as const;

/**
 * Well-known householdId for the platform-system actor.
 * Resolves across all households — not bound to any single tenant.
 */
export const PLATFORM_SYSTEM_HOUSEHOLD_ID = '__platform__' as const;
