/**
 * Daily-note append helper.
 *
 * Appending is per-user opt-in (default OFF). The effective setting is
 * resolved from raw user overrides so the system-level default can be
 * overridden independently of the manifest default.
 */

import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import type { DataStoreService } from '../../types/data-store.js';
import type { MessageContext } from '../../types/telegram.js';
import { generateFrontmatter } from '../../utils/frontmatter.js';
import { resolveUserBool } from './settings-resolver.js';

export interface AppendDailyNoteDeps {
	data: DataStoreService;
	logger: AppLogger;
	timezone: string;
	/** When provided, the opt-in setting is read from raw user overrides. */
	config?: AppConfigService;
	/** System-level default when no per-user override exists. Default: false. */
	systemDefault?: boolean;
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
 * Returns { wrote: true } when the note was successfully appended,
 * { wrote: false } when the user has opted out or an error occurred.
 * Errors are logged but never thrown — the caller's main flow must continue.
 */
export async function appendDailyNote(
	ctx: MessageContext,
	deps: AppendDailyNoteDeps,
): Promise<{ wrote: boolean }> {
	const systemDefault = deps.systemDefault ?? false;
	const enabled = deps.config
		? await resolveUserBool(deps.config, ctx.userId, 'log_to_notes', systemDefault, deps.logger)
		: systemDefault;
	if (!enabled) return { wrote: false };

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
		return { wrote: true };
	} catch (error) {
		deps.logger.warn('Failed to append daily note: %s', error);
		return { wrote: false };
	}
}
