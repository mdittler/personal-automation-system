/**
 * Guided "add guest" flow — H11.y Task 2.
 *
 * Walks the user through name → diet restrictions (multi-select toggle) →
 * allergies (multi-select toggle) → notes → confirm. Maintains an in-process
 * state map keyed by userId with a 10-minute TTL.
 *
 * Entry: beginGuestAddFlow() — invoked from index.ts when host:gadd button is tapped.
 * Text replies: handleGuestAddReply() — invoked from index.ts handleMessage
 *   when hasPendingGuestAdd(userId) returns true.
 * Callbacks: handleGuestAddCallback() — invoked from index.ts handleCallbackQuery
 *   when data starts with `app:food:host:gadd:`.
 */

import type { CoreServices, ScopedDataStore, SentMessage } from '@pas/core/types';
import { addGuest, slugifyGuestName } from '../services/guest-profiles.js';
import { sanitizeInput } from '../utils/sanitize.js';
import { escapeMarkdown } from '../utils/escape-markdown.js';
import type { GuestProfile } from '../types.js';

type GuestAddStep =
	| 'awaiting_name'
	| 'awaiting_diet'
	| 'awaiting_allergy'
	| 'awaiting_notes'
	| 'awaiting_confirm';

interface PendingGuestAdd {
	step: GuestAddStep;
	name?: string;
	dietaryRestrictions: string[];
	allergies: string[];
	notes?: string;
	awaitingCustomInput?: boolean;
	sentMessage?: SentMessage;
	expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min
const pending = new Map<string, PendingGuestAdd>();

function touch(userId: string, state: PendingGuestAdd): void {
	state.expiresAt = Date.now() + PENDING_TTL_MS;
	pending.set(userId, state);
	// Time-based sweep — never evict another user's still-valid flow.
	if (pending.size > 100) {
		const now = Date.now();
		for (const [k, v] of pending) {
			if (v.expiresAt < now) pending.delete(k);
		}
	}
}

function cleanupExpired(userId: string): PendingGuestAdd | undefined {
	const entry = pending.get(userId);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		pending.delete(userId);
		return undefined;
	}
	return entry;
}

export function hasPendingGuestAdd(userId: string): boolean {
	return cleanupExpired(userId) !== undefined;
}

// ─── Diet preset options ──────────────────────────────────────────────────────

const DIET_OPTIONS: Array<{ label: string; value: string }> = [
	{ label: 'Vegetarian', value: 'vegetarian' },
	{ label: 'Vegan', value: 'vegan' },
	{ label: 'Gluten-free', value: 'gluten-free' },
	{ label: 'Dairy-free', value: 'dairy-free' },
];

const ALLERGY_OPTIONS: Array<{ label: string; value: string }> = [
	{ label: 'Peanuts', value: 'peanuts' },
	{ label: 'Tree nuts', value: 'tree nuts' },
	{ label: 'Shellfish', value: 'shellfish' },
	{ label: 'Eggs', value: 'eggs' },
	{ label: 'Dairy', value: 'dairy' },
];

function buildDietButtons(
	selected: string[],
): Array<Array<{ text: string; callbackData: string }>> {
	const row1 = [
		{
			text: (selected.includes('vegetarian') ? '✓ ' : '') + 'Vegetarian',
			callbackData: 'app:food:host:gadd:diet:vegetarian',
		},
		{
			text: (selected.includes('vegan') ? '✓ ' : '') + 'Vegan',
			callbackData: 'app:food:host:gadd:diet:vegan',
		},
	];
	const row2 = [
		{
			text: (selected.includes('gluten-free') ? '✓ ' : '') + 'Gluten-free',
			callbackData: 'app:food:host:gadd:diet:gluten-free',
		},
		{
			text: (selected.includes('dairy-free') ? '✓ ' : '') + 'Dairy-free',
			callbackData: 'app:food:host:gadd:diet:dairy-free',
		},
	];
	const row3 = [
		{ text: 'Type my own', callbackData: 'app:food:host:gadd:diet:custom' },
		{ text: 'None', callbackData: 'app:food:host:gadd:diet:none' },
	];
	const row4 = [{ text: 'Done', callbackData: 'app:food:host:gadd:diet:done' }];
	return [row1, row2, row3, row4];
}

