/**
 * Credential service.
 *
 * Manages per-user password hashes and session versions.
 *
 * Storage: data/system/credentials.yaml — keyed by userId.
 * A single file-level mutex serializes ALL writes so different
 * users cannot clobber each other's entries in the shared file.
 *
 * NEVER log, expose, or return stored hashes from public methods.
 */

import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { withFileLock } from '../../utils/file-mutex.js';
import { readYamlFileStrict, writeYamlFile } from '../../utils/yaml.js';
import { hashPassword, verifyPassword } from './hash.js';
import type { CredentialsData, StoredCredential } from './types.js';

export type { StoredCredential } from './types.js';

export interface CredentialServiceOptions {
	dataDir: string;
	logger?: Logger;
}

export class CredentialService {
	private readonly credPath: string;
	private readonly logger?: Logger;

	constructor(options: CredentialServiceOptions) {
		this.credPath = join(options.dataDir, 'system', 'credentials.yaml');
		this.logger = options.logger;
	}

	/**
	 * Set (or replace) the password for a user.
	 * Always bumps sessionVersion so any outstanding GUI sessions are invalidated.
	 */
	async setPassword(userId: string, plaintext: string): Promise<void> {
		const hashed = await hashPassword(plaintext);
		await withFileLock(this.credPath, async () => {
			const data = await this.loadUnsafe();
			const existing = data[userId];
			const sessionVersion = (existing?.sessionVersion ?? 0) + 1;
			data[userId] = {
				...hashed,
				sessionVersion,
				updatedAt: new Date().toISOString(),
			};
			await writeYamlFile(this.credPath, data);
		});
	}

	/**
	 * Verify a plaintext password against the stored hash for a user.
	 * Returns false if no credentials are stored for the user.
	 */
	async verifyPassword(userId: string, plaintext: string): Promise<boolean> {
		const data = await this.loadUnsafe();
		const stored = data[userId];
		if (!stored) return false;
		return verifyPassword(plaintext, stored);
	}

	/**
	 * Get the current session version for a user.
	 * Returns 0 for users with no stored credentials.
	 */
	async getSessionVersion(userId: string): Promise<number> {
		const data = await this.loadUnsafe();
		return data[userId]?.sessionVersion ?? 0;
	}

	/**
	 * Increment the session version for a user, invalidating all outstanding sessions.
	 * Creates a credential entry with only the version bump if none exists yet.
	 */
	async incrementSessionVersion(userId: string): Promise<number> {
		let newVersion = 0;
		await withFileLock(this.credPath, async () => {
			const data = await this.loadUnsafe();
			const existing = data[userId];
			if (existing) {
				existing.sessionVersion = existing.sessionVersion + 1;
				existing.updatedAt = new Date().toISOString();
				newVersion = existing.sessionVersion;
				await writeYamlFile(this.credPath, data);
			} else {
				// No credential yet — nothing to invalidate; version stays at 0.
				newVersion = 0;
			}
		});
		return newVersion;
	}

	/**
	 * Remove all credentials for a user (e.g., when the user is deleted).
	 */
	async clearCredentials(userId: string): Promise<void> {
		await withFileLock(this.credPath, async () => {
			const data = await this.loadUnsafe();
			if (userId in data) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete data[userId];
				await writeYamlFile(this.credPath, data);
			}
		});
	}

	/**
	 * Returns true if the user has credentials stored (password has been set).
	 */
	async hasCredentials(userId: string): Promise<boolean> {
		const data = await this.loadUnsafe();
		return userId in data && data[userId] !== undefined;
	}

	// ---------------------------------------------------------------------------
	// Internal helpers
	// ---------------------------------------------------------------------------

	/**
	 * Load credentials.yaml without holding a lock.
	 * Callers that mutate must call this from within withFileLock.
	 */
	private async loadUnsafe(): Promise<CredentialsData> {
		const result = await readYamlFileStrict(this.credPath);

		// File does not exist yet — first run
		if (result === null) return {};

		// Read or parse error — create sidecar and start empty
		if ('error' in result) {
			await this.createCorruptSidecar();
			this.logger?.warn({ path: this.credPath, error: result.error }, 'credentials: corrupt file; starting empty');
			return {};
		}

		const raw = result.data;
		if (raw === null || raw === undefined) return {};

		if (typeof raw !== 'object' || Array.isArray(raw)) {
			await this.createCorruptSidecar();
			this.logger?.warn({ path: this.credPath }, 'credentials: unexpected top-level shape; starting empty');
			return {};
		}

		const data: CredentialsData = {};
		for (const [uid, entry] of Object.entries(raw as Record<string, unknown>)) {
			if (!isStoredCredential(entry)) {
				this.logger?.warn({ userId: uid }, 'credentials: skipping invalid entry for user');
				continue;
			}
			data[uid] = entry;
		}
		return data;
	}

	private async createCorruptSidecar(): Promise<void> {
		const ts = new Date().toISOString().replace(/[:.]/g, '-');
		const corruptPath = `${this.credPath}.${ts}.corrupt`;
		try {
			await copyFile(this.credPath, corruptPath);
		} catch {
			// Best-effort; ignore failure
		}
	}
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isStoredCredential(v: unknown): v is StoredCredential {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	const c = v as Record<string, unknown>;
	return (
		c['version'] === 1 &&
		c['algo'] === 'scrypt' &&
		typeof c['salt'] === 'string' &&
		typeof c['hash'] === 'string' &&
		typeof c['sessionVersion'] === 'number' &&
		typeof c['updatedAt'] === 'string' &&
		isScryptParams(c['params'])
	);
}

function isScryptParams(v: unknown): boolean {
	if (typeof v !== 'object' || v === null) return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p['N'] === 'number' &&
		typeof p['r'] === 'number' &&
		typeof p['p'] === 'number' &&
		typeof p['keyLen'] === 'number'
	);
}
