/**
 * Message adapter: grammY context → PAS MessageContext / PhotoContext.
 *
 * Converts grammY's Context objects into the typed message contexts
 * that the router and apps work with.
 */

import type { Context } from 'grammy';
import type { Logger } from 'pino';
import type { MessageContext, PhotoContext } from '../../types/telegram.js';

/**
 * Extract the Telegram user ID as a string from a grammY context.
 * Returns null if no user is associated with the update.
 */
export function extractUserId(ctx: Context): string | null {
	const id = ctx.from?.id;
	return id != null ? String(id) : null;
}

/**
 * Adapt a grammY text message context to a PAS MessageContext.
 * Returns null if the context doesn't contain a text message.
 */
export function adaptTextMessage(ctx: Context): MessageContext | null {
	const msg = ctx.message;
	if (!msg?.text) return null;

	const userId = extractUserId(ctx);
	if (!userId) return null;

	return {
		userId,
		text: msg.text,
		timestamp: new Date(msg.date * 1000),
		chatId: msg.chat.id,
		messageId: msg.message_id,
	};
}

/**
 * Adapt a grammY photo message context to a PAS PhotoContext.
 * Downloads the largest available photo from Telegram.
 * Returns null if the context doesn't contain a photo or download fails.
 */
export async function adaptPhotoMessage(
	ctx: Context,
	logger?: Logger,
): Promise<PhotoContext | null> {
	const msg = ctx.message;
	if (!msg?.photo || msg.photo.length === 0) return null;

	const userId = extractUserId(ctx);
	if (!userId) return null;

	// Last element is the highest resolution version
	const largest = msg.photo.at(-1);
	if (!largest) return null;

	try {
		const file = await ctx.api.getFile(largest.file_id);
		if (!file.file_path) return null;

		// Download photo via Telegram Bot API file endpoint
		const token = ctx.api.token;
		const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
		const response = await fetch(fileUrl);

		if (!response.ok) return null;

		const arrayBuffer = await response.arrayBuffer();
		const photo = Buffer.from(arrayBuffer);

		return {
			userId,
			photo,
			caption: msg.caption,
			mimeType: 'image/jpeg', // Telegram always converts photos to JPEG
			timestamp: new Date(msg.date * 1000),
			chatId: msg.chat.id,
			messageId: msg.message_id,
		};
	} catch (error) {
		logger?.error({ error, userId }, 'Failed to download photo from Telegram');
		return null;
	}
}
