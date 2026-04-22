/**
 * Fake TelegramService for integration and load tests.
 *
 * All send methods are no-ops that record sent messages for inspection.
 * cleanup() is a no-op required by ShutdownManager.
 */

import type {
	InlineButton,
	SentMessage,
	TelegramService,
} from '../../types/telegram.js';

export interface RecordedMessage {
	userId: string;
	text: string;
}

export type FakeTelegramService = TelegramService & {
	cleanup(): void;
	sent: RecordedMessage[];
};

export function fakeTelegramService(): FakeTelegramService {
	const sent: RecordedMessage[] = [];

	return {
		sent,

		async send(userId: string, message: string): Promise<void> {
			sent.push({ userId, text: message });
		},

		async sendPhoto(_userId: string, _photo: Buffer, _caption?: string): Promise<void> {},

		async sendOptions(_userId: string, _prompt: string, options: string[]): Promise<string> {
			return options[0] ?? '';
		},

		async sendWithButtons(
			userId: string,
			text: string,
			_buttons: InlineButton[][],
		): Promise<SentMessage> {
			sent.push({ userId, text });
			return { chatId: 0, messageId: 0 };
		},

		async editMessage(
			_chatId: number,
			_messageId: number,
			_text: string,
			_buttons?: InlineButton[][],
		): Promise<void> {},

		cleanup(): void {},
	};
}
