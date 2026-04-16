/**
 * API key service.
 *
 * Manages per-user API keys used for Bearer-token authentication on the REST API.
 *
 * Storage: data/system/api-keys.yaml
 * A single file-level mutex serializes ALL writes (same rationale as credentials.yaml).
 *
 * Token format: `pas_<keyId>_<rawSecret>`
 *   - keyId: 16 random bytes, hex-encoded (32 chars) — stored in the file
 *   - rawSecret: 32 random bytes, hex-encoded (64 chars) — NEVER stored; hashed with scrypt
 *
 * NEVER log or return the rawSecret or hashedSecret from public methods.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import { withFileLock } from '../../utils/file-mutex.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';
import type { ApiKeyRecord, ApiKeysData } from './types.js';

export type { ApiKeyRecord } from './types.js';

/** scrypt parameters — lighter than password hashing (API calls are frequent). */
const SCRYPT_PARAMS = { N: 4096, r: 8, p: 1, keyLen: 32 } as const;

/** Debounce window for lastUsedAt writes (ms). */
const LAST_USED_DEBOUNCE_MS = 60_000;

function scryptAsync(
	secret: string,
	salt: string,
	keyLen: number,
	options: { N?: number; r?: number; p?: number },
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(secret, salt, keyLen, options, (err, key) => {
			if (err) reject(err);
			else resolve(key);
		});
	});
}

export interface ApiKeyServiceOptions {
	dataDir: string;
	logger?: Logger;
}

export interface CreateKeyOptions {
	scopes: string[];
	expiresAt?: string;
	label?: string;
}

export class ApiKeyService {
	private readonly keysPath: string;
	private readonly logger?: Logger;
	/** In-memory debounce map: keyId → timestamp of last write. */
	private readonly lastUsedWriteTimes = new Map<string, number>();

	constructor(options: ApiKeyServiceOptions) {
		this.keysPath = join(options.dataDir, 'system', 'api-keys.yaml');
		this.logger = options.logger;
	}

	/**
	 * Create a new API key for a user.
	 * Returns { keyId, fullToken } — fullToken is the ONLY time the secret is exposed.
	 */
	async createKey(userId: string, opts: CreateKeyOptions): Promise<{ keyId: string; fullToken: string }> {
		const keyId = randomBytes(16).toString('hex');
		const rawSecret = randomBytes(32).toString('hex');
		const salt = randomBytes(16).toString('hex');

		const key = await scryptAsync(rawSecret, salt, SCRYPT_PARAMS.keyLen, {
			N: SCRYPT_PARAMS.N,
			r: SCRYPT_PARAMS.r,
			p: SCRYPT_PARAMS.p,
		});

		const record: ApiKeyRecord = {
			version: 1,
			keyId,
			userId,
			scopes: opts.scopes,
			algo: 'scrypt',
			salt,
			hashedSecret: key.toString('hex'),
			params: SCRYPT_PARAMS,
			createdAt: new Date().toISOString(),
			expiresAt: opts.expiresAt,
			label: opts.label,
		};

		await withFileLock(this.keysPath, async () => {
			const data = await this.loadUnsafe();
			data.keys.push(record);
			await this.saveUnsafe(data);
		});

		return { keyId, fullToken: `pas_${keyId}_${rawSecret}` };
	}

	/**
	 * Verify a full token and return the ApiKeyRecord if valid, null otherwise.
	 * Also debounce-updates lastUsedAt (fire-and-forget, never blocks).
	 *
	 * Validates: token format, keyId exists, secret matches, not expired, not revoked.
	 */
	async verifyAndConsume(fullToken: string): Promise<ApiKeyRecord | null> {
		const parsed = this.parseToken(fullToken);
		if (!parsed) return null;

		const { keyId, rawSecret } = parsed;

		let found: ApiKeyRecord | null = null;
		await withFileLock(this.keysPath, async () => {
			const data = await this.loadUnsafe();
			const record = data.keys.find((k) => k.keyId === keyId);
			if (!record) return;

			// Check revoked
			if (record.revokedAt) return;

			// Check expired
			if (record.expiresAt && new Date(record.expiresAt) <= new Date()) return;

			// Verify secret
			const { N, r, p, keyLen } = record.params;
			let candidate: Buffer;
			try {
				candidate = await scryptAsync(rawSecret, record.salt, keyLen, { N, r, p });
			} catch {
				return;
			}

			const expected = Buffer.from(record.hashedSecret, 'hex');
			if (candidate.length !== expected.length) return;
			if (!timingSafeEqual(candidate, expected)) return;

			found = record;
		});

		if (found) {
			// Fire-and-forget debounced lastUsedAt update
			this.debounceLastUsed(keyId);
		}

		return found;
	}