function buildAllergyButtons(
	selected: string[],
): Array<Array<{ text: string; callbackData: string }>> {
	const row1 = [
		{
			text: (selected.includes('peanuts') ? '✓ ' : '') + 'Peanuts',
			callbackData: 'app:food:host:gadd:allergy:peanuts',
		},
		{
			text: (selected.includes('tree nuts') ? '✓ ' : '') + 'Tree nuts',
			callbackData: 'app:food:host:gadd:allergy:tree nuts',
		},
	];
	const row2 = [
		{
			text: (selected.includes('shellfish') ? '✓ ' : '') + 'Shellfish',
			callbackData: 'app:food:host:gadd:allergy:shellfish',
		},
		{
			text: (selected.includes('eggs') ? '✓ ' : '') + 'Eggs',
			callbackData: 'app:food:host:gadd:allergy:eggs',
		},
	];
	const row3 = [
		{
			text: (selected.includes('dairy') ? '✓ ' : '') + 'Dairy',
			callbackData: 'app:food:host:gadd:allergy:dairy',
		},
	];
	const row4 = [
		{ text: 'Type my own', callbackData: 'app:food:host:gadd:allergy:custom' },
		{ text: 'None', callbackData: 'app:food:host:gadd:allergy:none' },
	];
	const row5 = [{ text: 'Done', callbackData: 'app:food:host:gadd:allergy:done' }];
	return [row1, row2, row3, row4, row5];
}

async function sendDietPicker(
	services: CoreServices,
	userId: string,
	state: PendingGuestAdd,
): Promise<void> {
	const buttons = buildDietButtons(state.dietaryRestrictions);
	const selected = state.dietaryRestrictions;
	const selText =
		selected.length > 0 ? `Selected: ${selected.join(', ')}` : 'None selected';
	const sent = await services.telegram.sendWithButtons(
		userId,
		`**Add guest: ${escapeMarkdown(state.name ?? '')}**\n\nDietary restrictions:\n${selText}`,
		buttons,
	);
	state.sentMessage = sent;
}

async function sendAllergyPicker(
	services: CoreServices,
	userId: string,
	state: PendingGuestAdd,
): Promise<void> {
	const buttons = buildAllergyButtons(state.allergies);
	const selected = state.allergies;
	const selText = selected.length > 0 ? `Selected: ${selected.join(', ')}` : 'None selected';
	const sent = await services.telegram.sendWithButtons(
		userId,
		`**Add guest: ${escapeMarkdown(state.name ?? '')}**\n\nAllergies:\n${selText}`,
		buttons,
	);
	state.sentMessage = sent;
}

async function sendNotesStep(services: CoreServices, userId: string): Promise<void> {
	await services.telegram.sendWithButtons(
		userId,
		"Any notes about this guest? (e.g. 'loves wine', 'prefers lighter meals')\nTap Skip or reply with a note:",
		[[{ text: 'Skip', callbackData: 'app:food:host:gadd:notes:skip' }]],
	);
}

async function sendConfirmStep(
	services: CoreServices,
	userId: string,
	state: PendingGuestAdd,
): Promise<void> {
	const diet =
		state.dietaryRestrictions.length > 0 ? state.dietaryRestrictions.join(', ') : 'none';
	const allergies = state.allergies.length > 0 ? state.allergies.join(', ') : 'none';
	const lines = [
		`**New guest: ${escapeMarkdown(state.name ?? '')}**`,
		`Diet: ${diet}`,
		`Allergies: ${allergies}`,
	];
	if (state.notes) {
		lines.push(`Notes: ${escapeMarkdown(state.notes)}`);
	}
	await services.telegram.sendWithButtons(userId, lines.join('\n'), [
		[
			{ text: 'Save', callbackData: 'app:food:host:gadd:confirm:save' },
			{ text: 'Cancel', callbackData: 'app:food:host:gadd:confirm:cancel' },
		],
	]);
}

/** Entry point — seeds state and prompts for guest name. */
export async function beginGuestAddFlow(
	services: CoreServices,
	userId: string,
): Promise<void> {
	touch(userId, {
		step: 'awaiting_name',
		dietaryRestrictions: [],
		allergies: [],
		expiresAt: 0,
	});
	await services.telegram.send(userId, '**Add guest**\n\nWhat\'s their name?');
}

/**
 * Text-reply handler. Called from index.ts `handleMessage` when
 * `hasPendingGuestAdd(userId)` is true. Returns true if it consumed the message.
 */
