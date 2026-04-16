/**
 * Account credential management routes (D5b-8).
 *
 * - GET  /account                         — self-service account page
 * - POST /account/password                — change own password (any authenticated actor)
 * - POST /users/:userId/reset-password    — reset another user's password (platform-admin only)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { issueSessionCookie } from '../auth.js';
import { requirePlatformAdmin } from '../guards/require-platform-admin.js';
import type { CredentialService } from '../../services/credentials/index.js';
import type { UserManager } from '../../services/user-manager/index.js';

const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MIN_PASSWORD_LENGTH = 8;

export interface CredentialRoutesOptions {
	credentialService: CredentialService;
	userManager: UserManager;
	logger: Logger;
}

export function registerCredentialRoutes(
	server: FastifyInstance,
	options: CredentialRoutesOptions,
): void {
	const { credentialService, userManager, logger } = options;

	// -------------------------------------------------------------------------
	// GET /account — self-service account page
	// -------------------------------------------------------------------------
	server.get('/account', async (request: FastifyRequest, reply: FastifyReply) => {
		const user = request.user;
		if (!user) return reply.redirect('/gui/login');

		const hasPassword = await credentialService.hasCredentials(user.userId);
		return reply.viewAsync('account/index', {
			title: 'Account — PAS',
			activePage: 'account',
			hasPassword,
			success: null,
			error: null,
		});
	});

	// -------------------------------------------------------------------------
	// POST /account/password — change own password
	// -------------------------------------------------------------------------
	server.post('/account/password', async (request: FastifyRequest, reply: FastifyReply) => {
		const user = request.user;
		if (!user) return reply.redirect('/gui/login');

		const body = request.body as {
			currentPassword?: string;
			newPassword?: string;
			confirmPassword?: string;
		};

		const renderError = async (error: string, hasPassword: boolean) =>
			reply.status(400).viewAsync('account/index', {
				title: 'Account — PAS',
				activePage: 'account',
				hasPassword,
				success: null,
				error,
			});

		const hasExisting = await credentialService.hasCredentials(user.userId);

		const newPassword = body.newPassword ?? '';
		const confirmPassword = body.confirmPassword ?? '';

		if (!newPassword) {
			return renderError('New password is required.', hasExisting);
		}
		if (newPassword.length < MIN_PASSWORD_LENGTH) {
			return renderError(
				`Password must be at least ${MIN_PASSWORD_LENGTH.toString()} characters.`,
				hasExisting,
			);
		}
		if (newPassword !== confirmPassword) {
			return renderError('Passwords do not match.', hasExisting);
		}

		// If user has existing credentials, require current password verification
		if (hasExisting) {
			const currentPassword = body.currentPassword ?? '';
			const valid = await credentialService.verifyPassword(user.userId, currentPassword);
			if (!valid) {
				return renderError('Current password is incorrect.', true);
			}
		}

		await credentialService.setPassword(user.userId, newPassword);
		logger.info({ userId: user.userId }, 'User changed their own password');

		// Reissue cookie with updated session version so the current session stays valid.
		// All OTHER sessions for this user are invalidated because they carry the old sessionVersion.
		const newVersion = await credentialService.getSessionVersion(user.userId);
		issueSessionCookie(reply, user.userId, newVersion, 'gui-password');

		return reply.viewAsync('account/index', {
			title: 'Account — PAS',
			activePage: 'account',
			hasPassword: true,
			success: 'Password updated successfully.',
			error: null,
		});
	});

	// -------------------------------------------------------------------------
	// POST /users/:userId/reset-password — admin-only password reset
	// -------------------------------------------------------------------------
	server.post(
		'/users/:userId/reset-password',
		{ preHandler: [requirePlatformAdmin] },
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { userId } = request.params as { userId: string };

			if (!USER_ID_PATTERN.test(userId)) {
				return reply.status(400).send({ ok: false, error: 'Invalid user ID format.' });
			}

			const targetUser = userManager.getUser(userId);
			if (!targetUser) {
				return reply.status(404).viewAsync('403', {
					title: 'Not Found — PAS',
					message: 'User not found.',
				});
			}

			const body = request.body as {
				newPassword?: string;
				confirmPassword?: string;
			};

			const renderAdminError = async (error: string) =>
				reply.status(400).viewAsync('users/reset-password', {
					title: 'Reset Password — PAS',
					activePage: 'users',
					targetUser,
					error,
					success: null,
				});

			const newPassword = body.newPassword ?? '';
			const confirmPassword = body.confirmPassword ?? '';

			if (!newPassword) {
				return renderAdminError('New password is required.');
			}
			if (newPassword.length < MIN_PASSWORD_LENGTH) {
				return renderAdminError(
					`Password must be at least ${MIN_PASSWORD_LENGTH.toString()} characters.`,
				);
			}
			if (newPassword !== confirmPassword) {
				return renderAdminError('Passwords do not match.');
			}

			await credentialService.setPassword(userId, newPassword);
			logger.info(
				{ adminUserId: request.user?.userId, targetUserId: userId },
				'Admin reset user password',
			);

			return reply.viewAsync('users/reset-password', {
				title: 'Reset Password — PAS',
				activePage: 'users',
				targetUser,
				error: null,
				success: `Password for ${targetUser.name} has been reset.`,
			});
		},
	);

	// -------------------------------------------------------------------------
	// GET /users/:userId/reset-password — admin-only reset form
	// -------------------------------------------------------------------------
	server.get(
		'/users/:userId/reset-password',
		{ preHandler: [requirePlatformAdmin] },
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { userId } = request.params as { userId: string };

			if (!USER_ID_PATTERN.test(userId)) {
				return reply.status(400).send({ ok: false, error: 'Invalid user ID format.' });
			}

			const targetUser = userManager.getUser(userId);
			if (!targetUser) {
				return reply.status(404).viewAsync('403', {
					title: 'Not Found — PAS',
					message: 'User not found.',
				});
			}

			return reply.viewAsync('users/reset-password', {
				title: 'Reset Password — PAS',
				activePage: 'users',
				targetUser,
				error: null,
				success: null,
			});
		},
	);
}
