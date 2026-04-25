/**
 * Telegram message formatting helpers.
 *
 * Pure helpers for splitting long responses into Telegram-safe chunks
 * (max 4096 chars) and stripping legacy Markdown when Telegram rejects
 * a chunk due to malformed Markdown parse errors.
 */

import type { AppLogger } from '../../types/app-module.js';
import type { TelegramService } from '../../types/telegram.js';

/**
 * Split a long message into Telegram-safe chunks (max 4096 chars).
 *
 * Splitting priority:
 *   1. Paragraph boundaries (\n\n)
 *   2. Line boundaries (\n)
 *   3. Hard chunk at maxLength
 *
 * @param text       The full response text.
 * @param maxLength  Split threshold (default 3800, below Telegram's 4096 limit).
 */
export function splitTelegramMessage(text: string, maxLength = 3800): string[] {
	if (text.length <= maxLength) return [text];

	const parts: string[] = [];
	let remaining = text;

	while (remaining.length > maxLength) {
		const chunk = remaining.slice(0, maxLength);

		// Try paragraph boundary
		const paraIdx = chunk.lastIndexOf('\n\n');
		if (paraIdx > 0) {
			parts.push(remaining.slice(0, paraIdx).trim());
			remaining = remaining.slice(paraIdx + 2).trim();
			continue;
		}

		// Try line boundary
		const lineIdx = chunk.lastIndexOf('\n');
		if (lineIdx > 0) {
			parts.push(remaining.slice(0, lineIdx).trim());
			remaining = remaining.slice(lineIdx + 1).trim();
			continue;
		}

		// Hard chunk
		parts.push(chunk);
		remaining = remaining.slice(maxLength);
	}

	if (remaining.trim()) {
		parts.push(remaining.trim());
	}

	return parts.filter((p) => p.trim() !== '');
}

/**
 * Strip legacy Markdown formatting markers to produce plain text.
 * Used as a fallback when Telegram rejects a message due to malformed
 * Markdown parse errors (e.g. an unmatched code fence from a split).
 */
export function stripMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3).trim()) // fenced code → content
		.replace(/`([^`]+)`/g, '$1') // inline code → content
		.replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** → plain
		.replace(/\*([^*]+)\*/g, '$1') // *italic* → plain
		.replace(/__([^_]+)__/g, '$1') // __bold__ → plain
		.replace(/_([^_]+)_/g, '$1'); // _italic_ → plain
}

/**
 * Send a (possibly split) response to a Telegram user.
 * Falls back to plain text if Telegram rejects a part due to Markdown parse errors.
 */
export async function sendSplitResponse(
	userId: string,
	text: string,
	deps: { telegram: TelegramService; logger: AppLogger },
): Promise<void> {
	const parts = splitTelegramMessage(text);
	for (const part of parts) {
		try {
			await deps.telegram.send(userId, part);
		} catch (error) {
			// Telegram may reject a split chunk if Markdown delimiters are unmatched.
			// Strip formatting and retry as plain text.
			deps.logger.warn(
				'Telegram Markdown parse failed on split chunk, retrying as plain text: %s',
				error,
			);
			await deps.telegram.send(userId, stripMarkdown(part));
		}
	}
}
