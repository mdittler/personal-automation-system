import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramServiceImpl } from '../index.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function createMockBot(): Bot {
	return {
		api: {
			sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
			sendPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
		},
	} as unknown as Bot;
}

describe('TelegramServiceImpl', () => {
	let bot: Bot;
	let service: TelegramServiceImpl;

	beforeEach(() => {
		bot = createMockBot();
		service = new TelegramServiceImpl({ bot, logger: createMockLogger() });
	});

	afterEach(() => {
		service.cleanup();
	});

	describe('send', () => {
		it('should send a text message with Markdown parse mode', async () => {
			await service.send('12345', 'Hello *world*');

			expect(bot.api.sendMessage).toHaveBeenCalledWith(12345, 'Hello *world*', {
				parse_mode: 'Markdown',
			});
		});

		it('should throw if sendMessage fails', async () => {
			vi.mocked(bot.api.sendMessage).mockRejectedValue(new Error('API error'));

			await expect(service.send('12345', 'test')).rejects.toThrow('API error');
		});
	});

	describe('sendPhoto', () => {
		it('should send a photo with caption', async () => {
			const photo = Buffer.from('fake-jpeg');

			await service.sendPhoto('12345', photo, 'A nice photo');

			expect(bot.api.sendPhoto).toHaveBeenCalledWith(
				12345,
				expect.anything(), // InputFile instance
				{ caption: 'A nice photo' },
			);
		});

		it('should send a photo without caption', async () => {
			const photo = Buffer.from('fake-jpeg');

			await service.sendPhoto('12345', photo);

			expect(bot.api.sendPhoto).toHaveBeenCalledWith(12345, expect.anything(), {
				caption: undefined,
			});
		});
	});

	describe('sendOptions', () => {
		it('should send a keyboard and resolve when callback arrives', async () => {
			// sendOptions returns a Promise. We must handle the callback
			// before awaiting, otherwise we'll wait forever.
			const promise = service.sendOptions('12345', 'Pick one:', ['A', 'B', 'C']);

			// Allow the sendMessage mock to resolve
			await vi.waitFor(() => {
				expect(bot.api.sendMessage).toHaveBeenCalled();
			});

			// Extract nonce from the callback data in the keyboard
			const call = vi.mocked(bot.api.sendMessage).mock.calls[0];
			const replyMarkup = call[2]?.reply_markup as {
				inline_keyboard: Array<Array<{ callback_data: string }>>;
			};
			const callbackData = replyMarkup.inline_keyboard[0][0].callback_data;

			// Simulate user clicking first option
			service.handleCallbackQuery('12345', callbackData);

			const result = await promise;
			expect(result).toBe('A');
		});

		it('should resolve with the correct option when second button clicked', async () => {
			const promise = service.sendOptions('12345', 'Pick:', ['X', 'Y']);

			await vi.waitFor(() => {
				expect(bot.api.sendMessage).toHaveBeenCalled();
			});

			const call = vi.mocked(bot.api.sendMessage).mock.calls[0];
			const replyMarkup = call[2]?.reply_markup as {
				inline_keyboard: Array<Array<{ callback_data: string }>>;
			};
			// Second button is in second row (one button per row)
			const callbackData = replyMarkup.inline_keyboard[1][0].callback_data;

			service.handleCallbackQuery('12345', callbackData);

			const result = await promise;
			expect(result).toBe('Y');
		});

		it('should ignore unknown callback nonces', () => {
			const logger = createMockLogger();
			const svc = new TelegramServiceImpl({ bot, logger });

			svc.handleCallbackQuery('12345', 'opt:unknown:0');
			expect(logger.debug).toHaveBeenCalled();
			svc.cleanup();
		});

		it('should ignore malformed callback data', () => {
			const logger = createMockLogger();
			const svc = new TelegramServiceImpl({ bot, logger });

			svc.handleCallbackQuery('12345', 'garbage');
			expect(logger.warn).toHaveBeenCalled();
			svc.cleanup();
		});

		it('should reject callback from wrong user', async () => {
			const logger = createMockLogger();
			const svc = new TelegramServiceImpl({ bot, logger });

			const promise = svc.sendOptions('12345', 'Pick:', ['A', 'B']);

			await vi.waitFor(() => {
				expect(bot.api.sendMessage).toHaveBeenCalled();
			});

			// Extract callback data
			const call = vi.mocked(bot.api.sendMessage).mock.calls[0];
			const replyMarkup = call[2]?.reply_markup as {
				inline_keyboard: Array<Array<{ callback_data: string }>>;
			};
			const callbackData = replyMarkup.inline_keyboard[0][0].callback_data;

			// Attempt callback from different user — should be ignored
			svc.handleCallbackQuery('99999', callbackData);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({ expectedUserId: '12345', actualUserId: '99999' }),
				expect.stringContaining('wrong user'),
			);

			// Now respond with correct user — should resolve
			svc.handleCallbackQuery('12345', callbackData);
			const result = await promise;
			expect(result).toBe('A');

			svc.cleanup();
		});
	});

	describe('cleanup', () => {
		it('should reject all pending options on cleanup', async () => {
			const promise = service.sendOptions('12345', 'Pick:', ['A', 'B']);

			// Allow sendMessage to complete
			await vi.waitFor(() => {
				expect(bot.api.sendMessage).toHaveBeenCalled();
			});

			// Cleanup rejects all pending
			service.cleanup();

			await expect(promise).rejects.toThrow('shutting down');
		});
	});
});
