/**
 * Household types.
 *
 * A household is a top-level tenant boundary. Each registered user
 * belongs to exactly one household. Household admins can manage setup,
 * invites, and app enablement — but cannot read other users' private data.
 */

export interface Household {
	/** Unique household identifier (SAFE_SEGMENT pattern: ^[a-zA-Z0-9_-]+$). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** ISO 8601 timestamp of creation. */
	createdAt: string;
	/** User ID of the user who created the household. */
	createdBy: string;
	/**
	 * User IDs of household administrators.
	 * Admins can manage setup, invites, and app enablement
	 * but cannot read other household members' private data.
	 */
	adminUserIds: string[];
}
