/**
 * Shopping follow-up handler for Food grocery list.
 *
 * Manages timed follow-up messages after grocery list clear operations.
 * After a clear, schedules a 1-hour follow-up checking if remaining
 * items should be kept or archived.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { archivePurchased, loadGroceryList, saveGroceryList, withGroceryLock } from '../services/grocery-store.js';
import type { GroceryItem, GroceryList, Household } from '../types.js';
import { loadHousehold } from '../utils/household-guard.js';
import { emitShoppingCompleted } from '../events/emitters.js';
import { isoNow } from '../utils/date.js';

// Node timer globals — not in ES2024 lib, so we declare them here.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;

// ─── Constants ────────────────────────────────────────────────────────────────

export const FOLLOWUP_DELAY_MS = 60 * 60 * 1000; // 1 hour

// ─── Module-level state ───────────────────────────────────────────────────────
// Note: single pending slot — if member B clears while member A's timer is
// pending, B's follow-up replaces A's. Acceptable for single-household PAS.

interface PendingFollowup {
	userId: string;
	remainingCount: number;
}

let pendingFollowup: PendingFollowup | null = null;
let followupTimer: unknown = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Schedule a shopping follow-up message.
 * Cancels any pending follow-up first, then sets a new 1-hour timer.
 */
export function scheduleShoppingFollowup(
	services: CoreServices,
	userId: string,
	remainingCount: number,
): void {
	cancelShoppingFollowup();

	pendingFollowup = { userId, remainingCount };
	followupTimer = setTimeout(() => {
		void handleShoppingFollowupJob(services);
	}, FOLLOWUP_DELAY_MS);

	services.logger.info(
		`[food] Shopping follow-up scheduled in 1 hour (userId=${userId}, remainingCount=${remainingCount})`,
	);
}

/**
 * Cancel any pending shopping follow-up.
 */
export function cancelShoppingFollowup(): void {
	if (followupTimer !== null) {
		clearTimeout(followupTimer);
		followupTimer = null;
	}
	pendingFollowup = null;
}

/**
 * Handle the follow-up when the timer fires.
 * Sends a message listing remaining items with options to clear or keep.
 */
export async function handleShoppingFollowupJob(services: CoreServices): Promise<void> {
	const pending = pendingFollowup;
	pendingFollowup = null;
	followupTimer = null;

	if (!pending) return;

	const { userId } = pending;

	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const list = await loadGroceryList(sharedStore);
	if (!list) return;

	const remaining = list.items.filter((i: GroceryItem) => !i.purchased);
	if (remaining.length === 0) return;

	const count = remaining.length;
	const maxShow = 10;
	const shown = remaining.slice(0, maxShow);
	const extra = count - shown.length;

	const lines: string[] = [`🛒 You still have ${count} item${count === 1 ? '' : 's'} on your grocery list:\n`];
	for (const item of shown) {
		lines.push(`• ${item.name}`);
	}
	if (extra > 0) {
		lines.push(`...and ${extra} more`);
	}
	lines.push('\nDone shopping?');

	const message = lines.join('\n');
	const buttons = [
		[
			{ text: '🗑 Clear remaining', callbackData: 'app:food:shop-followup:clear' },
			{ text: '📋 Keep for next trip', callbackData: 'app:food:shop-followup:keep' },
		],
	];

	await services.telegram.sendWithButtons(userId, message, buttons);
}

/**
 * Handle "shop-followup:clear" — archive remaining items, empty list.
 */
export async function handleShopFollowupClearCallback(
	services: CoreServices,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const result = await withGroceryLock(async () => {
		const list = await loadGroceryList(sharedStore);
		if (!list) return null;

		const remaining = list.items.filter((i: GroceryItem) => !i.purchased);
		const count = remaining.length;
		const totalItems = list.items.length;

		await archivePurchased(sharedStore, remaining, services.timezone);
		await saveGroceryList(sharedStore, { ...list, items: [] } as GroceryList);
		return { listId: list.id, count, totalItems };
	});

	if (!result) {
		await services.telegram.editMessage(chatId, messageId, '🗑 Grocery list is already empty.');
		return;
	}

	// Emit shopping-completed after successful save
	const household = await loadHousehold(sharedStore);
	await emitShoppingCompleted(services, {
		listId: result.listId,
		householdId: household?.id ?? 'shared',
		itemsPurchased: result.totalItems,
		completedAt: isoNow(),
	});

	await services.telegram.editMessage(
		chatId,
		messageId,
		`🗑 Cleared ${result.count} remaining item${result.count === 1 ? '' : 's'}. Grocery list is now empty.`,
	);
}

/**
 * Handle "shop-followup:keep" — dismiss follow-up, keep items.
 */
export async function handleShopFollowupKeepCallback(
	services: CoreServices,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	await services.telegram.editMessage(
		chatId,
		messageId,
		'📋 Keeping items on your grocery list for next trip.',
	);
}
