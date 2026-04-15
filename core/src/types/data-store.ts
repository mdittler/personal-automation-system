/**
 * Data store types.
 *
 * The data store mediates all file-based data access. Apps never
 * read or write files directly — everything goes through these interfaces.
 * Data is organized into user-scoped, shared, and system scopes.
 */

/** Operations available on a scoped data store (per-user or shared). */
export interface ScopedDataStore {
	/** Read a file's content. Returns empty string if file doesn't exist. */
	read(path: string): Promise<string>;

	/** Write content to a file. Creates the file if it doesn't exist. Atomic write. */
	write(path: string, content: string): Promise<void>;

	/** Append content to the end of a file. Creates the file if it doesn't exist. */
	append(path: string, content: string, options?: { frontmatter?: string }): Promise<void>;

	/** Check if a file exists. */
	exists(path: string): Promise<boolean>;

	/** List filenames in a directory. */
	list(directory: string): Promise<string[]>;

	/**
	 * Archive a file's content. Moves content to a dated archive,
	 * preserving history. The archiving strategy is app-determined.
	 */
	archive(path: string): Promise<void>;
}

/** Alias for clarity — user and shared stores have identical interfaces. */
export type UserDataStore = ScopedDataStore;
export type SharedDataStore = ScopedDataStore;

/** Data store service provided to apps via CoreServices. */
export interface DataStoreService {
	/**
	 * Get a store scoped to a specific user's data.
	 * Resolves to: data/users/<userId>/<appId>/
	 * @param userId - Must equal the current request context userId unless using SYSTEM_BYPASS_TOKEN.
	 *                 Mismatches throw UserBoundaryError.
	 */
	forUser(userId: string): UserDataStore;

	/**
	 * Get a store scoped to shared data.
	 * Resolves to: data/users/shared/<appId>/
	 */
	forShared(scope: string): SharedDataStore;

	/**
	 * Get a store scoped to a named shared space.
	 * Resolves to: data/spaces/<spaceId>/<appId>/
	 * Throws SpaceMembershipError if the user is not a member.
	 */
	forSpace(spaceId: string, userId: string): ScopedDataStore;
}

/** Entry in the data store change log. */
export interface ChangeLogEntry {
	/** When the operation occurred (ISO 8601 string in JSONL). */
	timestamp: string;
	/** What operation was performed. */
	operation: 'read' | 'write' | 'append' | 'archive';
	/** The file path that was affected. */
	path: string;
	/** Which app performed the operation. */
	appId: string;
	/** Which user's data was affected ('system' for shared/system). */
	userId: string;
	/** Space ID if the operation was within a shared space. */
	spaceId?: string;
}
