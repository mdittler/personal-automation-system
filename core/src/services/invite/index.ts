/**
 * Invite service.
 *
 * Manages invite codes that allow new users to register without knowing
 * their Telegram ID. Codes are stored in data/system/invites.yaml.
 *
 * Each code is an 8-character hex string valid for 24 hours. After use,
 * codes are retained for 7 days before cleanup removes them.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { AsyncLock } from '../../utils/async-lock.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';

export interface InviteCode {
	name: string;
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	usedBy: string | null;
	usedAt: string | null;
}

/** Shape of invites.yaml: { code: InviteCode } */
export type InviteStore = Record<string, InviteCode>;

export interface InviteServiceOptions {
	dataDir: string;
	logger: Logger;
}

export class InviteService {
	private readonly invitesPath: string;
	private readonly logger: Logger;
	private readonly lock = new AsyncLock();

	constructor(options: InviteServiceOptions) {
		this.invitesPath = join(options.dataDir, 'system', 'invites.yaml');
		this.logger = options.logger;
	}

	/**
	 * Create a new invite code.
	 * Returns the 8-character hex code.
	 */
	async createInvite(name: string, createdBy: string): Promise<string> {
		const code = randomBytes(4).toString('hex');
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

		const store = await this.readStore();
		store[code] = {
			name,
			createdBy,
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			usedBy: null,
			usedAt: null,
		};

		await this.writeStore(store);
		this.logger.info({ code, name, createdBy }, 'Invite code created');
		return code;
	}

	/**
	 * Validate an invite code.
	 * Returns the invite on success, or a specific error message on failure.
	 */
	async validateCode(code: string): Promise<{ invite: InviteCode } | { error: string }> {
		const store = await this.readStore();
		const invite = store[code];

		if (!invite) {
			return { error: 'Invalid invite code.' };
		}

		if (invite.usedBy !== null) {
			return { error: 'This invite code has already been used.' };
		}

		if (new Date(invite.expiresAt) <= new Date()) {
			return {
				error: 'This invite code has expired. Ask the admin for a new one.',
			};
		}

		return { invite };
	}

	/**
	 * Redeem an invite code, marking it as used by the given userId.
	 */
	async redeemCode(code: string, usedBy: string): Promise<void> {
		return this.lock.run(`invite:${code}`, async () => {
			const store = await this.readStore();
			const invite = store[code];

			if (!invite) {
				throw new Error(`Invite code not found: ${code}`);
			}

			if (invite.usedBy !== null) {
				throw new Error(`Invite code already used: ${code}`);
			}

			if (new Date(invite.expiresAt) <= new Date()) {
				throw new Error(`Invite code expired: ${code}`);
			}

			invite.usedBy = usedBy;
			invite.usedAt = new Date().toISOString();

			await this.writeStore(store);
			this.logger.info({ code, usedBy }, 'Invite code redeemed');
		});
	}

	/**
	 * Atomically validate and redeem an invite code.
	 * Returns the invite on success, or an error message on failure.
	 * Serialized per-code to prevent race conditions.
	 */
	async claimAndRedeem(
		code: string,
		usedBy: string,
	): Promise<{ invite: InviteCode } | { error: string }> {
		return this.lock.run(`invite:${code}`, async () => {
			const store = await this.readStore();
			const invite = store[code];

			if (!invite) {
				return { error: 'Invalid invite code.' };
			}

			if (invite.usedBy !== null) {
				// Idempotent retry: same user retrying after a registration failure
				if (invite.usedBy === usedBy) {
					return { invite };
				}
				return { error: 'This invite code has already been used.' };
			}

			if (new Date(invite.expiresAt) <= new Date()) {
				return {
					error: 'This invite code has expired. Ask the admin for a new one.',
				};
			}

			invite.usedBy = usedBy;
			invite.usedAt = new Date().toISOString();

			await this.writeStore(store);
			this.logger.info({ code, usedBy }, 'Invite code claimed and redeemed');

			return { invite };
		});
	}

	/**
	 * List all invite codes.
	 */
	async listInvites(): Promise<InviteStore> {
		return this.readStore();
	}

	/**
	 * Remove expired+used codes that are older than 7 days.
	 */
	async cleanup(): Promise<void> {
		const store = await this.readStore();
		const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

		let removed = 0;
		for (const [code, invite] of Object.entries(store)) {
			const isUsed = invite.usedBy !== null;
			const isExpired = new Date(invite.expiresAt) <= new Date();
			const isOld = invite.usedAt !== null && new Date(invite.usedAt) <= cutoff;

			if (isUsed && isExpired && isOld) {
				delete store[code];
				removed++;
			}
		}

		if (removed > 0) {
			await this.writeStore(store);
			this.logger.info({ removed }, 'Cleaned up old invite codes');
		}
	}

	// --- Private helpers ---

	private async readStore(): Promise<InviteStore> {
		return (await readYamlFile<InviteStore>(this.invitesPath)) ?? {};
	}

	private async writeStore(store: InviteStore): Promise<void> {
		await writeYamlFile(this.invitesPath, store);
	}
}
