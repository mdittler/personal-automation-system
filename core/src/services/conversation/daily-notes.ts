/**
 * Daily-note append helper.
 *
 * Preserves the pre-chatbot fallback behavior of writing every message
 * to a per-day Markdown file in the user's data scope, so the user has
 * a permanent record even when LLM calls fail.
 */

import type { AppLogger } from '../../types/app-module.js';
import type { DataStoreService } from '../../types/data-store.js';
import type { MessageContext } from '../../types/telegram.js';
import { generateFrontmatter } from '../../utils/frontmatter.js';

interface AppendDailyNoteDeps {
	data: DataStoreService;
	logger: AppLogger;
	timezone: string;
}

/** Format a date as YYYY-MM-DD using the configured timezone. */
function toDateString(date: Date, timezone: string): string {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone || 'UTC',
	});
	return formatter.format(date);
}

/** Format time as HH:MM using the configured timezone. */
function formatTime(date: Date, timezone: string): string {
	const formatter = new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: timezone || 'UTC',
	});
	return formatter.format(date);
}

/**
 * Append a message to the user's daily note file.
 * Errors are logged but never thrown — the caller's main flow must continue.
 */
export async function appendDailyNote(
	ctx: MessageContext,
	deps: AppendDailyNoteDeps,
): Promise<void> {
	try {
		const dateStr = toDateString(ctx.timestamp, deps.timezone);
		const time = formatTime(ctx.timestamp, deps.timezone);
		const store = deps.data.forUser(ctx.userId);
		const frontmatter = generateFrontmatter({
			title: `Daily Notes - ${dateStr}`,
			date: dateStr,
			tags: ['pas/daily-note', 'pas/chatbot'],
			type: 'daily-note',
			user: ctx.userId,
			source: 'pas-chatbot',
		});
		await store.append(`daily-notes/${dateStr}.md`, `- [${time}] ${ctx.text}\n`, { frontmatter });
	} catch (error) {
		deps.logger.warn('Failed to append daily note: %s', error);
	}
}
