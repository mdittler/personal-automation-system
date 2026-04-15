/**
 * Typed payload for `data:changed` events.
 *
 * Emitted by ScopedStore on write, append, and archive operations.
 * Used by outbound webhooks and event-triggered alerts.
 */

import type { SpaceKind } from './spaces.js';

export interface DataChangedPayload {
	/** The operation that triggered the event. */
	operation: 'write' | 'append' | 'archive';
	/** App ID that owns the data. */
	appId: string;
	/** User ID the data belongs to (null for shared scope). */
	userId: string | null;
	/**
	 * Scope-relative path within the app's scoped store
	 * (e.g. `grocery.md` under a food `forUser` store).
	 * Use the `householdId` / `spaceKind` / `collaborationId` fields on the
	 * payload for the authorization boundary — do not parse this path.
	 */
	path: string;
	/** Space ID, if the data belongs to a shared space. */
	spaceId?: string;
	/** Household ID for this data; null only for collaboration + system scopes. */
	householdId: string | null;
	/** Space kind discriminant; null for non-space scopes. */
	spaceKind: SpaceKind | null;
	/** Collaboration space ID when scope === 'collaboration'; null otherwise. */
	collaborationId: string | null;
	/**
	 * The scope argument passed to forShared().
	 * For telemetry/logging ONLY — not used for authorization.
	 */
	sharedSelector: string | null;
}
