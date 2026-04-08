/**
 * User guard.
 *
 * Pre-routing check that rejects messages from unregistered Telegram users.
 * Called from bootstrap bot middleware before messages reach the router.
 *
 * If the user is unregistered and the message text looks like an 8-character
 * hex invite code, UserGuard will attempt to validate and redeem the code,
 * registering the user on success.
 */

import type { Logger } from 'pino';
import type { TelegramService } from '../../types/telegram.js';
import type { InviteService } from '../invite/index.js';
import type { UserManager } from './index.js';
import type { UserMutationService } from './user-mutation-service.js';

export interface UserGuardOptions {
	userManager: UserManager;
	telegram: TelegramService;
	logger: Logger;
	inviteService?: InviteService;
	userMutationService?: UserMutationService;
}

export class UserGuard {
	private readonly userManager: UserManager;
	private readonly telegram: TelegramService;
	private readonly logger: Logger;
	private readonly inviteService?: InviteService;
	private readonly userMutationService?: UserMutationService;

	constructor(options: UserGuardOptions) {
		this.userManager = options.userManager;
		this.telegram = options.telegram;
		this.logger = options.logger;
		this.inviteService = options.inviteService;
		this.userMutationService = options.userMutationService;
	}

	/**
	 * Check if a user is allowed to interact with the bot.
	 *
	 * If `messageText` is provided and the user is unregistered, checks whether
	 * the text looks like an invite code (8-char hex). If so, attempts redemption.
	 *
	 * @returns true if the user is registered (or just registered via invite) and may proceed, false otherwise.
	 */
	async checkUser(userId: string, messageText?: string): Promise<boolean> {
		if (this.userManager.isRegistered(userId)) {
			return true;
		}

		// If unregistered and text looks like an invite code, try to redeem.
		// Supports both raw codes ("a1b2c3d4") and Telegram deep links ("/start a1b2c3d4").
		if (messageText && this.inviteService && this.userMutationService) {
			const trimmed = messageText.trim();

			// Extract potential code from raw hex or /start <hex>
			let potentialCode: string | null = null;
			if (/^[a-f0-9]{8}$/.test(trimmed)) {
				potentialCode = trimmed;
			} else {
				const startMatch = trimmed.match(/^\/start\s+([a-f0-9]{8})$/);
				if (startMatch) {
					potentialCode = startMatch[1] ?? null;
				}
			}

			if (potentialCode) {
				const result = await this.inviteService.validateCode(potentialCode);
				if ('invite' in result) {
					// Valid code — register the user
					const newUser = {
						id: userId,
						name: result.invite.name,
						isAdmin: false,
						enabledApps: ['*'] as string[],
						sharedScopes: [] as string[],
					};
					await this.userMutationService.registerUser(newUser);
					await this.inviteService.redeemCode(potentialCode, userId);
					this.logger.info(
						{ userId, name: result.invite.name },
						'User registered via invite code',
					);
					try {
						await this.telegram.send(
							userId,
							`Welcome to PAS, ${result.invite.name}! Type /help to see available commands.`,
						);
					} catch (error) {
						this.logger.error({ userId, error }, 'Failed to send welcome message');
					}
					return true;
				}
				// Code-shaped but invalid — send specific invite error
				this.logger.warn({ userId }, 'Rejected invite code from unregistered user');
				try {
					await this.telegram.send(userId, result.error);
				} catch (error) {
					this.logger.error({ userId, error }, 'Failed to send invite error message');
				}
				return false;
			}
		}

		// Standard rejection
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
