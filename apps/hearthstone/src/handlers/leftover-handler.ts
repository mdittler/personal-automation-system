/**
 * Leftover handler — Telegram orchestration for leftover management.
 *
 * Handles callback button actions (use/freeze/toss/keep/post-meal:no)
 * and the daily 10am check job that auto-wastes expired items and
 * alerts household members about items expiring soon.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { loadFreezer, addFreezerItem, saveFreezer } from '../services/freezer-store.js';
import {
	loadLeftovers,
	saveLeftovers,
	updateLeftoverStatus,
	getActiveLeftovers,
} from '../services/leftover-store.js';
import { appendWaste } from '../services/waste-store.js';
import type { FreezerItem, WasteLogEntry } from '../types.js';
import { todayDate } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

// ─── Callback handler ─────────────────────────────────────────────

/**
 * Route a leftover callback action.
 *
 * Actions:
 * - `use:<idx>` — mark leftover as used
 * - `freeze:<idx>` — mark leftover as frozen, add to freezer
 * - `toss:<idx>` — mark leftover as wasted, append waste log
 * - `keep:<idx>` — acknowledge keeping, no data change
 * - `post-meal:no` — no leftovers from this meal
 */
export async function handleLeftoverCallback(
	services: CoreServices,
	action: string,
	_userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	// Handle the post-meal:no shortcut first (no index parsing needed)
	if (action === 'post-meal:no') {
		await services.telegram.editMessage(chatId, messageId, 'No leftovers — noted!');
		return;
	}

	// Parse "verb:idx:encodedName" format
	const parts = action.split(':');
	const verb = parts[0];
	const idx = parseInt(parts[1] ?? '', 10);
	const expectedName = parts.slice(2).join(':'); // rejoin in case name had colons
	const decodedName = expectedName ? decodeURIComponent(expectedName) : undefined;

	if (!verb || isNaN(idx)) return;

	const items = await loadLeftovers(store);
	const item = items[idx];
	if (!item) return;

	// Guard: verify name matches (prevents wrong-item after list mutation)
	if (decodedName && item.name.toLowerCase() !== decodedName.toLowerCase()) {
		await services.telegram.editMessage(chatId, messageId, 'This leftover was already handled.');
		return;
	}

	// Guard: prevent double-action on non-active items
	if (item.status !== 'active' && verb !== 'keep') {
		await services.telegram.editMessage(chatId, messageId, 'This leftover was already handled.');
		return;
	}

	const today = todayDate(services.timezone);

	switch (verb) {
		case 'use': {
			const updated = updateLeftoverStatus(items, idx, 'used');
			await saveLeftovers(store, updated);
			await services.telegram.editMessage(chatId, messageId, `✅ Used: ${item.name}`);
			break;
		}

		case 'freeze': {
			// Update leftover status
			const updated = updateLeftoverStatus(items, idx, 'frozen');
			await saveLeftovers(store, updated);

			// Add to freezer
			const freezerItem: FreezerItem = {
				name: item.name,
				quantity: item.quantity,
				frozenDate: today,
				source: item.fromRecipe ?? 'leftover',
			};
			const freezer = await loadFreezer(store);
			const updatedFreezer = addFreezerItem(freezer, freezerItem);
			await saveFreezer(store, updatedFreezer);

			await services.telegram.editMessage(chatId, messageId, `🧊 Frozen: ${item.name}`);
			break;
		}

		case 'toss': {
			// Update leftover status
			const updated = updateLeftoverStatus(items, idx, 'wasted');
			await saveLeftovers(store, updated);

			// Append waste log
			const entry: WasteLogEntry = {
				name: item.name,
				quantity: item.quantity,
				reason: 'discarded',
				source: 'leftover',
				date: today,
			};
			await appendWaste(store, entry);

			await services.telegram.editMessage(chatId, messageId, `🗑 Tossed: ${item.name}`);
			break;
		}

		case 'keep': {
			// No data change — just acknowledge
			await services.telegram.editMessage(
				chatId,
				messageId,
				`✅ Got it — keeping ${item.name}`,
			);
			break;
		}

		default:
			break;
	}
}

// ─── Daily check job ──────────────────────────────────────────────

