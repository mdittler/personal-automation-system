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
import { withMultiFileLock } from '../../utils/file-mutex.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';
import { normalizeDisplayName } from './normalize.js';

/** Lock key shared with UserMutationService.registerUser so create-vs-register cannot interleave. */
export const DISPLAY_NAME_LOCK_KEY = 'display-name:uniqueness';

/** SAFE_SEGMENT — must match the same pattern used elsewhere in PAS. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

export interface InviteCode {
	name: string;
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	usedBy: string | null;
	usedAt: string | null;
	/** Household the redeemer will be registered into. */
	householdId: string;
	/** Role assigned to the new user on registration. */
	role: 'admin' | 'member' | 'child';
	/** Space IDs the new user will be auto-joined into after registration. */
	initialSpaces: string[];
	/** Optional override for enabled apps; defaults to household defaults if absent. */
	enabledApps?: string[];
}

/** Shape of invites.yaml: { code: InviteCode } */
export type InviteStore = Record<string, InviteCode>;

export interface InviteServiceOptions {
	dataDir: string;
	logger: Logger;
	/**
	 * Returns the registered users. `createInvite` uses this to reject names
	 * that collide with an existing `user.name` (case-insensitive) or match an
	 * existing user's numeric id. Re-evaluated on every call so newly-registered
	 * users are visible immediately. Required — pass `() => []` when no users
	 * exist yet rather than omitting it.
	 */
	knownUsers: () => Iterable<{ id: string; name: string }>;
	/** Clock injection. Defaults to `() => new Date()`. */
	now?: () => Date;
}

export class InviteService {
	private readonly invitesPath: string;
	private readonly logger: Logger;
	private readonly lock = new AsyncLock();
	private readonly knownUsers: () => Iterable<{ id: string; name: string }>;
	private readonly now: () => Date;

	constructor(options: InviteServiceOptions) {
		// `knownUsers` is a required part of the contract — createInvite relies on
		// it for both the id-collision and name-collision checks. Fail fast here
		// (rather than at the first createInvite call) so an untyped JS caller that
		// omits it gets a clear error at construction.
		if (typeof options.knownUsers !== 'function') {
			throw new Error(
				'InviteService requires a knownUsers function (pass () => [] if no users exist).',
			);
		}
		this.invitesPath = join(options.dataDir, 'system', 'invites.yaml');
		this.logger = options.logger;
		this.knownUsers = options.knownUsers;
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * Create a new invite code.
	 *
	 * @param name - Display name for the invited user.
	 * @param createdBy - User ID of the admin creating the invite.
	 * @param opts - Household registration options.
	 * @returns The 8-character hex code.
	 */
	async createInvite(
		name: string,
		createdBy: string,
		opts?: {
			householdId?: string;
			role?: 'admin' | 'member' | 'child';
			initialSpaces?: string[];
			enabledApps?: string[];
		},
	): Promise<string> {
		// Trim first so " 12345 " / " Sarah " normalize before any check.
		const trimmedName = name.trim();
		if (trimmedName.length === 0) {
			throw new Error('Display name must not be blank.');
		}
		// Reject id-collisions before the all-digit guard so the operator sees
		// the more specific message when they typed an id into the name field.
		for (const u of this.knownUsers()) {
			if (u.id === trimmedName) {
				throw new Error(
					`Display name '${trimmedName}' matches an existing user id; choose a different name.`,
				);
			}
		}
		// Reject all-digit names regardless of knownUsers — they would shadow
		// the numeric Telegram id space.
		if (/^\d+$/.test(trimmedName)) {
			throw new Error(
				`Display name must not be numeric-only (would collide with Telegram id space): ${JSON.stringify(name)}.`,
			);
		}

		// Validate initialSpaces — each must be a valid SAFE_SEGMENT
		const initialSpaces = opts?.initialSpaces ?? [];
		for (const spaceId of initialSpaces) {
			if (!SAFE_SEGMENT.test(spaceId)) {
				throw new Error(
					`Invalid space ID in initialSpaces: ${JSON.stringify(spaceId)}. Must match SAFE_SEGMENT pattern.`,
				);
			}
		}

		// I-3: householdId is required on every invite created post-D5a.
		// Admin check (createdBy must be in household.adminUserIds) is enforced at the
		// router/command level before createInvite is called, so it is not re-enforced here.
		const householdId = opts?.householdId ?? '';
		if (!householdId) {
			throw new Error('householdId is required when creating an invite code. Pass opts.householdId.');
		}
		if (!SAFE_SEGMENT.test(householdId)) {
			throw new Error(`Invalid householdId: ${JSON.stringify(householdId)}. Must match SAFE_SEGMENT pattern.`);
		}

		// locked uniqueness check + write.
		// Shared lock key (DISPLAY_NAME_LOCK_KEY) is also held by registerUser, so
		// concurrent create/register on the same name frontier are serialized.
		// withMultiFileLock sorts keys canonically (see core/src/utils/file-mutex.ts)
		// — deadlock-safe regardless of caller key order.
		return withMultiFileLock([DISPLAY_NAME_LOCK_KEY, this.invitesPath], async () => {
			const store = await this.readStore();
			const norm = normalizeDisplayName(trimmedName);
			const nowDate = this.now();

			// Reject collisions with existing user.name (case-insensitive).
			for (const u of this.knownUsers()) {
				if (normalizeDisplayName(u.name) === norm) {
					throw new Error(
						`Display name '${trimmedName}' is already taken. Choose a different name for the invite.`,
					);
				}
			}

			// Reject collisions with ACTIVE invites only:
			//   - usedBy === null  (unredeemed)
			//   - expiresAt > now  (unexpired)
			// Used and expired invites do NOT block reuse — names are freed when an
			// invite is consumed or lapses.
			for (const [activeCode, invite] of Object.entries(store)) {
				if (invite.usedBy !== null) continue;
				if (new Date(invite.expiresAt) <= nowDate) continue;
				if (normalizeDisplayName(invite.name) === norm) {
					throw new Error(
						`Display name '${trimmedName}' is already taken by an active invite (${activeCode}). Choose a different name.`,
					);
				}
			}

			const code = randomBytes(4).toString('hex');
			const expiresAt = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000);

			store[code] = {
				name: trimmedName,
				createdBy,
				createdAt: nowDate.toISOString(),
				expiresAt: expiresAt.toISOString(),
				usedBy: null,
				usedAt: null,
				householdId,
				role: opts?.role ?? 'member',
				initialSpaces,
				...(opts?.enabledApps !== undefined ? { enabledApps: opts.enabledApps } : {}),
			};

			await this.writeStore(store);
			this.logger.info(
				{ code, name: trimmedName, createdBy, householdId },
				'Invite code created',
			);
			return code;
		});
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

		if (new Date(invite.expiresAt) <= this.now()) {
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

			if (new Date(invite.expiresAt) <= this.now()) {
				throw new Error(`Invite code expired: ${code}`);
			}

			invite.usedBy = usedBy;
			invite.usedAt = this.now().toISOString();

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

			if (new Date(invite.expiresAt) <= this.now()) {
				return {
					error: 'This invite code has expired. Ask the admin for a new one.',
				};
			}

			invite.usedBy = usedBy;
			invite.usedAt = this.now().toISOString();

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
		const nowDate = this.now();
		const cutoff = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);

		let removed = 0;
		for (const [code, invite] of Object.entries(store)) {
			const isUsed = invite.usedBy !== null;
			const isExpired = new Date(invite.expiresAt) <= nowDate;
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
