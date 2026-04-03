/**
 * Perishable handler — pantry expiry alerts and callback actions.
 *
 * Handles:
 * - Callback actions from perishable alert buttons (freeze, ok, toss)
 * - Daily 9am check job that finds pantry items expiring within 2 days
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { loadFreezer, addFreezerItem, saveFreezer } from '../services/freezer-store.js';
import { loadPantry, savePantry } from '../services/pantry-store.js';
import { appendWaste } from '../services/waste-store.js';
import type { FreezerItem, WasteLogEntry } from '../types.js';
import { todayDate } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Calculate the number of days between two ISO date strings (YYYY-MM-DD).
 * Returns negative if expiryDate is in the past.
 */
function daysUntil(expiryDate: string, today: string): number {
	const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
	const [ey, em, ed] = expiryDate.split('-').map(Number) as [number, number, number];
	const todayMs = Date.UTC(ty, tm - 1, td);
	const expiryMs = Date.UTC(ey, em - 1, ed);
	return Math.round((expiryMs - todayMs) / (1000 * 60 * 60 * 24));
}

/** Build a human-readable urgency string for a given daysLeft value. */
function urgencyText(daysLeft: number): string {
	if (daysLeft <= 0) return 'expires today';
	if (daysLeft === 1) return 'expires tomorrow';
	return `expires in ${daysLeft} days`;
}

// ─── handlePerishableCallback ─────────────────────────────────────────────────

/**
 * Handle perishable alert button callbacks.
 *
 * Action formats (after `app:hearthstone:pa:` prefix is stripped):
 *   freeze:<idx> — move pantry item to freezer
 *   ok:<idx>     — acknowledge, no data change
 *   toss:<idx>   — remove from pantry, log as waste
 *
 * `<idx>` is the index in the PANTRY array at the time the alert was sent.
 */
export async function handlePerishableCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	const colonIdx = action.indexOf(':');
	if (colonIdx === -1) return;

	const verb = action.slice(0, colonIdx);
	const idxStr = action.slice(colonIdx + 1);
	const idx = parseInt(idxStr, 10);

	if (verb === 'ok') {
		await services.telegram.editMessage(chatId, messageId, '👍 Still good — noted!');
		return;
	}

	if (verb === 'freeze') {
		const pantry = await loadPantry(store);
		const item = pantry[idx];
		if (!item) return;

		// Remove from pantry
		const updatedPantry = pantry.filter((_, i) => i !== idx);
		await savePantry(store, updatedPantry);

		// Add to freezer
		const today = todayDate(services.timezone);
		const freezerItem: FreezerItem = {
			name: item.name,
			quantity: item.quantity,
			frozenDate: today,
			source: 'pantry',
		};
		const existingFreezer = await loadFreezer(store);
		const updatedFreezer = addFreezerItem(existingFreezer, freezerItem);
		await saveFreezer(store, updatedFreezer);

		await services.telegram.editMessage(chatId, messageId, `🧊 Moved to freezer: ${item.name}`);
		return;
	}

	if (verb === 'toss') {
		const pantry = await loadPantry(store);
		const item = pantry[idx];
		if (!item) return;

		// Remove from pantry
		const updatedPantry = pantry.filter((_, i) => i !== idx);
		await savePantry(store, updatedPantry);

		// Log waste
		const today = todayDate(services.timezone);
		const wasteEntry: WasteLogEntry = {
			name: item.name,
			quantity: item.quantity,
			reason: 'expired',
			source: 'pantry',
			date: today,
		};
		await appendWaste(store, wasteEntry);

		await services.telegram.editMessage(chatId, messageId, `🗑 Tossed: ${item.name}`);
		return;
	}
}

// ─── handlePerishableCheckJob ─────────────────────────────────────────────────

/**
 * Daily 9am cron job: check pantry for items expiring within 2 days and alert household members.
 *
 * @param todayOverride - ISO date string for testing; defaults to today in server timezone
 */
export async function handlePerishableCheckJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const pantry = await loadPantry(sharedStore);
	if (!pantry.length) return;

	const today = todayOverride ?? todayDate(services.timezone);

	// Find items with expiryEstimate set that are within 2 days (inclusive)
	const expiringItems: Array<{ item: typeof pantry[number]; idx: number; daysLeft: number }> = [];
	for (let i = 0; i < pantry.length; i++) {
		const item = pantry[i]!;
		if (!item.expiryEstimate) continue;
		const daysLeft = daysUntil(item.expiryEstimate, today);
		if (daysLeft <= 2) {
			expiringItems.push({ item, idx: i, daysLeft });
		}
	}

	if (!expiringItems.length) return;

	// Build alert message
	const lines: string[] = ['🥬 Perishable Alert!', ''];
	for (const { item, daysLeft } of expiringItems) {
		lines.push(`• ${item.name} (${item.quantity}) — ${urgencyText(daysLeft)}`);
	}
	const message = lines.join('\n');

	// Build inline buttons — one row per expiring item
	const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
	for (const { item, idx, daysLeft } of expiringItems) {
		const row: Array<{ text: string; callbackData: string }> = [];
		if (daysLeft <= 0) {
			// Expired or expires today: show full action set
			row.push({
				text: `🧊 Freeze: ${item.name}`,
				callbackData: `app:hearthstone:pa:freeze:${idx}`,
			});
			row.push({
				text: `🗑 Toss: ${item.name}`,
				callbackData: `app:hearthstone:pa:toss:${idx}`,
			});
			row.push({
				text: `👍 Still good`,
				callbackData: `app:hearthstone:pa:ok:${idx}`,
			});
		} else {
			// Expiring soon: move to freezer or acknowledge
			row.push({
				text: `🧊 Move to Freezer: ${item.name}`,
				callbackData: `app:hearthstone:pa:freeze:${idx}`,
			});
			row.push({
				text: `👍 Still good`,
				callbackData: `app:hearthstone:pa:ok:${idx}`,
			});
		}
		buttons.push(row);
	}

	// Send to all household members
	for (const memberId of household.members) {
		await services.telegram.sendWithButtons(memberId, message, buttons);
	}
}
