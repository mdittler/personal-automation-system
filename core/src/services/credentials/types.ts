/**
 * Credential storage types.
 *
 * Credentials are stored separately from RegisteredUser (in data/system/credentials.yaml)
 * so that the pas.yaml config-writer path never touches secrets.
 *
 * Fields are intentionally NOT exported through any public logging surface.
 */

export interface StoredCredential {
	/** Schema version — always 1 for this format. */
	version: 1;
	/** Hash algorithm. */
	algo: 'scrypt';
	/** Random salt, hex-encoded. */
	salt: string;
	/** Derived key, hex-encoded. */
	hash: string;
	/** scrypt tuning parameters. */
	params: {
		/** CPU/memory cost factor (N). */
		N: number;
		/** Block size (r). */
		r: number;
		/** Parallelization factor (p). */
		p: number;
		/** Key length in bytes. */
		keyLen: number;
	};
	/**
	 * Monotonically increasing session version.
	 * Starts at 1 on first setPassword. Bumped by setPassword and incrementSessionVersion.
	 * GUI session cookies carry the version they were issued at; if the stored version is
	 * higher than the cookie's version the session is invalid.
	 */
	sessionVersion: number;
	/** ISO-8601 timestamp of last update. */
	updatedAt: string;
}

/** Shape of credentials.yaml: { [userId]: StoredCredential } */
export type CredentialsData = Record<string, StoredCredential>;
