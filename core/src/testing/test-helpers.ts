/**
 * Test helper utilities for creating message/photo contexts.
 *
 * Provides factory functions with sensible defaults so tests
 * don't need to repeat boilerplate context construction.
 */

import type { MessageContext, PhotoContext } from '../types/telegram.js';

/** Create a MessageContext with sensible defaults. Override any field. */
export function createTestMessageContext(overrides?: Partial<MessageContext>): MessageContext {
	return {
		userId: 'test-user',
		text: 'hello',
		timestamp: new Date('2026-01-15T12:00:00Z'),
		chatId: 1,
		messageId: 1,
		...overrides,
	};
}

/** Create a PhotoContext with sensible defaults. Override any field. */
export function createTestPhotoContext(overrides?: Partial<PhotoContext>): PhotoContext {
	return {
		userId: 'test-user',
		photo: Buffer.from('fake-jpeg'),
		mimeType: 'image/jpeg',
		timestamp: new Date('2026-01-15T12:00:00Z'),
		chatId: 1,
		messageId: 1,
		...overrides,
	};
}
