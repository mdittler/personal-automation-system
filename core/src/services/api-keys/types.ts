/**
 * API key storage types.
 *
 * Keys are stored in data/system/api-keys.yaml.
 * The secret portion is NEVER stored plaintext — only the scrypt hash.
 *
 * Fields intentionally NOT exposed through any public logging surface.
 */

export interface ApiKeyRecord {
	/** Schema version — always 1 for this format. */
	version: 1;
	/** Random hex identifier (public portion of the token). */
	keyId: string;
	/** Owner's Telegram userId. */
	userId: string;
	/** Authorized scopes for this key (e.g. ['data:read', 'data:write']). */
	scopes: string[];
	/** Hash algorithm. */
	algo: 'scrypt';
	/** Random salt, hex-encoded. */
	salt: string;
	/** Derived key from the secret, hex-encoded. NEVER returned to callers. */
	hashedSecret: string;
	/** scrypt tuning parameters. */
	params: {
		N: number;
		r: number;
		p: number;
		keyLen: number;
	};
	/** ISO-8601 creation timestamp. */
	createdAt: string;
	/** ISO-8601 expiry — undefined means no expiry. */
	expiresAt?: string;
	/** ISO-8601 revocation time — undefined means not revoked. */
	revokedAt?: string;
	/** ISO-8601 last-used time (debounced, at-most-once per 60 s). */
	lastUsedAt?: string;
	/** Human-readable label for display. */
	label?: string;
}

/** Shape of api-keys.yaml: array of ApiKeyRecord. */
export interface ApiKeysData {
	version: 1;
	keys: ApiKeyRecord[];
}