	/**
	 * List keys for a user, redacting secret fields.
	 */
	async listKeysForUser(
		userId: string,
	): Promise<Omit<ApiKeyRecord, 'hashedSecret' | 'salt'>[]> {
		const data = await this.loadUnsafe();
		return data.keys
			.filter((k) => k.userId === userId)
			.map(({ hashedSecret: _h, salt: _s, ...rest }) => rest);
	}

	/**
	 * Revoke a key by setting revokedAt.
	 */
	async revokeKey(keyId: string): Promise<void> {
		await withFileLock(this.keysPath, async () => {
			const data = await this.loadUnsafe();
			const record = data.keys.find((k) => k.keyId === keyId);
			if (record) {
				record.revokedAt = new Date().toISOString();
				await this.saveUnsafe(data);
			}
		});
	}

	/**
	 * Delete keys that are past their expiresAt date.
	 * Returns the number of keys removed.
	 */
	async cleanupExpired(): Promise<number> {
		let count = 0;
		await withFileLock(this.keysPath, async () => {
			const data = await this.loadUnsafe();
			const now = new Date();
			const before = data.keys.length;
			data.keys = data.keys.filter(
				(k) => !k.expiresAt || new Date(k.expiresAt) > now,
			);
			count = before - data.keys.length;
			if (count > 0) await this.saveUnsafe(data);
		});
		return count;
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	/** Parse a full token into {keyId, rawSecret}, returns null if malformed. */
	private parseToken(fullToken: string): { keyId: string; rawSecret: string } | null {
		// Expected format: pas_<keyId>_<rawSecret>
		if (!fullToken.startsWith('pas_')) return null;
		const rest = fullToken.slice(4); // strip 'pas_'
		const sep = rest.indexOf('_');
		if (sep === -1) return null;
		const keyId = rest.slice(0, sep);
		const rawSecret = rest.slice(sep + 1);
		if (!keyId || !rawSecret) return null;
		return { keyId, rawSecret };
	}

	/** Debounce lastUsedAt writes: at most once per 60 s per key. */
	private debounceLastUsed(keyId: string): void {
		const now = Date.now();
		const last = this.lastUsedWriteTimes.get(keyId) ?? 0;
		if (now - last < LAST_USED_DEBOUNCE_MS) return;

		this.lastUsedWriteTimes.set(keyId, now);
		// Fire-and-forget; errors are logged but never raised.
		this.writeLastUsed(keyId, new Date(now).toISOString()).catch((err) => {
			this.logger?.warn({ err, keyId }, 'api-keys: failed to update lastUsedAt');
		});
	}

	private async writeLastUsed(keyId: string, timestamp: string): Promise<void> {
		await withFileLock(this.keysPath, async () => {
			const data = await this.loadUnsafe();
			const record = data.keys.find((k) => k.keyId === keyId);
			if (record) {
				record.lastUsedAt = timestamp;
				await this.saveUnsafe(data);
			}
		});
	}

	/** Load api-keys.yaml without holding the lock (caller must hold it or not need it). */
	private async loadUnsafe(): Promise<ApiKeysData> {
		const raw = await readYamlFile<ApiKeysData>(this.keysPath);
		if (!raw || typeof raw !== 'object' || !Array.isArray((raw as ApiKeysData).keys)) {
			return { version: 1, keys: [] };
		}
		// Basic version check
		if ((raw as ApiKeysData).version !== 1) {
			this.logger?.warn({ path: this.keysPath }, 'api-keys: unknown file version, starting fresh');
			return { version: 1, keys: [] };
		}
		return raw as ApiKeysData;
	}

	private async saveUnsafe(data: ApiKeysData): Promise<void> {
		await mkdir(join(this.keysPath, '..'), { recursive: true });
		await writeYamlFile(this.keysPath, data);
	}
}
