/**
 * Freezer handler — callback routing and Monday 9am check job.
 *
 * Handles thaw/toss callback button actions and sends weekly reminders
 * for freezer items that have been frozen for 3+ months.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import {
	getAgingFreezerItems,
	loadFreezer,
	removeFreezerItem,
	saveFreezer,
} from '../services/freezer-store.js';
import { appendWaste } from '../services/waste-store.js';
import { todayDate } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

/** Months threshold for the Monday aging reminder. */
const AGING_MONTHS = 3;

/**
 * Route a freezer callback action.
 *
 * Supported actions:
 * - `thaw:<idx>` — remove item from freezer, confirm via editMessage
 * - `toss:<idx>` — remove item from freezer, log waste, confirm via editMessage
 */
export async function handleFreezerCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	const parts = action.split(':');
	const verb = parts[0];
	const index = parseInt(parts[1] ?? '', 10);
	const expectedName = parts.slice(2).join(':');
	const decodedName = expectedName ? decodeURIComponent(expectedName) : undefined;

	if ((verb !== 'thaw' && verb !== 'toss') || isNaN(index)) {
		return;
	}

	const items = await loadFreezer(store);
	const item = items[index];
	if (!item) return;

	// Guard: verify name matches (prevents wrong-item after list mutation)
	if (decodedName && item.name.toLowerCase() !== decodedName.toLowerCase()) {
		await services.telegram.editMessage(chatId, messageId, 'This item was already handled.');
		return;
	}

	const updated = removeFreezerItem(items, index);
	await saveFreezer(store, updated);

	if (verb === 'toss') {
		await appendWaste(store, {
			name: item.name,
			quantity: item.quantity,
			reason: 'discarded',
			source: 'freezer',
			date: todayDate(services.timezone),
		});
		await services.telegram.editMessage(chatId, messageId, `🗑 Tossed: ${item.name}`);
	} else {
		await services.telegram.editMessage(chatId, messageId, `🔥 Thawed: ${item.name}`);
	}
}

/**
 * Monday 9am freezer check job.
 *
 * Loads the household and freezer inventory, finds items frozen for 3+ months,
 * and sends an informational message to every household member.
 */
export async function handleFreezerCheckJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const items = await loadFreezer(sharedStore);
	if (!items.length) return;

	const today = todayOverride ?? todayDate(services.timezone);
	const aging = getAgingFreezerItems(items, AGING_MONTHS, today);
	if (!aging.length) return;

	const lines: string[] = ['🧊 Freezer check — these items have been frozen for 3+ months:\n'];

	for (const item of aging) {
		const [fy, fm] = item.frozenDate.split('-').map(Number) as [number, number, number];
		const [ty, tm] = today.split('-').map(Number) as [number, number, number];
		const months = (ty - fy) * 12 + (tm - fm);
		lines.push(`• ${item.name} — ${months} month${months === 1 ? '' : 's'} (frozen ${item.frozenDate})`);
	}

	lines.push('\nUse /freezer to manage your inventory.');

	const message = lines.join('\n');

	for (const memberId of household.members) {
		await services.telegram.send(memberId, message);
	}
}
