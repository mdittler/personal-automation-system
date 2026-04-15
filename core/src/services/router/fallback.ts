/**
 * Fallback handler for unrecognized messages.
 *
 * When no app matches, the message is timestamped and appended to
 * a daily notes file. No message is silently discarded (URS-RT-005).
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { MessageContext, TelegramService } from '../../types/telegram.js';
import { toDateString } from '../../utils/date.js';
import { appendWithFrontmatter, ensureDir } from '../../utils/file.js';
import { generateFrontmatter } from '../../utils/frontmatter.js';

export interface FallbackOptions {
	dataDir: string;
	logger: Logger;
	/** IANA timezone for formatting timestamps (e.g. 'America/New_York'). */
	timezone: string;
	/**
	 * Optional — when present, routes daily notes to the household layout
	 * (`data/households/<hh>/users/<userId>/daily-notes`). When wired and the
	 * user has no household, falls back to legacy path with a warn log so
	 * messages are never silently discarded (URS-RT-005).
	 * When absent, legacy `data/users/<userId>/daily-notes` is used.
	 */
	householdService?: { getHouseholdForUser(userId: string): string | null };
}

export class FallbackHandler {
	private readonly dataDir: string;
	private readonly logger: Logger;
	private readonly timezone: string;
	private readonly timeFormatter: Intl.DateTimeFormat;
	private readonly householdService?: { getHouseholdForUser(userId: string): string | null };

	constructor(options: FallbackOptions) {
		this.dataDir = options.dataDir;
		this.logger = options.logger;
		this.timezone = options.timezone;
		this.timeFormatter = new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			timeZone: this.timezone,
		});
		this.householdService = options.householdService;
	}

	/**
	 * Resolve the daily-notes directory for a user, household-aware when wired.
	 *
	 * - householdService wired + user has household → `households/<hh>/users/<u>/daily-notes`
	 * - householdService wired + user has no household → logs warn, falls back to legacy
	 *   (fail-soft so messages are never silently discarded, per URS-RT-005)
	 * - householdService absent → legacy `users/<u>/daily-notes`
	 */
	private notesDir(userId: string): string {
		if (this.householdService) {
			const hh = this.householdService.getHouseholdForUser(userId);
			if (hh !== null) {
				return join(this.dataDir, 'households', hh, 'users', userId, 'daily-notes');
			}
			this.logger.warn(
				{ userId },
				'FallbackHandler: user has no household — writing daily note to legacy path',
			);
		}
		return join(this.dataDir, 'users', userId, 'daily-notes');
	}

	/**
	 * Append an unrecognized message to the user's daily notes
	 * and send a brief acknowledgment.
	 */
	async handleUnrecognized(ctx: MessageContext, telegram: TelegramService): Promise<void> {
		const dateStr = toDateString(ctx.timestamp);
		const time = this.timeFormatter.format(ctx.timestamp); // HH:MM in configured timezone
		const notesDir = this.notesDir(ctx.userId);
		const notesPath = join(notesDir, `${dateStr}.md`);

		try {
			await ensureDir(notesDir);
			const frontmatter = generateFrontmatter({
				title: `Daily Notes - ${dateStr}`,
				date: dateStr,
				tags: ['pas/daily-note'],
				type: 'daily-note',
				user: ctx.userId,
				source: 'pas-router',
			});
			await appendWithFrontmatter(notesPath, `- [${time}] ${ctx.text}\n`, frontmatter);

			this.logger.debug(
				{ userId: ctx.userId, path: notesPath },
				'Appended unrecognized message to daily notes',
			);
		} catch (error) {
			this.logger.error(
				{ userId: ctx.userId, error, path: notesPath },
				'Failed to write daily note',
			);
		}

		try {
			await telegram.send(ctx.userId, 'Noted — saved to your daily notes.');
		} catch (error) {
			this.logger.error({ userId: ctx.userId, error }, 'Failed to send fallback acknowledgment');
		}
	}
}
