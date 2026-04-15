/**
 * Household membership checks and shared store resolution.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { withFileLock } from '@pas/core/utils/file-mutex';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { Household } from '../types.js';

const HOUSEHOLD_PATH = 'household.yaml';

/** Acquire the household lock for a read-modify-write sequence. */
export function withHouseholdLock<T>(fn: () => Promise<T>): Promise<T> {
	return withFileLock(HOUSEHOLD_PATH, fn);
}

/** Valid join code format: 6 uppercase alphanumeric chars. */
export const JOIN_CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** Load the household definition, or null if none exists. */
export async function loadHousehold(store: ScopedDataStore): Promise<Household | null> {
	const raw = await store.read(HOUSEHOLD_PATH);
	if (!raw) return null;
	try {
		const content = stripFrontmatter(raw);
		return parse(content) as Household;
	} catch {
		return null;
	}
}

/** Save the household definition. */
export async function saveHousehold(store: ScopedDataStore, household: Household): Promise<void> {
	const fm = generateFrontmatter({
		title: household.name,
		date: household.createdAt,
		tags: buildAppTags('food', 'household'),
		app: 'food',
	});
	await store.write(HOUSEHOLD_PATH, fm + stringify(household));
}

/**
 * Check if a user is a member of the household.
 * Returns the household and shared store if the user is a member, null otherwise.
 */
export async function requireHousehold(
	services: CoreServices,
	userId: string,
): Promise<{ household: Household; sharedStore: ScopedDataStore } | null> {
	const sharedStore = services.data.forShared('shared');
	const household = await loadHousehold(sharedStore);
	if (!household) return null;
	if (!household.members.includes(userId)) return null;
	return { household, sharedStore };
}

/** Generate a 6-character join code. */
export function generateJoinCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
	let code = '';
	for (let i = 0; i < 6; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}
