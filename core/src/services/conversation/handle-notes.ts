/**
 * /notes built-in command handler.
 *
 * Subcommands:
 *   /notes           → status (same as /notes status)
 *   /notes status    → show current effective setting
 *   /notes on        → enable daily-notes logging for this user
 *   /notes off       → disable daily-notes logging for this user
 *   anything else    → usage message (no write)
 */

import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import type { MessageContext, TelegramService } from '../../types/telegram.js';
import { resolveUserBool } from './settings-resolver.js';

export interface HandleNotesDeps {
	telegram: TelegramService;
	config: AppConfigService;
	logger: AppLogger;
	systemDefault: boolean;
}

const USAGE =
	'Usage:\n  /notes on     — enable daily notes logging\n  /notes off    — disable daily notes logging\n  /notes status — show current setting';

export async function handleNotes(
	args: string[],
	ctx: MessageContext,
	deps: HandleNotesDeps,
): Promise<void> {
	const { telegram, config, logger, systemDefault } = deps;
	const subcommand = (args[0] ?? '').trim().toLowerCase();

	if (subcommand === '' || subcommand === 'status') {
		// Show current effective state
		const enabled = await resolveUserBool(config, ctx.userId, 'log_to_notes', systemDefault, logger);
		const state = enabled ? 'ON' : 'OFF';
		await telegram.send(
			ctx.userId,
			`Daily notes logging is currently ${state} for you. Use /notes on or /notes off to change.`,
		);
		return;
	}

	if (subcommand === 'on' || subcommand === 'off') {
		const newValue = subcommand === 'on';
		try {
			await config.updateOverrides(ctx.userId, { log_to_notes: newValue });
			const state = newValue ? 'ON' : 'OFF';
			await telegram.send(ctx.userId, `Daily notes logging turned ${state}.`);
		} catch (err) {
			logger.warn('handleNotes: updateOverrides failed: %s', err);
			await telegram.send(ctx.userId, "Couldn't update setting. Please try again.");
		}
		return;
	}

	// Unknown subcommand
	await telegram.send(ctx.userId, USAGE);
}
