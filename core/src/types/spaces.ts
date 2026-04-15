/**
 * Shared data space types.
 *
 * Spaces provide named shared data areas with defined membership.
 * Users can share data (e.g., grocery lists, project notes) with
 * specific people rather than all registered users.
 */

/**
 * Discriminates between household-scoped spaces and cross-household collaboration spaces.
 * - 'household': tied to a single household; householdId is required.
 * - 'collaboration': cross-household or standalone; householdId is absent.
 */
export type SpaceKind = 'household' | 'collaboration';

/** A named shared data space with defined membership. */
export interface SpaceDefinition {
	/** Unique space identifier (lowercase, alphanumeric + hyphens). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** Optional description of the space's purpose. */
	description: string;
	/** Telegram user IDs of space members. */
	members: string[];
	/** Telegram user ID of the space creator. */
	createdBy: string;
	/** ISO 8601 timestamp of creation. */
	createdAt: string;
	/** Whether this space is household-scoped or a cross-household collaboration. */
	kind: SpaceKind;
	/**
	 * Household this space belongs to.
	 * REQUIRED iff kind === 'household'; absent iff kind === 'collaboration'.
	 */
	householdId?: string;
}

/** Valid space ID pattern: starts with lowercase letter, then lowercase alphanumeric + hyphens. */
export const SPACE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Maximum length for space IDs. */
export const MAX_SPACE_ID_LENGTH = 50;

/** Maximum length for space display names. */
export const MAX_SPACE_NAME_LENGTH = 100;

/** Maximum number of spaces in the system. */
export const MAX_SPACES = 20;

/** Maximum members per space. */
export const MAX_MEMBERS_PER_SPACE = 50;
