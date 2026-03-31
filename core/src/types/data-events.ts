/**
 * Typed payload for `data:changed` events.
 *
 * Emitted by ScopedStore on write, append, and archive operations.
 * Used by outbound webhooks and event-triggered alerts.
 */

export interface DataChangedPayload {
	/** The operation that triggered the event. */
	operation: 'write' | 'append' | 'archive';
	/** App ID that owns the data. */
	appId: string;
	/** User ID the data belongs to (null for shared scope). */
	userId: string | null;
	/** Relative file path within the scoped directory. */
	path: string;
	/** Space ID, if the data belongs to a shared space. */
	spaceId?: string;
}