export async function handleGuestAddReply(
	services: CoreServices,
	sharedStore: ScopedDataStore,
	userId: string,
	text: string,
): Promise<boolean> {
	const state = cleanupExpired(userId);
	if (!state) return false;

	// Name step: captures name and advances to diet picker
	if (state.step === 'awaiting_name') {
		if (text.trim().toLowerCase() === 'cancel') {
			pending.delete(userId);
			await services.telegram.send(userId, 'Cancelled.');
			return true;
		}
		const name = sanitizeInput(text.trim(), 100);
		if (!name) {
			await services.telegram.send(
				userId,
				"Name cannot be empty. What's their name? (Or reply \"cancel\" to abort.)",
			);
			return true;
		}
		state.name = name;
		state.step = 'awaiting_diet';
		touch(userId, state);
		await sendDietPicker(services, userId, state);
		touch(userId, state); // update sentMessage reference
		return true;
	}

	// Custom diet/allergy input
	if (state.awaitingCustomInput) {
		if (text.trim().toLowerCase() === 'cancel') {
			state.awaitingCustomInput = false;
			touch(userId, state);
			// Re-send the picker for the current step
			if (state.step === 'awaiting_diet') {
				await sendDietPicker(services, userId, state);
				touch(userId, state);
			} else if (state.step === 'awaiting_allergy') {
				await sendAllergyPicker(services, userId, state);
				touch(userId, state);
			}
			return true;
		}
		// Parse comma-separated values, trim and filter empty, apply sanitizeInput
		const items = text
			.split(',')
			.map((v) => sanitizeInput(v.trim(), 100))
			.filter((v) => v.length > 0);

		if (state.step === 'awaiting_diet') {
			for (const item of items) {
				if (!state.dietaryRestrictions.includes(item)) {
					state.dietaryRestrictions.push(item);
				}
			}
			state.awaitingCustomInput = false;
			state.step = 'awaiting_allergy';
			touch(userId, state);
			await sendAllergyPicker(services, userId, state);
			touch(userId, state);
		} else if (state.step === 'awaiting_allergy') {
			for (const item of items) {
				if (!state.allergies.includes(item)) {
					state.allergies.push(item);
				}
			}
			state.awaitingCustomInput = false;
			state.step = 'awaiting_notes';
			touch(userId, state);
			await sendNotesStep(services, userId);
		}
		return true;
	}

	// Notes step: text reply captures notes
	if (state.step === 'awaiting_notes') {
		if (text.trim().toLowerCase() === 'cancel') {
			pending.delete(userId);
			await services.telegram.send(userId, 'Cancelled.');
			return true;
		}
		state.notes = sanitizeInput(text.trim(), 500);
		state.step = 'awaiting_confirm';
		touch(userId, state);
		await sendConfirmStep(services, userId, state);
		return true;
	}

	// Any other step — unexpected text (waiting for a button press)
	return false;
}

/**
 * Callback-query handler. Called from index.ts `handleCallbackQuery` when
 * data starts with `app:food:host:gadd:`. Returns true if it consumed the callback.
 * chatId and messageId come from the CallbackContext in index.ts.
 */
