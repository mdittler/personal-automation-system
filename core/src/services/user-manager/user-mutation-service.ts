/**
 * UserMutationService — coordination layer for user mutations + config sync.
 *
 * Wraps UserManager mutations with automatic sync to pas.yaml so that
 * every in-memory change is durably persisted.
 */

import type { Logger } from 'pino';
import type { RegisteredUser } from '../../types/users.js';
import { syncUsersToConfig } from '../config/config-writer.js';
import type { HouseholdService } from '../household/index.js';
import type { UserManager } from './index.js';

export interface UserMutationServiceOptions {
	userManager: UserManager;
	configPath: string;
	logger: Logger;
	/** Optional — when present, syncUser is called after each successful registration and removeUser after removal to keep the in-memory map current. */
	householdService?: Pick<HouseholdService, 'syncUser' | 'removeUser'>;
}

export class UserMutationService {
	private readonly userManager: UserManager;
	private readonly configPath: string;
	private readonly logger: Logger;
	private readonly householdService?: Pick<HouseholdService, 'syncUser' | 'removeUser'>;

	constructor(options: UserMutationServiceOptions) {
		this.userManager = options.userManager;
		this.configPath = options.configPath;
		this.logger = options.logger;
		this.householdService = options.householdService;
	}

	/**
	 * Register a new user (e.g. from invite redemption).
	 * Adds the user to the in-memory manager and syncs to config.
	 *
	 * For new registrations, `user.householdId` should always be provided.
	 * A warning is logged if it is absent (legacy/migration path only).
	 */
	async registerUser(user: RegisteredUser): Promise<void> {
		if (!user.householdId) {
			this.logger.warn(
				{ userId: user.id },
				'registerUser: householdId is missing — new users should always have a householdId. ' +
					'This is allowed only during migration.',
			);
		}

		this.userManager.addUser(user);
		try {
			await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		} catch (err) {
			// Roll back in-memory state so the user doesn't appear registered after a restart
			this.userManager.removeUser(user.id);
			this.logger.error({ userId: user.id, err }, 'Config sync failed — registration rolled back');
			throw err;
		}
		// Keep HouseholdService's in-memory userId→householdId map current
		this.householdService?.syncUser(user);
		this.logger.info({ userId: user.id, householdId: user.householdId ?? 'MISSING' }, 'User registered and config synced');
	}

	/**
	 * Remove a user by Telegram ID.
	 *
	 * Safety guards:
	 * - Cannot remove your own account (callerUserId === telegramId)
	 * - Cannot remove the last admin
	 * - Returns an error object if the user is not found
	 *
	 * Returns an empty object on success, or `{ error: string }` on failure.
	 */
	async removeUser(telegramId: string, callerUserId?: string): Promise<{ error?: string }> {
		// Self-removal guard
		if (callerUserId !== undefined && callerUserId === telegramId) {
			return { error: 'Cannot remove your own account.' };
		}

		// Existence check
		const user = this.userManager.getUser(telegramId);
		if (!user) {
			return { error: 'User not found.' };
		}

		// Last-admin guard
		if (user.isAdmin) {
			const adminCount = this.userManager.getAllUsers().filter((u) => u.isAdmin).length;
			if (adminCount <= 1) {
				return { error: 'Cannot remove the last admin user.' };
			}
		}

		const previousUsers = this.snapshotUsers();
		// No async boundary exists between the existence check above and this
		// synchronous mutation, so the user cannot disappear under current
		// UserManager semantics.
		this.userManager.removeUser(telegramId);

		try {
			await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		} catch (err) {
			// householdService is updated only after config sync succeeds, so a
			// rollback here only needs to restore the in-memory UserManager state.
			this.restoreUsers(previousUsers);
			this.logger.error({ userId: telegramId, err }, 'Config sync failed — user removal rolled back');
			throw err;
		}

		this.householdService?.removeUser(telegramId);
		this.logger.info({ userId: telegramId }, 'User removed and config synced');
		return {};
	}

	/**
	 * Update the enabled apps list for a user and sync to config.
	 */
	async updateUserApps(telegramId: string, enabledApps: string[]): Promise<void> {
		const previousUsers = this.snapshotUsers();
		const updated = this.userManager.updateUserApps(telegramId, enabledApps);
		if (!updated) {
			throw new Error('User not found.');
		}

		try {
			await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		} catch (err) {
			this.restoreUsers(previousUsers);
			this.logger.error(
				{ userId: telegramId, err },
				'Config sync failed — user app update rolled back',
			);
			throw err;
		}

		this.logger.info({ userId: telegramId }, 'User apps updated and config synced');
	}

	/**
	 * Update the shared scopes list for a user and sync to config.
	 */
	async updateUserSharedScopes(telegramId: string, sharedScopes: string[]): Promise<void> {
		const previousUsers = this.snapshotUsers();
		const updated = this.userManager.updateUserSharedScopes(telegramId, sharedScopes);
		if (!updated) {
			throw new Error('User not found.');
		}

		try {
			await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		} catch (err) {
			this.restoreUsers(previousUsers);
			this.logger.error(
				{ userId: telegramId, err },
				'Config sync failed — user shared-scope update rolled back',
			);
			throw err;
		}

		this.logger.info({ userId: telegramId }, 'User shared scopes updated and config synced');
	}

	private snapshotUsers(): RegisteredUser[] {
		return this.userManager.getAllUsers().map((user) => ({
			...user,
			enabledApps: [...user.enabledApps],
			sharedScopes: [...user.sharedScopes],
		}));
	}

	private restoreUsers(users: ReadonlyArray<RegisteredUser>): void {
		// Restores only UserManager state. HouseholdService does not need a
		// rollback companion because removeUser mutates it only after config sync
		// succeeds.
		for (const userId of this.userManager.getAllUsers().map((user) => user.id)) {
			this.userManager.removeUser(userId);
		}
		for (const user of users) {
			this.userManager.addUser({
				...user,
				enabledApps: [...user.enabledApps],
				sharedScopes: [...user.sharedScopes],
			});
		}
	}
}
