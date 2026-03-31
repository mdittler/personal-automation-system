import { describe, expect, it, vi } from 'vitest';
import type { InlineButton } from '../../../types/telegram.js';
import { TelegramServiceImpl } from '../index.js';

function createMockBot() {
	return {
		api: {
			sendMessage: vi.fn().mockResolvedValue({
				chat: { id: 12345 },
				message_id: 678,
			}),
			editMessageText: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
		},
	};
}

function createMockLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
}

describe('TelegramService — sendWithButtons', () => {
	it('sends a message with inline keyboard and returns message IDs', async () => {
		const bot = createMockBot();
		const svc = new TelegramServiceImpl({
			bot: bot as any,
			logger: createMockLogger() as any,
		});

		const buttons: InlineButton[][] = [
			[{ text: '☐ Milk', callbackData: 'app:hearthstone:toggle:0' }],
			[
				{ text: '🔄 Refresh', callbackData: 'app:hearthstone:refresh' },
				{ text: '🗑 Clear', callbackData: 'app:hearthstone:clear' },
			],
		];

		const result = await svc.sendWithButtons('user1', 'Grocery List', buttons);

		expect(result).toEqual({ chatId: 12345, messageId: 678 });
		expect(bot.api.sendMessage).toHaveBeenCalledWith(
			expect.any(Number),
			'Grocery List',
			expect.objectContaining({
				reply_markup: expect.anything(),
				parse_mode: 'Markdown',
			}),
		);
	});

	it('throws on API error', async () => {
		const bot = createMockBot();
		bot.api.sendMessage.mockRejectedValue(new Error('Network error'));
		const svc = new TelegramServiceImpl({
			bot: bot as any,
			logger: createMockLogger() as any,
		});

		await expect(svc.sendWithButtons('user1', 'text', [])).rejects.toThrow('Network error');
	});
});

describe('TelegramService — editMessage', () => {
	it('calls editMessageText with correct params', async () => {
		const bot = createMockBot();
		const svc = new TelegramServiceImpl({
			bot: bot as any,
			logger: createMockLogger() as any,
		});

		await svc.editMessage(12345, 678, 'Updated text');

		expect(bot.api.editMessageText).toHaveBeenCalledWith(12345, 678, 'Updated text', {
			reply_markup: undefined,
			parse_mode: 'Markdown',
		});
	});

	it('passes keyboard when buttons provided', async () => {
		const bot = createMockBot();
		const svc = new TelegramServiceImpl({
			bot: bot as any,
			logger: createMockLogger() as any,
		});

		const buttons: InlineButton[][] = [[{ text: 'Click me', callbackData: 'test:data' }]];

		await svc.editMessage(12345, 678, 'Updated', buttons);

		expect(bot.api.editMessageText).toHaveBeenCalledWith(12345, 678, 'Updated', {
			reply_markup: expect.anything(),
			parse_mode: 'Markdown',
		});
	});

	it('handles "message is not modified" error gracefully', async () => {
		const bot = createMockBot();
		bot.api.editMessageText.mockRejectedValue(new Error('Bad Request: message is not modified'));
		const svc = new TelegramServiceImpl({
			bot: bot as any,
			logger: createMockLogger() as any,
		});

		// Should not throw
		await expect(svc.editMessage(12345, 678, 'Same text')).resolves.toBeUndefined();
	});

	it('rethrows other errors', async () => {
		const bot = createMockBot();
		bot.api.editMessageText.mockRejectedValue(new Error('Chat not found'));
		const svc = new TelegramServiceImpl({
			bot: bot as any,
			logger: createMockLogger() as any,
		});

		await expect(svc.editMessage(12345, 678, 'text')).rejects.toThrow('Chat not found');
	});
});
