/**
 * Child food introduction tracker — logging new foods and allergen safety checks.
 *
 * Pure logic, no I/O. Operates on ChildFoodLog structures.
 */

import type { ChildFoodLog, FoodIntroduction } from '../types.js';

export const ALLERGEN_CATEGORIES = [
	'milk', 'eggs', 'peanuts', 'tree_nuts', 'wheat',
	'soy', 'fish', 'shellfish', 'sesame',
] as const;

export type AllergenCategory = typeof ALLERGEN_CATEGORIES[number];

/** Maps common food names to their allergen category. */
const FOOD_TO_ALLERGEN: Record<string, AllergenCategory> = {
	// milk / dairy
	milk: 'milk', cheese: 'milk', yogurt: 'milk', butter: 'milk', cream: 'milk',
	dairy: 'milk', 'ice cream': 'milk', whey: 'milk', casein: 'milk',
	// eggs
	egg: 'eggs', eggs: 'eggs', omelette: 'eggs', omelet: 'eggs', meringue: 'eggs',
	// peanuts
	peanut: 'peanuts', peanuts: 'peanuts', 'peanut butter': 'peanuts',
	// tree nuts
	almond: 'tree_nuts', cashew: 'tree_nuts', walnut: 'tree_nuts', pecan: 'tree_nuts',
	pistachio: 'tree_nuts', hazelnut: 'tree_nuts', macadamia: 'tree_nuts',
	'brazil nut': 'tree_nuts', 'tree nut': 'tree_nuts', 'tree nuts': 'tree_nuts',
	// wheat
	wheat: 'wheat', bread: 'wheat', pasta: 'wheat', flour: 'wheat',
	cracker: 'wheat', cereal: 'wheat', couscous: 'wheat', noodle: 'wheat',
	// soy
	soy: 'soy', tofu: 'soy', edamame: 'soy', tempeh: 'soy', miso: 'soy',
	'soy sauce': 'soy', soybean: 'soy',
	// fish
	fish: 'fish', salmon: 'fish', tuna: 'fish', cod: 'fish', tilapia: 'fish',
	trout: 'fish', halibut: 'fish', sardine: 'fish', anchovy: 'fish', bass: 'fish',
	// shellfish
	shellfish: 'shellfish', shrimp: 'shellfish', crab: 'shellfish', lobster: 'shellfish',
	clam: 'shellfish', mussel: 'shellfish', oyster: 'shellfish', scallop: 'shellfish',
	prawn: 'shellfish', crawfish: 'shellfish',
	// sesame
	sesame: 'sesame', tahini: 'sesame', hummus: 'sesame',
};

/**
 * Match a food name to an allergen category using the food-to-allergen map
 * and falling back to direct category name matching.
 * Sorts entries by key length descending so longer/more-specific keys match first.
 */
export function matchAllergenCategory(food: string): AllergenCategory | null {
	const lower = food.toLowerCase().trim();

	// Sort by key length descending so "peanut butter" matches before "butter"
	const sorted = Object.entries(FOOD_TO_ALLERGEN).sort(
		(a, b) => b[0].length - a[0].length,
	);
	for (const [key, category] of sorted) {
		if (lower.includes(key)) return category;
	}

	// Direct category name check
	return ALLERGEN_CATEGORIES.find((cat) =>
		lower.includes(cat.replace('_', ' ')),
	) ?? null;
}

export interface WaitWindowResult {
	safe: boolean;
	lastIntroDate?: string;
	daysSince?: number;
}

export function addFoodIntroduction(log: ChildFoodLog, entry: FoodIntroduction): ChildFoodLog {
	return {
		...log,
		introductions: [...log.introductions, entry],
	};
}

function daysBetween(dateA: string, dateB: string): number {
	// Normalize to noon UTC to avoid DST 23/25-hour day issues
	const a = new Date(dateA + 'T12:00:00Z');
	const b = new Date(dateB + 'T12:00:00Z');
	return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

export function checkAllergenWaitWindow(
	log: ChildFoodLog,
	allergenCategory: string,
	date: string,
	waitDays: number,
): WaitWindowResult {
	// Find the most recent introduction of a *different* allergen category
	const differentAllergenIntros = log.introductions
		.filter((i) => i.allergenCategory != null && i.allergenCategory !== allergenCategory);

	if (differentAllergenIntros.length === 0) {
		return { safe: true };
	}

	// Sort by date descending, take the most recent
	const sorted = [...differentAllergenIntros].sort(
		(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
	);
	const mostRecent = sorted[0]!;
	const days = daysBetween(mostRecent.date, date);

	if (days >= waitDays) {
		return { safe: true, lastIntroDate: mostRecent.date, daysSince: days };
	}

	return {
		safe: false,
		lastIntroDate: mostRecent.date,
		daysSince: days,
	};
}

export function getRecentIntroductions(
	log: ChildFoodLog,
	days: number,
	today: string,
): FoodIntroduction[] {
	const cutoff = new Date(today);
	cutoff.setDate(cutoff.getDate() - days);
	return log.introductions.filter((i) => new Date(i.date) >= cutoff);
}

export function getAllergenHistory(
	log: ChildFoodLog,
	allergenCategory: string,
): FoodIntroduction[] {
	return log.introductions.filter((i) => i.allergenCategory === allergenCategory);
}

export function formatFoodLog(introductions: FoodIntroduction[], limit?: number): string {
	if (introductions.length === 0) {
		return 'No foods introduced yet.';
	}

	const items = limit ? introductions.slice(-limit) : introductions;
	return items
		.map((i) => {
			const emoji = i.accepted ? '✅' : '❌';
			const allergen = i.allergenCategory ? ` (${i.allergenCategory})` : '';
			const reaction = i.reaction !== 'none' ? ` — reaction: ${i.reaction}` : '';
			return `${emoji} ${i.food}${allergen} — ${i.date}${reaction}`;
		})
		.join('\n');
}

export function formatAllergenWarning(
	lastIntroDate: string,
	daysSince: number,
	waitDays: number,
): string {
	return (
		`⚠️ **Allergen wait period warning**\n` +
		`Last new allergen was introduced on ${lastIntroDate} (${daysSince} days ago).\n` +
		`Recommended wait period is ${waitDays} days. Consider waiting ${waitDays - daysSince} more day(s).`
	);
}
