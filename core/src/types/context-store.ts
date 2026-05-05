/**
 * Context store types.
 *
 * Two-tier knowledge base: per-user preferences at data/users/<userId>/context/
 * and shared system context at data/system/context/. Per-user entries take
 * priority over system entries when keys collide.
 */

/** All valid semantic kinds for a context entry. */
export const CONTEXT_ENTRY_KINDS = [
	'user-preference',
	'communication-preference',
	'environment-fact',
	'project-convention',
	'household-policy',
	'untyped',
] as const;

export type ContextEntryKind = (typeof CONTEXT_ENTRY_KINDS)[number];

/**
 * Kinds that represent durable, long-lived memory (as opposed to transient
 * or unclassified entries). Used in Chunk C/D to narrow the memory snapshot.
 */
export const DURABLE_KINDS: readonly ContextEntryKind[] = [
	'user-preference',
	'communication-preference',
	'environment-fact',
	'project-convention',
	'household-policy',
];

/** A single context store entry. */
export interface ContextEntry {
	/** Topic key (matches the filename, e.g. "food-preferences"). */
	key: string;
	/** The markdown content of the entry. */
	content: string;
	/** When this entry was last modified. */
	lastUpdated: Date;
	/** Semantic kind of this entry. Defaults to 'untyped' when not set in sidecar. */
	kind: ContextEntryKind;
}

/** Context store service provided to apps via CoreServices. */
export interface ContextStoreService {
	/**
	 * Read a context entry by key (topic filename) from system context.
	 * Returns null if the key doesn't exist.
	 */
	get(key: string): Promise<string | null>;

	/**
	 * Search system context entries by keyword.
	 * Returns matching entries with their keys and content.
	 */
	search(query: string): Promise<ContextEntry[]>;

	/**
	 * Search both per-user and system context entries by keyword.
	 * Per-user entries take priority over system entries with the same key.
	 */
	searchForUser(query: string, userId: string): Promise<ContextEntry[]>;

	/**
	 * Read a context entry by key, checking user context first, then system.
	 * Returns null if the key doesn't exist in either.
	 */
	getForUser(key: string, userId: string): Promise<string | null>;

	/**
	 * List all context entries for a user (user-scoped only, not system).
	 */
	listForUser(userId: string): Promise<ContextEntry[]>;

	/**
	 * Save a context entry for a user.
	 * Creates the file if it doesn't exist, overwrites if it does.
	 */
	save(userId: string, key: string, content: string): Promise<void>;

	/**
	 * Remove a context entry for a user.
	 */
	remove(userId: string, key: string): Promise<void>;
}
