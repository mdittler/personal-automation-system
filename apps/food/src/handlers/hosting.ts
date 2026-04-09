/**
 * Hosting handler — /hosting command for event planning and guest profile management.
 */

import type { CoreServices, InlineButton, ScopedDataStore } from '@pas/core/types';
import {
	loadGuests,
	addGuest,
	removeGuest,
	slugifyGuestName,
	formatGuestList,
} from '../services/guest-profiles.js';
import { planEvent, formatEventPlan } from '../services/hosting-planner.js';
import { loadAllRecipes } from '../services/recipe-store.js';
import { loadPantry } from '../services/pantry-store.js';
import { sanitizeInput } from '../utils/sanitize.js';
import type { GuestProfile } from '../types.js';

// ─── Intent Detection ─────────────────────────────────────────────────────────

const HOSTING_KEYWORDS = /\b(hosting|host|dinner party|having.*over|guests? coming|entertain)\b/i;
const HOSTING_PLAN = /\b(plan|menu|cook for|having \d+|invite)\b/i;

export function isHostingIntent(text: string): boolean {
	const lower = text.toLowerCase();
	if (HOSTING_KEYWORDS.test(lower)) return true;
	return /\bhaving\b.*\b(friends|people|guests|family)\b.*\b(over|dinner|for)\b/i.test(lower);
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

export interface GuestAddArgs {
	dietaryRestrictions: string[];
	allergies: string[];
	notes?: string;
}

/**
 * Parse the argument tail after the guest name for `/hosting guests add`.
 *
 * Supports flagged syntax: --diet a,b,c / --allergy x,y / --notes free text.
 * Notes absorbs everything until the next flag or end of args.
 * Backwards compatibility: if no flags appear, all args are treated as dietaryRestrictions.
 */
export function parseGuestAddArgs(tail: string[]): GuestAddArgs {
	const result: GuestAddArgs = { dietaryRestrictions: [], allergies: [] };
	if (tail.length === 0) return result;

	const flagAliases: Record<string, 'diet' | 'allergy' | 'notes'> = {
		'--diet': 'diet',
		'-d': 'diet',
		'--allergy': 'allergy',
		'--allergies': 'allergy',
		'-a': 'allergy',
		'--notes': 'notes',
		'--note': 'notes',
		'-n': 'notes',
	};

	// Normalize flag tokens to lowercase so `--DIET` or `--Notes`
	// still route correctly. Non-flag tokens stay case-preserved so
	// names like "Gluten-Free" survive untouched.
	const hasFlags = tail.some(t => t.toLowerCase() in flagAliases);
	if (!hasFlags) {
		// Legacy form — everything is a dietary restriction.
		result.dietaryRestrictions = tail.filter(t => t.length > 0);
		return result;
	}

	let currentFlag: 'diet' | 'allergy' | 'notes' | null = null;
	const buckets: Record<'diet' | 'allergy' | 'notes', string[]> = { diet: [], allergy: [], notes: [] };

	for (const tok of tail) {
		const lower = tok.toLowerCase();
		if (lower in flagAliases) {
			currentFlag = flagAliases[lower]!;
			continue;
		}
		if (currentFlag === null) continue; // skip stray tokens before first flag
		buckets[currentFlag].push(tok);
	}

	const splitCsv = (parts: string[]): string[] =>
		parts.flatMap(p => p.split(',')).map(s => s.trim()).filter(s => s.length > 0);

	result.dietaryRestrictions = splitCsv(buckets.diet);
	result.allergies = splitCsv(buckets.allergy);
	// Defensive sanitization: guest notes are not currently
	// prompt-adjacent, but hosting-planner has historically fed guest
	// data through the LLM for menu planning and the boundary could
	// regress. Neutralizing backticks here closes the latent injection
	// surface regardless of future callers.
	const notes = sanitizeInput(buckets.notes.join(' ').trim(), 500);
	if (notes) result.notes = notes;

	return result;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleHostingCommand(
	services: CoreServices,
	args: string[],
	userId: string,
	sharedStore: ScopedDataStore,
): Promise<void> {
	const subCommand = args[0]?.toLowerCase();

	try {
		if (!subCommand) {
			const menuButtons: InlineButton[][] = [
				[{ text: '👥 Guest Profiles', callbackData: 'app:food:host:guests' }],
				[{ text: '➕ Add Guest', callbackData: 'app:food:host:gadd' }],
			];
			await services.telegram.sendWithButtons(userId,
				'**Hosting**\nPlan an event with `/hosting plan <description>`\n' +
				'Example: "dinner for 6 Saturday at 7pm, Sarah is vegetarian"',
				menuButtons);
			return;
		}

		if (subCommand === 'guests') {
			const action = args[1]?.toLowerCase();

			if (action === 'add') {
				const name = args[2];
				if (!name) {
					await services.telegram.send(userId,
						'Usage: `/hosting guests add <name> [--diet a,b] [--allergy x,y] [--notes text]`');
					return;
				}
				const parsed = parseGuestAddArgs(args.slice(3));
				const now = new Date().toISOString();
				const guest: GuestProfile = {
					name,
					slug: slugifyGuestName(name),
					dietaryRestrictions: parsed.dietaryRestrictions,
					allergies: parsed.allergies,
					...(parsed.notes ? { notes: parsed.notes } : {}),
					createdAt: now,
					updatedAt: now,
				};
				await addGuest(sharedStore, guest);

				const parts: string[] = [];
				if (parsed.dietaryRestrictions.length > 0) parts.push(`diet: ${parsed.dietaryRestrictions.join(', ')}`);
				if (parsed.allergies.length > 0) parts.push(`allergies: ${parsed.allergies.join(', ')}`);
				if (parsed.notes) parts.push(`notes: ${parsed.notes}`);
				await services.telegram.send(userId,
					`Added guest profile: **${name}**${parts.length > 0 ? ` (${parts.join(' • ')})` : ''}`);
				return;
			}

			if (action === 'remove') {
				const name = args[2];
				if (!name) {
					// Show guest selection buttons for removal
					const guests = await loadGuests(sharedStore);
					if (guests.length === 0) {
						await services.telegram.send(userId, 'No guest profiles to remove.');
						return;
					}
					const buttons: InlineButton[][] = guests.map(g => ([
						{ text: `❌ ${g.name}`, callbackData: `app:food:host:grem:${g.slug}` },
					]));
					await services.telegram.sendWithButtons(userId, 'Select a guest to remove:', buttons);
					return;
				}
				const removed = await removeGuest(sharedStore, slugifyGuestName(name));
				if (removed) {
					await services.telegram.send(userId, `Removed guest: **${name}**`);
				} else {
					await services.telegram.send(userId, `Guest "${name}" not found.`);
				}
				return;
			}

			// Default: list guests
			const guests = await loadGuests(sharedStore);
			await services.telegram.send(userId, formatGuestList(guests));
			return;
		}

		if (subCommand === 'plan') {
			const description = args.slice(1).join(' ');
			if (!description) {
				await services.telegram.send(userId, 'Usage: `/hosting plan <event description>`\nExample: "6 adults and 2 kids over Saturday at 6pm"');
				return;
			}

			const guests = await loadGuests(sharedStore);
			const recipes = await loadAllRecipes(sharedStore);
			const pantry = await loadPantry(sharedStore);

			const plan = await planEvent(services, description, guests, recipes, pantry);
			const message = formatEventPlan(plan);
			await services.telegram.send(userId, message);
			return;
		}

		// Unknown subcommand
		await services.telegram.send(userId, 'Unknown hosting command. Try `/hosting` for help.');
	} catch (err) {
		services.logger.error('handleHostingCommand failed', err);
		await services.telegram.send(userId, 'Unable to process hosting command. Please try again.');
	}
}
