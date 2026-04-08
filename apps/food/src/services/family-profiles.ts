/**
 * Family profiles service — CRUD for child profiles and food introduction logs.
 *
 * Each child is stored as an individual YAML file at children/<slug>.yaml
 * containing the profile and food introduction history.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { ChildFoodLog, ChildProfile } from '../types.js';

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

function childPath(slug: string): string {
	return `children/${slug}.yaml`;
}

function isValidSlug(slug: string): boolean {
	return SAFE_SLUG.test(slug) && !slug.includes('..');
}

/**
 * Parse a date string in various common formats into ISO YYYY-MM-DD.
 * Returns null if the date cannot be parsed or is invalid.
 */
export function parseBirthDate(input: string): string | null {
	const trimmed = input.trim();

	// Already ISO format: 2024-06-15
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		const d = new Date(trimmed + 'T00:00:00Z');
		if (Number.isNaN(d.getTime())) return null;
		// Verify date didn't roll over (e.g., Feb 30 → Mar 2)
		if (d.toISOString().slice(0, 10) !== trimmed) return null;
		return trimmed;
	}

	// US format: 6/15/2024 or 06/15/2024
	const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (usMatch) {
		const [, month, day, year] = usMatch;
		const iso = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
		const d = new Date(iso + 'T00:00:00Z');
		if (Number.isNaN(d.getTime())) return null;
		if (d.toISOString().slice(0, 10) !== iso) return null;
		return iso;
	}

	// Named month: "June 15 2024", "June 15, 2024", "15 June 2024", "Jun 15 2024"
	const d = new Date(trimmed);
	if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100) {
		const iso = d.toISOString().slice(0, 10);
		return iso;
	}

	return null;
}

export function slugifyChildName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export function computeAgeMonths(birthDate: string, today: string): number {
	const birth = new Date(birthDate);
	const now = new Date(today);
	let months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
	if (now.getDate() < birth.getDate()) {
		months--;
	}
	return Math.max(0, months);
}

export function computeAgeDisplay(birthDate: string, today: string): string {
	const months = computeAgeMonths(birthDate, today);
	if (months >= 24) {
		const years = Math.floor(months / 12);
		return `${years} ${years === 1 ? 'year' : 'years'}`;
	}
	return `${months} ${months === 1 ? 'month' : 'months'}`;
}

export async function loadChildProfile(
	store: ScopedDataStore,
	slug: string,
): Promise<ChildFoodLog | null> {
	if (!isValidSlug(slug)) return null;

	const raw = await store.read(childPath(slug));
	if (!raw) return null;

	try {
		const content = stripFrontmatter(raw);
		const data = parse(content) as ChildFoodLog;
		if (!data?.profile?.name) return null;
		return {
			profile: data.profile,
			introductions: data.introductions ?? [],
		};
	} catch {
		return null;
	}
}

export async function saveChildProfile(
	store: ScopedDataStore,
	log: ChildFoodLog,
): Promise<void> {
	const fm = generateFrontmatter({
		title: log.profile.name,
		date: log.profile.createdAt,
		tags: buildAppTags('food', 'child-profile'),
	});
	const body = stringify({
		profile: log.profile,
		introductions: log.introductions,
	});
	await store.write(childPath(log.profile.slug), fm + body);
}

export async function loadAllChildren(
	store: ScopedDataStore,
): Promise<ChildFoodLog[]> {
	const files = await store.list('children');
	const results: ChildFoodLog[] = [];

	for (const file of files) {
		if (!file.endsWith('.yaml')) continue;
		const slug = file.replace(/^children\//, '').replace(/\.yaml$/, '');
		const log = await loadChildProfile(store, slug);
		if (log) results.push(log);
	}

	return results;
}

export async function deleteChildProfile(
	store: ScopedDataStore,
	slug: string,
): Promise<boolean> {
	if (!isValidSlug(slug)) return false;

	const exists = await store.exists(childPath(slug));
	if (!exists) return false;

	await store.archive(childPath(slug));
	return true;
}

export function formatChildProfile(log: ChildFoodLog, today: string): string {
	const { profile, introductions } = log;
	const age = computeAgeDisplay(profile.birthDate, today);

	const lines = [
		`**${profile.name}** (${age})`,
		`Stage: ${profile.allergenStage}`,
	];

	if (profile.knownAllergens.length > 0) {
		lines.push(`Safe allergens: ${profile.knownAllergens.join(', ')}`);
	}
	if (profile.avoidAllergens.length > 0) {
		lines.push(`Avoid: ${profile.avoidAllergens.join(', ')}`);
	}
	if (profile.dietaryNotes) {
		lines.push(`Notes: ${profile.dietaryNotes}`);
	}

	lines.push('');
	if (introductions.length === 0) {
		lines.push('No foods introduced yet.');
	} else {
		lines.push('**Recent introductions:**');
		const recent = introductions.slice(-5);
		for (const intro of recent) {
			const emoji = intro.accepted ? '✅' : '❌';
			const allergen = intro.allergenCategory ? ` (${intro.allergenCategory})` : '';
			lines.push(`${emoji} ${intro.food}${allergen} — ${intro.date}`);
		}
	}

	return lines.join('\n');
}
