/**
 * User guard.
 *
 * Pre-routing check that rejects messages from unregistered Telegram users.
 * Called from bootstrap bot middleware before messages reach the router.
 */

import type { Logger } from 'pino';
import type { TelegramService } from '../../types/telegram.js';
import type { UserManager } from './index.js';

export interface UserGuardOptions {
	userManager: UserManager;
	telegram: TelegramService;
	logger: Logger;
}

export class UserGuard {
	private readonly userManager: UserManager;
	private readonly telegram: TelegramService;
	private readonly logger: Logger;

	constructor(options: UserGuardOptions) {
		this.userManager = options.userManager;
		this.telegram = options.telegram;
		this.logger = options.logger;
	}

	/**
	 * Check if a user is allowed to interact with the bot.
	 *
	 * @returns true if the user is registered and may proceed, false otherwise.
	 */
	async checkUser(userId: string): Promise<boolean> {
		if (this.userManager.isRegistered(userId)) {
			return true;
		}

		this.logger.warn({ userId }, 'Rejected message from unregistered user');

		try {
			await this.telegram.send(
				userId,
				"You're not registered to use this bot. Please ask the administrator to add you.",
			);
		} catch (error) {
			this.logger.error({ userId, error }, 'Failed to send rejection message');
		}

		return false;
	}
}
