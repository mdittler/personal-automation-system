import { describe, expect, it, vi } from 'vitest';
import type { TelegramService } from '../../../types/telegram.js';
import type { InviteService } from '../../invite/index.js';
import type { UserManager } from '../index.js';
import type { UserMutationService } from '../user-mutation-service.js';
import { UserGuard } from '../user-guard.js';

function createMockUserManager(registeredIds: string[]): UserManager {
	const idSet = new Set(registeredIds);
	return {
		isRegistered: vi.fn((id: string) => idSet.has(id)),
		getUser: vi.fn(),
	} as unknown as UserManager;
}

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn(async () => {}),
		sendPhoto: vi.fn(async () => {}),
		sendOptions: vi.fn(async () => ''),
	};
}

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as never;

function createMockInviteService(
	validateResult: { invite: { name: string } } | { error: string },
): InviteService {
	return {
		validateCode: vi.fn(async () => validateResult),
		redeemCode: vi.fn(async () => {}),
		createInvite: vi.fn(),
		listInvites: vi.fn(),
		cleanup: vi.fn(),
	} as unknown as InviteService;
}

function createMockUserMutationService(): UserMutationService {
	return {
		registerUser: vi.fn(async () => {}),
		removeUser: vi.fn(),
		updateUserApps: vi.fn(),
		updateUserSharedScopes: vi.fn(),
	} as unknown as UserMutationService;
}

