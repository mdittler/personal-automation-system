/**
 * Shared invite redemption + user registration helper.
 *
 * Used by both UserGuard and Router so that the claim → register → welcome
 * flow is implemented in one place with consistent error handling.
 */

import type { Logger } from 'pino';
import type { InviteService } from './index.js';
import type { UserMutationService } from '../user-manager/user-mutation-service.js';
import type { TelegramService } from '../../types/telegram.js';

export interface RedeemAndRegisterDeps {
	inviteService: InviteService;
	userMutationService: UserMutationService;
	telegram: TelegramService;
	logger: Logger;
}

export type RedeemAndRegisterResult =
	| { success: true; name: string }
	| { success: false; error: string };

/**
 * Atomically claim an invite code, register the user, and send a welcome message.
 *
 * Returns { success: true } if the user is now registered.
 * Returns { success: false, error } with a user-facing message on any invite error.
 * Throws if registration (config sync) fails — caller should catch and surface the error.
 */
export async function redeemInviteAndRegister(
	deps: RedeemAndRegisterDeps,
	code: string,
	userId: string,
): Promise<RedeemAndRegisterResult> {
	const { inviteService, userMutationService, telegram, logger } = deps;

	const result = await inviteService.claimAndRedeem(code, userId);
	if ('error' in result) {
		return { success: false, error: result.error };
	}

	const newUser = {
		id: userId,
		name: result.invite.name,
		isAdmin: false,
		enabledApps: ['*'] as string[],
		sharedScopes: [] as string[],
	};

	try {
		await userMutationService.registerUser(newUser);
	} catch (err) {
		logger.error({ userId, err }, 'redeemInviteAndRegister: registerUser failed');
		try {
			await telegram.send(
				userId,
				'Registration failed due to a system error. Please try again — your invite code is still valid.',
			);
		} catch {
			// Telegram send failure is non-fatal
		}
		throw err;
	}

	logger.info({ userId, name: result.invite.name }, 'User registered via invite code');

	try {
		await telegram.send(
			userId,
			`Welcome to PAS, ${result.invite.name}! Type /help to see available commands.`,
		);
	} catch (err) {
		logger.error({ userId, err }, 'Failed to send welcome message after registration');
	}

	return { success: true, name: result.invite.name };
}
