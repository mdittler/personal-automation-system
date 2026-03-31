/**
 * Command parser for Telegram /commands.
 *
 * Detects messages starting with /, parses command name + arguments,
 * and looks up the owning app in the command map.
 * Pure functions — no side effects.
 */

import type { ManifestCommand } from '../../types/manifest.js';
import type { CommandMapEntry } from '../app-registry/manifest-cache.js';

/** A parsed /command with its arguments. */
export interface ParsedCommand {
	/** The command name including the leading slash (e.g. "/echo"). */
	command: string;
	/** Space-separated argument tokens. */
	args: string[];
	/** Everything after the command, untrimmed. */
	rawArgs: string;
}

/** Result of looking up a parsed command in the command map. */
export interface CommandLookupResult {
	appId: string;
	command: ManifestCommand;
	parsedArgs: string[];
	rawArgs: string;
}

/**
 * Parse a message that starts with /. Returns null if not a command.
 * Handles Telegram's @botname suffix (e.g. "/echo@mybot hello" → "/echo").
 */
export function parseCommand(text: string): ParsedCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith('/')) return null;

	// Split on first space: command part vs arguments
	const spaceIndex = trimmed.indexOf(' ');
	const commandPart = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const rawArgs = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1);

	// Strip @botname suffix from command (e.g. "/echo@mybot" → "/echo")
	const atIndex = commandPart.indexOf('@');
	const command = atIndex === -1 ? commandPart : commandPart.slice(0, atIndex);

	// Validate: command must have at least one character after the slash
	if (command.length < 2) return null;

	// Parse arguments (split on whitespace, filter empty)
	const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];

	return { command, args, rawArgs };
}

/**
 * Look up a parsed command in the command map.
 * Returns null if the command is not registered by any app.
 */
export function lookupCommand(
	parsed: ParsedCommand,
	commandMap: Map<string, CommandMapEntry>,
): CommandLookupResult | null {
	const entry = commandMap.get(parsed.command);
	if (!entry) return null;

	return {
		appId: entry.appId,
		command: entry.command,
		parsedArgs: parsed.args,
		rawArgs: parsed.rawArgs,
	};
}
