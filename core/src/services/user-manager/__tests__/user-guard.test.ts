import { describe, expect, it, vi } from 'vitest';
import type { TelegramService } from '../../../types/telegram.js';
import type { UserManager } from '../index.js';
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
});
