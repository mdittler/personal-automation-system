/**
 * User manager service.
 *
 * Provides user lookup, registration checks, and config validation.
 * Sources user data from SystemConfig (loaded from pas.yaml).
 * Delegates app-enable checks to AppToggleStore.
 */

import type { Logger } from 'pino';
import type { SystemConfig } from '../../types/config.js';
import type { RegisteredUser } from '../../types/users.js';
import type { AppToggleStore } from '../app-toggle/index.js';

export interface UserManagerOptions {
	config: SystemConfig;
	appToggle: AppToggleStore;
	logger: Logger;
}

export class UserManager {
	private users: RegisteredUser[];
	private readonly userMap: Map<string, RegisteredUser>;
	private readonly appToggle: AppToggleStore;
	private readonly logger: Logger;

	constructor(options: UserManagerOptions) {
		this.users = options.config.users.map((u) => ({
			...u,
			enabledApps: [...u.enabledApps],
			sharedScopes: [...(u.sharedScopes ?? [])],
		}));
		this.appToggle = options.appToggle;
		this.logger = options.logger;

		// Build lookup map by Telegram ID
		this.userMap = new Map();
		for (const user of this.users) {
			this.userMap.set(user.id, user);
		}
	}

	/** Look up a registered user by Telegram user ID. */
	getUser(telegramId: string): RegisteredUser | null {
		return this.userMap.get(telegramId) ?? null;
	}

	/** Check if a Telegram user ID is registered. */
	isRegistered(telegramId: string): boolean {
		return this.userMap.has(telegramId);
	}

	/** Get the list of enabled app IDs for a user (from config, not toggle-resolved). */
	getUserApps(telegramId: string): string[] {
		const user = this.getUser(telegramId);
		return user?.enabledApps ?? [];
	}

	/** Get the shared scopes a user has access to. */
	getSharedScopes(telegramId: string): string[] {
		const user = this.getUser(telegramId);
		return user?.sharedScopes ?? [];
	}

	/**
	 * Check if an app is enabled for a user, considering toggle overrides.
	 * Delegates to AppToggleStore for override resolution.
	 */
	async isAppEnabled(telegramId: string, appId: string): Promise<boolean> {
		const user = this.getUser(telegramId);
		if (!user) return false;
		return this.appToggle.isEnabled(telegramId, appId, user.enabledApps);
	}

	/** Get all registered users. */
	getAllUsers(): ReadonlyArray<RegisteredUser> {
		return this.users;
	}

	/** Add a new user to the internal array and map. */
	addUser(user: RegisteredUser): void {
		this.users.push(user);
		this.userMap.set(user.id, user);
	}

	/**
	 * Remove a user by Telegram ID.
	 * Returns true if the user was found and removed, false otherwise.
	 */
	removeUser(telegramId: string): boolean {
		if (!this.userMap.has(telegramId)) return false;
		this.userMap.delete(telegramId);
		this.users = this.users.filter((u) => u.id !== telegramId);
		return true;
	}

	/**
	 * Update the enabledApps list for a user.
	 * Returns true if the user was found and updated, false otherwise.
	 */
	updateUserApps(telegramId: string, enabledApps: string[]): boolean {
		const user = this.userMap.get(telegramId);
		if (!user) return false;
		user.enabledApps = enabledApps;
		return true;
	}

	/**
	 * Update the sharedScopes list for a user.
	 * Returns true if the user was found and updated, false otherwise.
	 */
	updateUserSharedScopes(telegramId: string, sharedScopes: string[]): boolean {
		const user = this.userMap.get(telegramId);
		if (!user) return false;
		user.sharedScopes = sharedScopes;
		return true;
	}

	/**
	 * Validate the user config and return warnings.
	 *
	 * @param knownAppIds - App IDs that have been loaded by the registry
	 * @returns Array of warning messages (empty if no issues)
	 */
	validateConfig(knownAppIds: string[]): string[] {
		const warnings: string[] = [];
		const seenIds = new Set<string>();
		const appIdSet = new Set(knownAppIds);

		for (const user of this.users) {
			// Check for duplicate IDs
			if (seenIds.has(user.id)) {
				warnings.push(`Duplicate user ID: ${user.id}`);
			}
			seenIds.add(user.id);

			// Check ID format
			if (!/^\d+$/.test(user.id)) {
				warnings.push(`User "${user.name}" has non-numeric Telegram ID: ${user.id}`);
			}

			// Check for empty name
			if (!user.name.trim()) {
				warnings.push(`User with ID ${user.id} has empty name`);
			}

			// Validate enabledApps references
			for (const appId of user.enabledApps) {
				if (appId !== '*' && !appIdSet.has(appId)) {
					warnings.push(`User "${user.name}" references unknown app: ${appId}`);
				}
			}
		}

		if (warnings.length > 0) {
			this.logger.warn({ warningCount: warnings.length }, 'Config validation found issues');
		}

		return warnings;
	}
}
