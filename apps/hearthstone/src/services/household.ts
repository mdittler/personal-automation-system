/**
 * Household service — create, join, and manage household membership.
 *
 * Household data is stored in shared scope: data/users/shared/hearthstone/household.yaml
 */

import type { CoreServices } from '@pas/core/types';
import type { Household } from '../types.js';
import { generateId, isoNow } from '../utils/date.js';
import { JOIN_CODE_PATTERN, generateJoinCode, loadHousehold, saveHousehold } from '../utils/household-guard.js';

export interface HouseholdResult {
	success: boolean;
	message: string;
	household?: Household;
}

/**
 * Create a new household. The creating user becomes the first member.
 */
export async function createHousehold(
	services: CoreServices,
	userId: string,
	name: string,
): Promise<HouseholdResult> {
	const store = services.data.forShared('shared');
	const existing = await loadHousehold(store);

	if (existing) {
		if (existing.members.includes(userId)) {
			return {
				success: false,
				message: `You're already in household "${existing.name}". Use /household leave first.`,
			};
		}
		return {
			success: false,
			message: 'A household already exists. Ask a member for the join code.',
		};
	}

	const clampedName = (name || 'My Household').slice(0, 100);

	const household: Household = {
		id: generateId(),
		name: clampedName,
		createdBy: userId,
		members: [userId],
		joinCode: generateJoinCode(),
		createdAt: isoNow(),
	};

	await saveHousehold(store, household);
	services.logger.info('Household created by %s: %s', userId, household.name);

	return {
		success: true,
		message: `Household "${household.name}" created! Share this join code with your family: **${household.joinCode}**`,
		household,
	};
}

/**
 * Join an existing household using a join code.
 */
export async function joinHousehold(
	services: CoreServices,
	userId: string,
	code: string,
): Promise<HouseholdResult> {
	const store = services.data.forShared('shared');
	const household = await loadHousehold(store);

	if (!household) {
		return {
			success: false,
			message: 'No household exists yet. Create one with /household create.',
		};
	}

	if (household.members.includes(userId)) {
		return {
			success: false,
			message: `You're already a member of "${household.name}".`,
		};
	}

	const normalizedCode = code.toUpperCase().trim();
	if (!JOIN_CODE_PATTERN.test(normalizedCode)) {
		return {
			success: false,
			message: 'Invalid code format. Join codes are 6 characters (letters and numbers).',
		};
	}

	if (household.joinCode !== normalizedCode) {
		return {
			success: false,
			message: 'Invalid join code. Ask a household member for the correct code.',
		};
	}

	household.members.push(userId);
	await saveHousehold(store, household);
	services.logger.info('User %s joined household %s', userId, household.name);

	return {
		success: true,
		message: `Welcome to "${household.name}"! You now share recipes, meal plans, and grocery lists with the household.`,
		household,
	};
}

/**
 * Leave a household. The creator cannot leave (must delete instead).
 */
export async function leaveHousehold(
	services: CoreServices,
	userId: string,
): Promise<HouseholdResult> {
	const store = services.data.forShared('shared');
	const household = await loadHousehold(store);

	if (!household) {
		return { success: false, message: 'No household exists.' };
	}

	if (!household.members.includes(userId)) {
		return { success: false, message: "You're not a member of any household." };
	}

	if (household.createdBy === userId) {
		return {
			success: false,
			message:
				'As the household creator, you cannot leave. Use /household delete to remove the household.',
		};
	}

	household.members = household.members.filter((m) => m !== userId);
	await saveHousehold(store, household);
	services.logger.info('User %s left household %s', userId, household.name);

	return {
		success: true,
		message: `You've left "${household.name}".`,
	};
}

/**
 * Get household info for display.
 */
export async function getHouseholdInfo(
	services: CoreServices,
	userId: string,
): Promise<HouseholdResult> {
	const store = services.data.forShared('shared');
	const household = await loadHousehold(store);

	if (!household) {
		return {
			success: false,
			message: 'No household set up yet. Create one with `/household create <name>`.',
		};
	}

	if (!household.members.includes(userId)) {
		return {
			success: false,
			message: 'You are not a member of this household.',
		};
	}

	const memberList = household.members
		.map((m) => (m === household.createdBy ? `${m} (creator)` : m))
		.join(', ');

	return {
		success: true,
		message: [
			`**${household.name}**`,
			`Members: ${memberList}`,
			`Join code: \`${household.joinCode}\``,
		].join('\n'),
		household,
	};
}