describe('UserGuard', () => {
	it('allows registered users', async () => {
		const userManager = createMockUserManager(['111', '222']);
		const telegram = createMockTelegram();
		const guard = new UserGuard({ userManager, telegram, logger: mockLogger });

		const result = await guard.checkUser('111');
		expect(result).toBe(true);
		expect(telegram.send).not.toHaveBeenCalled();
	});

	it('rejects unregistered users with a message', async () => {
		const userManager = createMockUserManager(['111']);
		const telegram = createMockTelegram();
		const guard = new UserGuard({ userManager, telegram, logger: mockLogger });

		const result = await guard.checkUser('999');
		expect(result).toBe(false);
		expect(telegram.send).toHaveBeenCalledWith('999', expect.stringContaining('not registered'));
	});

	it('logs warning for rejected users', async () => {
		const userManager = createMockUserManager([]);
		const telegram = createMockTelegram();
		const logger = { ...mockLogger, warn: vi.fn() } as never;
		const guard = new UserGuard({ userManager, telegram, logger });

		await guard.checkUser('999');
		expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
			{ userId: '999' },
			expect.stringContaining('unregistered'),
		);
	});

	it('handles send failure gracefully', async () => {
		const userManager = createMockUserManager([]);
		const telegram = createMockTelegram();
		vi.mocked(telegram.send).mockRejectedValue(new Error('Network error'));
		const guard = new UserGuard({ userManager, telegram, logger: mockLogger });

		// Should not throw even if send fails
		const result = await guard.checkUser('999');
		expect(result).toBe(false);
	});

	it('does not send rejection to registered users', async () => {
		const userManager = createMockUserManager(['111']);
		const telegram = createMockTelegram();
		const guard = new UserGuard({ userManager, telegram, logger: mockLogger });

		await guard.checkUser('111');
		await guard.checkUser('111');
		expect(telegram.send).not.toHaveBeenCalled();
	});

	describe('invite code detection', () => {
		it('registers user and returns true when valid invite code is sent', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({
				invite: {
					name: 'Alice',
					createdBy: 'admin',
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					usedBy: null,
					usedAt: null,
				} as never,
			});
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999', 'a1b2c3d4');
			expect(result).toBe(true);
			expect(userMutationService.registerUser).toHaveBeenCalledWith(
				expect.objectContaining({ id: '999', name: 'Alice', isAdmin: false }),
			);
			expect(inviteService.redeemCode).toHaveBeenCalledWith('a1b2c3d4', '999');
			expect(telegram.send).toHaveBeenCalledWith(
				'999',
				expect.stringContaining('Welcome to PAS, Alice'),
			);
		});

		it('sends specific error and returns false when code-shaped text is invalid', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({
				error: 'This invite code has expired. Ask the admin for a new one.',
			});
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999', 'deadbeef');
			expect(result).toBe(false);
			expect(userMutationService.registerUser).not.toHaveBeenCalled();
			expect(inviteService.redeemCode).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith(
				'999',
				'This invite code has expired. Ask the admin for a new one.',
			);
		});

		it('sends standard rejection when text is not code-shaped', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({ error: 'Invalid invite code.' });
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999', 'hello world');
			expect(result).toBe(false);
			expect(inviteService.validateCode).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith('999', expect.stringContaining('not registered'));
		});

		it('sends standard rejection when no messageText is provided', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({ error: 'Invalid invite code.' });
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999');
			expect(result).toBe(false);
			expect(inviteService.validateCode).not.toHaveBeenCalled();
			expect(telegram.send).toHaveBeenCalledWith('999', expect.stringContaining('not registered'));
		});

		it('sends standard rejection when inviteService is not configured', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			// No inviteService or userMutationService provided
			const guard = new UserGuard({ userManager, telegram, logger: mockLogger });

			const result = await guard.checkUser('999', 'a1b2c3d4');
			expect(result).toBe(false);
			expect(telegram.send).toHaveBeenCalledWith('999', expect.stringContaining('not registered'));
		});

		it('trims whitespace from message text before code matching', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({
				invite: {
					name: 'Bob',
					createdBy: 'admin',
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					usedBy: null,
					usedAt: null,
				} as never,
			});
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999', '  a1b2c3d4  ');
			expect(result).toBe(true);
			expect(inviteService.validateCode).toHaveBeenCalledWith('a1b2c3d4');
		});

		it('handles welcome message send failure gracefully after successful registration', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			vi.mocked(telegram.send).mockRejectedValue(new Error('Telegram error'));
			const inviteService = createMockInviteService({
				invite: {
					name: 'Carol',
					createdBy: 'admin',
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					usedBy: null,
					usedAt: null,
				} as never,
			});
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			// Should not throw even if send fails — user is still registered
			const result = await guard.checkUser('999', 'a1b2c3d4');
			expect(result).toBe(true);
			expect(userMutationService.registerUser).toHaveBeenCalled();
			expect(inviteService.redeemCode).toHaveBeenCalled();
		});

		it('redeems valid code when sent as /start <code> from unregistered user', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({
				invite: {
					name: 'Alice',
					createdBy: 'admin',
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					usedBy: null,
					usedAt: null,
				} as never,
			});
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999', '/start a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.validateCode).toHaveBeenCalledWith('a1b2c3d4');
			expect(userMutationService.registerUser).toHaveBeenCalledWith(
				expect.objectContaining({ id: '999', name: 'Alice', isAdmin: false }),
			);
			expect(inviteService.redeemCode).toHaveBeenCalledWith('a1b2c3d4', '999');
		});

		it('sends invite error when /start <code> has expired code', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({
				error: 'This invite code has expired. Ask the admin for a new one.',
			});
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999', '/start deadbeef');
			expect(result).toBe(false);
			expect(inviteService.validateCode).toHaveBeenCalledWith('deadbeef');
			expect(telegram.send).toHaveBeenCalledWith(
				'999',
				'This invite code has expired. Ask the admin for a new one.',
			);
		});

		it('handles /start with extra whitespace before code', async () => {
			const userManager = createMockUserManager([]);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({
				invite: {
					name: 'Bob',
					createdBy: 'admin',
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					usedBy: null,
					usedAt: null,
				} as never,
			});
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('999', '/start  a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.validateCode).toHaveBeenCalledWith('a1b2c3d4');
		});

		it('does not attempt invite redemption for registered users', async () => {
			const userManager = createMockUserManager(['111']);
			const telegram = createMockTelegram();
			const inviteService = createMockInviteService({ error: 'Should not be called.' });
			const userMutationService = createMockUserMutationService();

			const guard = new UserGuard({
				userManager,
				telegram,
				logger: mockLogger,
				inviteService,
				userMutationService,
			});

			const result = await guard.checkUser('111', 'a1b2c3d4');
			expect(result).toBe(true);
			expect(inviteService.validateCode).not.toHaveBeenCalled();
			expect(telegram.send).not.toHaveBeenCalled();
		});
	});
});
