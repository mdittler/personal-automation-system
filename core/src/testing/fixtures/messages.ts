/**
 * Canned MessageContext factory functions for integration and load tests.
 */

import type { MessageContext } from '../../types/telegram.js';

export function chatbotMessage(userId: string, i: number): MessageContext {
	return {
		userId,
		text: `hi chatbot iteration ${i}`,
		chatId: 1000 + i,
		messageId: i,
		timestamp: new Date(),
	};
}

export function askMessage(userId: string, i: number): MessageContext {
	return {
		userId,
		text: '/ask what apps do I have?',
		chatId: 1000 + i,
		messageId: i,
		timestamp: new Date(),
	};
}

export function foodMessage(userId: string, i: number): MessageContext {
	return {
		userId,
		text: 'add milk to grocery list',
		chatId: 1000 + i,
		messageId: i,
		timestamp: new Date(),
	};
}
