/**
 * Telegram service implementation.
 *
 * Implements the TelegramService interface that apps use to send
 * messages, photos, and interactive option keyboards.
 */

import { randomBytes } from 'node:crypto';
import { InlineKeyboard, InputFile } from 'grammy';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { InlineButton, SentMessage, TelegramService } from '../../types/telegram.js';

/** Default timeout for sendOptions (5 minutes). */
const OPTIONS_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingOptions {
	resolve: (value: string) => void;
	reject: (reason: Error) => void;
	options: string[];
	timer: ReturnType<typeof setTimeout>;
	/** The user ID who initiated the sendOptions call. */
	userId: string;
}

export interface TelegramServiceOptions {
	bot: Bot;
	logger: Logger;
}

export class TelegramServiceImpl implements TelegramService {
	private readonly bot: Bot;
	private readonly logger: Logger;
	private readonly pending = new Map<string, PendingOptions>();

	constructor(options: TelegramServiceOptions) {
		this.bot = options.bot;
		this.logger = options.logger;
	}

	/** Send a text message to a user. Supports Telegram Markdown. */
	async send(userId: string, message: string): Promise<void> {
		try {
			await this.bot.api.sendMessage(Number(userId), message, {
				parse_mode: 'Markdown',
			});
		} catch (error) {
			this.logger.error({ userId, error }, 'Failed to send message');
			throw error;
		}
	}

	/** Send a photo with an optional caption. */
	async sendPhoto(userId: string, photo: Buffer, caption?: string): Promise<void> {
		try {
			await this.bot.api.sendPhoto(Number(userId), new InputFile(photo), {
				caption,
			});
		} catch (error) {
			this.logger.error({ userId, error }, 'Failed to send photo');
			throw error;
		}
	}

	/**
	 * Present a list of options as inline keyboard buttons.
	 * Returns a Promise that resolves with the selected option text.
	 * Times out after 5 minutes.
	 */
	async sendOptions(userId: string, prompt: string, options: string[]): Promise<string> {
		const nonce = randomBytes(8).toString('hex');
		const keyboard = new InlineKeyboard();

		for (const [i, option] of options.entries()) {
			keyboard.text(option, `opt:${nonce}:${i}`);
			// One button per row for readability
			if (i < options.length - 1) keyboard.row();
		}

		try {
			await this.bot.api.sendMessage(Number(userId), prompt, {
				reply_markup: keyboard,
			});
		} catch (error) {
			this.logger.error({ userId, error }, 'Failed to send options keyboard');
			throw error;
		}

		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(nonce);
				reject(new Error('Options selection timed out'));
			}, OPTIONS_TIMEOUT_MS);

			this.pending.set(nonce, { resolve, reject, options, timer, userId });
		});
	}

	/** Send a message with a custom inline keyboard. Returns message IDs for later editing. */
	async sendWithButtons(
		userId: string,
		text: string,
		buttons: InlineButton[][],
	): Promise<SentMessage> {
		const keyboard = new InlineKeyboard();
		for (const [rowIdx, row] of buttons.entries()) {
			for (const btn of row) {
				keyboard.text(btn.text, btn.callbackData);
			}
			if (rowIdx < buttons.length - 1) keyboard.row();
		}

		try {
			const msg = await this.bot.api.sendMessage(Number(userId), text, {
				reply_markup: keyboard,
				parse_mode: 'Markdown',
			});
			return { chatId: msg.chat.id, messageId: msg.message_id };
		} catch (error) {
			this.logger.error({ userId, error }, 'Failed to send message with buttons');
			throw error;
		}
	}

	/** Edit an existing message's text and optionally its keyboard. */
	async editMessage(
		chatId: number,
		messageId: number,
		text: string,
		buttons?: InlineButton[][],
	): Promise<void> {
		let reply_markup: InlineKeyboard | undefined;
		if (buttons) {
			reply_markup = new InlineKeyboard();
			for (const [rowIdx, row] of buttons.entries()) {
				for (const btn of row) {
					reply_markup.text(btn.text, btn.callbackData);
				}
				if (rowIdx < buttons.length - 1) reply_markup.row();
			}
		}

		try {
			await this.bot.api.editMessageText(chatId, messageId, text, {
				reply_markup,
				parse_mode: 'Markdown',
			});
		} catch (error) {
			// Telegram returns 400 when message text hasn't changed — ignore it
			if (error instanceof Error && error.message.includes('message is not modified')) {
				return;
			}
			this.logger.error({ chatId, messageId, error }, 'Failed to edit message');
			throw error;
		}
	}

	/**
	 * Handle a callback query from an inline keyboard button.
	 * Called by the bot middleware when a user clicks an option.
	 */
	handleCallbackQuery(userId: string, data: string): void {
		// Parse callback data: "opt:<nonce>:<index>"
		const parts = data.split(':');
		if (parts.length !== 3 || parts[0] !== 'opt') {
			this.logger.warn({ data }, 'Unknown callback query data format');
			return;
		}

		const [, nonce, indexStr] = parts;
		if (!nonce || !indexStr) return;
		const index = Number.parseInt(indexStr, 10);
		const entry = this.pending.get(nonce);

		if (!entry) {
			this.logger.debug({ nonce }, 'Callback query for expired or unknown nonce');
			return;
		}

		// Verify the callback is from the same user who received the keyboard
		if (entry.userId !== userId) {
			this.logger.warn(
				{ nonce, expectedUserId: entry.userId, actualUserId: userId },
				'Callback query from wrong user — ignoring',
			);
			return;
		}

		if (Number.isNaN(index) || index < 0 || index >= entry.options.length) {
			this.logger.warn({ nonce, index }, 'Callback query with invalid option index');
			return;
		}

		clearTimeout(entry.timer);
		this.pending.delete(nonce);
		const selected = entry.options[index];
		if (selected === undefined) return;
		entry.resolve(selected);
	}

	/** Clean up all pending options (called during shutdown). */
	cleanup(): void {
		for (const [_nonce, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error('Telegram service shutting down'));
		}
		this.pending.clear();
	}
}
