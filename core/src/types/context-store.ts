/**
 * Context store types.
 *
 * Two-tier knowledge base: per-user preferences at data/users/<userId>/context/
 * and shared system context at data/system/context/. Per-user entries take
 * priority over system entries when keys collide.
 */

/** A single context store entry. */
export interface ContextEntry {
	/** Topic key (matches the filename, e.g. "food-preferences"). */
	key: string;
	/** The markdown content of the entry. */
	content: string;
	/** When this entry was last modified. */
	lastUpdated: Date;
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