export async function handleGuestAddCallback(
	services: CoreServices,
	sharedStore: ScopedDataStore,
	userId: string,
	data: string,
	chatId: number,
	messageId: number,
): Promise<boolean> {
	// Cancel at any step
	if (data === 'app:food:host:gadd:cancel') {
		pending.delete(userId);
		await services.telegram.send(userId, 'Cancelled.');
		return true;
	}

	const state = cleanupExpired(userId);
	if (!state) {
		await services.telegram.send(
			userId,
			'Your guest add flow has expired. Start over with the Add Guest button.',
		);
		return true;
	}

	// ─── Diet toggles ─────────────────────────────────────────────────────────

	if (state.step === 'awaiting_diet') {
		// Toggle a diet preset
		const dietOptionMatch = data.match(/^app:food:host:gadd:diet:(.+)$/);
		if (!dietOptionMatch) return false;
		const action = dietOptionMatch[1]!;

		if (action === 'none') {
			state.dietaryRestrictions = [];
			state.step = 'awaiting_allergy';
			touch(userId, state);
			await sendAllergyPicker(services, userId, state);
			touch(userId, state);
			return true;
		}

		if (action === 'done') {
			state.step = 'awaiting_allergy';
			touch(userId, state);
			await sendAllergyPicker(services, userId, state);
			touch(userId, state);
			return true;
		}

		if (action === 'custom') {
			state.awaitingCustomInput = true;
			touch(userId, state);
			await services.telegram.send(
				userId,
				"Reply with your dietary restriction (comma-separated for multiple, or 'cancel'):",
			);
			return true;
		}

		// It's a preset option toggle
		const isDietOption = DIET_OPTIONS.some((o) => o.value === action);
		if (isDietOption) {
			const idx = state.dietaryRestrictions.indexOf(action);
			if (idx === -1) {
				state.dietaryRestrictions.push(action);
			} else {
				state.dietaryRestrictions.splice(idx, 1);
			}
			touch(userId, state);
			// Edit the message in place with updated buttons
			const updatedButtons = buildDietButtons(state.dietaryRestrictions);
			const selected = state.dietaryRestrictions;
			const selText =
				selected.length > 0 ? `Selected: ${selected.join(', ')}` : 'None selected';
			const sm = state.sentMessage ?? { chatId, messageId };
			await services.telegram.editMessage(
				sm.chatId,
				sm.messageId,
				`**Add guest: ${escapeMarkdown(state.name ?? '')}**\n\nDietary restrictions:\n${selText}`,
				updatedButtons,
			);
			return true;
		}

		return false;
	}

	// ─── Allergy toggles ──────────────────────────────────────────────────────

	if (state.step === 'awaiting_allergy') {
		const allergyOptionMatch = data.match(/^app:food:host:gadd:allergy:(.+)$/);
		if (!allergyOptionMatch) return false;
		const action = allergyOptionMatch[1]!;

		if (action === 'none') {
			state.allergies = [];
			state.step = 'awaiting_notes';
			touch(userId, state);
			await sendNotesStep(services, userId);
			return true;
		}

		if (action === 'done') {
			state.step = 'awaiting_notes';
			touch(userId, state);
			await sendNotesStep(services, userId);
			return true;
		}

		if (action === 'custom') {
			state.awaitingCustomInput = true;
			touch(userId, state);
			await services.telegram.send(
				userId,
				"Reply with your allergy restriction (comma-separated for multiple, or 'cancel'):",
			);
			return true;
		}

		// It's a preset option toggle — the value may have spaces (e.g. "tree nuts")
		const isAllergyOption = ALLERGY_OPTIONS.some((o) => o.value === action);
		if (isAllergyOption) {
			const idx = state.allergies.indexOf(action);
			if (idx === -1) {
				state.allergies.push(action);
			} else {
				state.allergies.splice(idx, 1);
			}
			touch(userId, state);
			// Edit the message in place with updated buttons
			const updatedButtons = buildAllergyButtons(state.allergies);
			const selected = state.allergies;
			const selText =
				selected.length > 0 ? `Selected: ${selected.join(', ')}` : 'None selected';
			const sm = state.sentMessage ?? { chatId, messageId };
			await services.telegram.editMessage(
				sm.chatId,
				sm.messageId,
				`**Add guest: ${escapeMarkdown(state.name ?? '')}**\n\nAllergies:\n${selText}`,
				updatedButtons,
			);
			return true;
		}

		return false;
	}

	// ─── Notes skip ───────────────────────────────────────────────────────────

	if (data === 'app:food:host:gadd:notes:skip' && state.step === 'awaiting_notes') {
		state.notes = undefined;
		state.step = 'awaiting_confirm';
		touch(userId, state);
		await sendConfirmStep(services, userId, state);
		return true;
	}

	// ─── Confirm ──────────────────────────────────────────────────────────────

	if (data === 'app:food:host:gadd:confirm:save' && state.step === 'awaiting_confirm') {
		try {
			const now = new Date().toISOString();
			const guest: GuestProfile = {
				name: state.name!,
				slug: slugifyGuestName(state.name!),
				dietaryRestrictions: state.dietaryRestrictions,
				allergies: state.allergies,
				...(state.notes ? { notes: state.notes } : {}),
				createdAt: now,
				updatedAt: now,
			};
			await addGuest(sharedStore, guest);
			pending.delete(userId);
			await services.telegram.send(
				userId,
				`Added guest: **${escapeMarkdown(state.name!)}**`,
			);
		} catch (err) {
			pending.delete(userId);
			await services.telegram.send(
				userId,
				`Could not save guest: ${(err as Error).message}`,
			);
		}
		return true;
	}

	if (data === 'app:food:host:gadd:confirm:cancel') {
		pending.delete(userId);
		await services.telegram.send(userId, 'Cancelled — not saved.');
		return true;
	}

	return false;
}

/** Test-only — clears the in-process state map. */
export function __resetGuestAddFlowForTests(): void {
	pending.clear();
}
