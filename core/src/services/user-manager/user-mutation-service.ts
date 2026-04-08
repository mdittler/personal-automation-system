/**
 * UserMutationService — coordination layer for user mutations + config sync.
 *
 * Wraps UserManager mutations with automatic sync to pas.yaml so that
 * every in-memory change is durably persisted.
 */

import type { Logger } from 'pino';
import type { RegisteredUser } from '../../types/users.js';
import { syncUsersToConfig } from '../config/config-writer.js';
import type { UserManager } from './index.js';

export interface UserMutationServiceOptions {
	userManager: UserManager;
	configPath: string;
	logger: Logger;
}

export class UserMutationService {
	private readonly userManager: UserManager;
	private readonly configPath: string;
	private readonly logger: Logger;

	constructor(options: UserMutationServiceOptions) {
		this.userManager = options.userManager;
		this.configPath = options.configPath;
		this.logger = options.logger;
	}

	/**
	 * Register a new user (e.g. from invite redemption).
	 * Adds the user to the in-memory manager and syncs to config.
	 */
	async registerUser(user: RegisteredUser): Promise<void> {
		this.userManager.addUser(user);
		await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		this.logger.info({ userId: user.id }, 'User registered and config synced');
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
	async removeUser(
		telegramId: string,
		callerUserId?: string,
	): Promise<{ error?: string }> {
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
			const adminCount = this.userManager
				.getAllUsers()
				.filter((u) => u.isAdmin).length;
			if (adminCount <= 1) {
				return { error: 'Cannot remove the last admin user.' };
			}
		}

		this.userManager.removeUser(telegramId);
		await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		this.logger.info({ userId: telegramId }, 'User removed and config synced');
		return {};
	}

	/**
	 * Update the enabled apps list for a user and sync to config.
	 */
	async updateUserApps(telegramId: string, enabledApps: string[]): Promise<void> {
		this.userManager.updateUserApps(telegramId, enabledApps);
		await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		this.logger.info({ userId: telegramId }, 'User apps updated and config synced');
	}

	/**
	 * Update the shared scopes list for a user and sync to config.
	 */
	async updateUserSharedScopes(telegramId: string, sharedScopes: string[]): Promise<void> {
		this.userManager.updateUserSharedScopes(telegramId, sharedScopes);
		await syncUsersToConfig(this.configPath, this.userManager.getAllUsers());
		this.logger.info({ userId: telegramId }, 'User shared scopes updated and config synced');
	}
}