/**
 * Daily 10am leftover check job.
 *
 * 1. Load household from shared store — bail if none.
 * 2. Load leftovers, get active — bail if none.
 * 3. Categorise by expiry: expired (< today), today (=== today), tomorrow (=== today+1).
 * 4. Auto-waste expired items, appending waste log entries.
 * 5. Send alert to all household members if anything to report.
 */
export async function handleLeftoverCheckJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const today = todayOverride ?? todayDate(services.timezone);
	const todayMs = new Date(today).getTime();
	const tomorrowMs = todayMs + 24 * 60 * 60 * 1000;

	const items = await loadLeftovers(sharedStore);
	const active = getActiveLeftovers(items);
	if (!active.length) return;

	// Categorise each active leftover by expiry relative to today
	type IndexedLeftover = { item: (typeof active)[0]; originalIdx: number };
	const expired: IndexedLeftover[] = [];
	const expiringToday: IndexedLeftover[] = [];
	const expiringTomorrow: IndexedLeftover[] = [];

	// Build a map from active item back to original index in `items`
	const originalIndices = new Map<(typeof active)[0], number>();
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item && item.status === 'active') {
			originalIndices.set(item, i);
		}
	}

	for (const item of active) {
		const expiryMs = new Date(item.expiryEstimate).getTime();
		const origIdx = originalIndices.get(item) ?? -1;
		const entry = { item, originalIdx: origIdx };

		if (expiryMs < todayMs) {
			expired.push(entry);
		} else if (expiryMs === todayMs) {
			expiringToday.push(entry);
		} else if (expiryMs === tomorrowMs) {
			expiringTomorrow.push(entry);
		}
	}

	// Nothing to report
	if (!expired.length && !expiringToday.length && !expiringTomorrow.length) return;

	// Auto-waste expired items
	let updatedItems = [...items];
	for (const { item, originalIdx } of expired) {
		updatedItems = updateLeftoverStatus(updatedItems, originalIdx, 'wasted');
		const entry: WasteLogEntry = {
			name: item.name,
			quantity: item.quantity,
			reason: 'expired',
			source: 'leftover',
			date: today,
		};
		await appendWaste(sharedStore, entry);
	}
	if (expired.length) {
		await saveLeftovers(sharedStore, updatedItems);
	}

	// Build alert message
	const lines: string[] = ['🍱 *Leftover Check*\n'];

	if (expired.length) {
		lines.push('❌ *Expired (auto-removed):*');
		for (const { item } of expired) {
			lines.push(`• ${item.name} — ${item.quantity}`);
		}
		lines.push('');
	}

	if (expiringToday.length) {
		lines.push('🔥 *Use today or freeze:*');
		for (const { item } of expiringToday) {
			lines.push(`• ${item.name} — ${item.quantity}`);
		}
		lines.push('');
	}

	if (expiringTomorrow.length) {
		lines.push('⏰ *Expiring tomorrow:*');
		for (const { item } of expiringTomorrow) {
			lines.push(`• ${item.name} — ${item.quantity}`);
		}
	}

	const message = lines.join('\n').trimEnd();

	// Build buttons for expiring items (not expired — those are auto-removed)
	const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

	for (const { item, originalIdx } of expiringToday) {
		const enc = encodeURIComponent(item.name);
		buttons.push([
			{
				text: `🧊 Freeze ${item.name}`,
				callbackData: `app:hearthstone:lo:freeze:${originalIdx}:${enc}`,
			},
			{
				text: `✅ Eat ${item.name}`,
				callbackData: `app:hearthstone:lo:use:${originalIdx}:${enc}`,
			},
			{
				text: `🗑 Toss ${item.name}`,
				callbackData: `app:hearthstone:lo:toss:${originalIdx}:${enc}`,
			},
		]);
	}

	for (const { item, originalIdx } of expiringTomorrow) {
		const enc = encodeURIComponent(item.name);
		buttons.push([
			{
				text: `🧊 Freeze ${item.name}`,
				callbackData: `app:hearthstone:lo:freeze:${originalIdx}:${enc}`,
			},
			{
				text: `✅ Got it`,
				callbackData: `app:hearthstone:lo:keep:${originalIdx}:${enc}`,
			},
		]);
	}

	// Send to all household members
	for (const memberId of household.members) {
		if (buttons.length > 0) {
			await services.telegram.sendWithButtons(memberId, message, buttons);
		} else {
			await services.telegram.send(memberId, message);
		}
	}
}
