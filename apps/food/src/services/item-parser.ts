/**
 * Local text parser for grocery items.
 *
 * Parses free-text like "2 lbs chicken, milk, eggs" into structured GroceryItem[].
 * No LLM needed — regex-based with a department lookup table.
 */

import type { GroceryItem } from '../types.js';

/** Standard grocery departments. */
export const DEPARTMENTS = [
	'Produce',
	'Dairy & Eggs',
	'Meat & Seafood',
	'Bakery',
	'Frozen',
	'Pantry & Dry Goods',
	'Beverages',
	'Snacks',
	'Household',
	'Other',
] as const;

/** Department emoji lookup. */
export const DEPARTMENT_EMOJI: Record<string, string> = {
	Produce: '🥬',
	'Dairy & Eggs': '🥛',
	'Meat & Seafood': '🥩',
	Bakery: '🍞',
	Frozen: '🧊',
	'Pantry & Dry Goods': '🫙',
	Beverages: '🥤',
	Snacks: '🍿',
	Household: '🏠',
	Other: '📦',
};

/** Map of common item names (lowercase) → department. */
export const DEPARTMENT_MAP: Record<string, string> = {
	// Produce
	apple: 'Produce',
	apples: 'Produce',
	avocado: 'Produce',
	avocados: 'Produce',
	banana: 'Produce',
	bananas: 'Produce',
	basil: 'Produce',
	'bell pepper': 'Produce',
	'bell peppers': 'Produce',
	broccoli: 'Produce',
	cabbage: 'Produce',
	carrot: 'Produce',
	carrots: 'Produce',
	celery: 'Produce',
	cilantro: 'Produce',
	corn: 'Produce',
	cucumber: 'Produce',
	cucumbers: 'Produce',
	garlic: 'Produce',
	ginger: 'Produce',
	grapes: 'Produce',
	'green beans': 'Produce',
	'green onion': 'Produce',
	'green onions': 'Produce',
	herbs: 'Produce',
	jalapeño: 'Produce',
	kale: 'Produce',
	lemon: 'Produce',
	lemons: 'Produce',
	lettuce: 'Produce',
	lime: 'Produce',
	limes: 'Produce',
	mango: 'Produce',
	mushroom: 'Produce',
	mushrooms: 'Produce',
	onion: 'Produce',
	onions: 'Produce',
	orange: 'Produce',
	oranges: 'Produce',
	parsley: 'Produce',
	peach: 'Produce',
	peaches: 'Produce',
	pear: 'Produce',
	pears: 'Produce',
	pepper: 'Produce',
	peppers: 'Produce',
	potato: 'Produce',
	potatoes: 'Produce',
	rosemary: 'Produce',
	scallion: 'Produce',
	scallions: 'Produce',
	shallot: 'Produce',
	shallots: 'Produce',
	spinach: 'Produce',
	squash: 'Produce',
	strawberry: 'Produce',
	strawberries: 'Produce',
	'sweet potato': 'Produce',
	'sweet potatoes': 'Produce',
	thyme: 'Produce',
	tomato: 'Produce',
	tomatoes: 'Produce',
	zucchini: 'Produce',

	// Dairy & Eggs
	butter: 'Dairy & Eggs',
	cheese: 'Dairy & Eggs',
	cheddar: 'Dairy & Eggs',
	'cheddar cheese': 'Dairy & Eggs',
	'cottage cheese': 'Dairy & Eggs',
	'cream cheese': 'Dairy & Eggs',
	cream: 'Dairy & Eggs',
	'heavy cream': 'Dairy & Eggs',
	'sour cream': 'Dairy & Eggs',
	egg: 'Dairy & Eggs',
	eggs: 'Dairy & Eggs',
	'half and half': 'Dairy & Eggs',
	milk: 'Dairy & Eggs',
	mozzarella: 'Dairy & Eggs',
	parmesan: 'Dairy & Eggs',
	'parmesan cheese': 'Dairy & Eggs',
	yogurt: 'Dairy & Eggs',
	'greek yogurt': 'Dairy & Eggs',
	'whipping cream': 'Dairy & Eggs',

	// Meat & Seafood
	bacon: 'Meat & Seafood',
	beef: 'Meat & Seafood',
	'ground beef': 'Meat & Seafood',
	chicken: 'Meat & Seafood',
	'chicken breast': 'Meat & Seafood',
	'chicken breasts': 'Meat & Seafood',
	'chicken thigh': 'Meat & Seafood',
	'chicken thighs': 'Meat & Seafood',
	fish: 'Meat & Seafood',
	ham: 'Meat & Seafood',
	lamb: 'Meat & Seafood',
	pork: 'Meat & Seafood',
	'pork chops': 'Meat & Seafood',
	'ground pork': 'Meat & Seafood',
	salmon: 'Meat & Seafood',
	sausage: 'Meat & Seafood',
	shrimp: 'Meat & Seafood',
	steak: 'Meat & Seafood',
	tilapia: 'Meat & Seafood',
	tuna: 'Meat & Seafood',
	turkey: 'Meat & Seafood',
	'ground turkey': 'Meat & Seafood',

	// Bakery
	bagel: 'Bakery',
	bagels: 'Bakery',
	bread: 'Bakery',
	bun: 'Bakery',
	buns: 'Bakery',
	croissant: 'Bakery',
	croissants: 'Bakery',
	muffin: 'Bakery',
	muffins: 'Bakery',
	pita: 'Bakery',
	roll: 'Bakery',
	rolls: 'Bakery',
	tortilla: 'Bakery',
	tortillas: 'Bakery',
	'hamburger buns': 'Bakery',
	'hot dog buns': 'Bakery',

	// Frozen
	'frozen vegetables': 'Frozen',
	'frozen fruit': 'Frozen',
	'ice cream': 'Frozen',
	'frozen pizza': 'Frozen',
	'frozen berries': 'Frozen',
	'frozen peas': 'Frozen',
	'frozen corn': 'Frozen',

	// Pantry & Dry Goods
	'baking powder': 'Pantry & Dry Goods',
	'baking soda': 'Pantry & Dry Goods',
	'black beans': 'Pantry & Dry Goods',
	'brown sugar': 'Pantry & Dry Goods',
	'canned tomatoes': 'Pantry & Dry Goods',
	'chicken broth': 'Pantry & Dry Goods',
	'coconut milk': 'Pantry & Dry Goods',
	cornstarch: 'Pantry & Dry Goods',
	'diced tomatoes': 'Pantry & Dry Goods',
	flour: 'Pantry & Dry Goods',
	'all-purpose flour': 'Pantry & Dry Goods',
	honey: 'Pantry & Dry Goods',
	ketchup: 'Pantry & Dry Goods',
	'maple syrup': 'Pantry & Dry Goods',
	mayonnaise: 'Pantry & Dry Goods',
	mustard: 'Pantry & Dry Goods',
	'olive oil': 'Pantry & Dry Goods',
	'vegetable oil': 'Pantry & Dry Goods',
	oil: 'Pantry & Dry Goods',
	pasta: 'Pantry & Dry Goods',
	'peanut butter': 'Pantry & Dry Goods',
	'ranch dressing': 'Pantry & Dry Goods',
	rice: 'Pantry & Dry Goods',
	salt: 'Pantry & Dry Goods',
	'soy sauce': 'Pantry & Dry Goods',
	sugar: 'Pantry & Dry Goods',
	'tomato paste': 'Pantry & Dry Goods',
	'tomato sauce': 'Pantry & Dry Goods',
	vanilla: 'Pantry & Dry Goods',
	'vanilla extract': 'Pantry & Dry Goods',
	vinegar: 'Pantry & Dry Goods',
	'white rice': 'Pantry & Dry Goods',
	'brown rice': 'Pantry & Dry Goods',
	noodles: 'Pantry & Dry Goods',
	spaghetti: 'Pantry & Dry Goods',
	'kidney beans': 'Pantry & Dry Goods',
	lentils: 'Pantry & Dry Goods',
	oats: 'Pantry & Dry Goods',
	'pinto beans': 'Pantry & Dry Goods',
	quinoa: 'Pantry & Dry Goods',
	breadcrumbs: 'Pantry & Dry Goods',
	'panko breadcrumbs': 'Pantry & Dry Goods',
	cumin: 'Pantry & Dry Goods',
	paprika: 'Pantry & Dry Goods',
	'chili powder': 'Pantry & Dry Goods',
	oregano: 'Pantry & Dry Goods',
	'cayenne pepper': 'Pantry & Dry Goods',
	cinnamon: 'Pantry & Dry Goods',
	nutmeg: 'Pantry & Dry Goods',
	'garlic powder': 'Pantry & Dry Goods',
	'onion powder': 'Pantry & Dry Goods',
	'red pepper flakes': 'Pantry & Dry Goods',

	// Beverages
	beer: 'Beverages',
	coffee: 'Beverages',
	juice: 'Beverages',
	'orange juice': 'Beverages',
	'apple juice': 'Beverages',
	soda: 'Beverages',
	tea: 'Beverages',
	water: 'Beverages',
	wine: 'Beverages',
	'sparkling water': 'Beverages',
	'almond milk': 'Beverages',
	'oat milk': 'Beverages',

	// Snacks
	chips: 'Snacks',
	crackers: 'Snacks',
	granola: 'Snacks',
	'granola bars': 'Snacks',
	nuts: 'Snacks',
	popcorn: 'Snacks',
	pretzels: 'Snacks',
	almonds: 'Snacks',

	// Household
	'aluminum foil': 'Household',
	'dish soap': 'Household',
	'paper towels': 'Household',
	'plastic wrap': 'Household',
	'trash bags': 'Household',
	'laundry detergent': 'Household',
	napkins: 'Household',
	sponge: 'Household',
	sponges: 'Household',
	'toilet paper': 'Household',
	tissues: 'Household',
};

/** Regex to extract quantity and unit from the start of an item string. */
const QTY_UNIT_REGEX =
	/^(\d+(?:\.\d+)?)\s*(lbs?|oz|cups?|tbsp|tsp|gal(?:lon)?s?|dozen|cans?|bunch(?:es)?|bags?|boxes?|bottles?|packs?|pieces?|pints?|quarts?|liters?|heads?|stalks?|cloves?|slices?|sticks?|jars?|containers?)?\s*/i;

/** Pre-sorted entries: longest keys first so "apple juice" matches before "apple". */
const DEPARTMENT_ENTRIES_BY_LENGTH = Object.entries(DEPARTMENT_MAP).sort(
	(a, b) => b[0].length - a[0].length,
);

/**
 * Look up department for an item name.
 * Tries exact match first, then checks if any key is a substring.
 * Longer keys match first to prefer specific matches (e.g., "apple juice" over "apple").
 */
export function assignDepartment(name: string): string {
	const lower = name.toLowerCase().trim();
	// Exact match
	const direct = DEPARTMENT_MAP[lower];
	if (direct) return direct;
	// Substring match — longest key first for specificity
	for (const [key, dept] of DEPARTMENT_ENTRIES_BY_LENGTH) {
		if (lower.includes(key)) return dept;
	}
	return 'Other';
}

/**
 * Parse free-text input into GroceryItem[].
 * Splits on commas, "and", and newlines. Extracts quantity + unit via regex.
 */
export function parseManualItems(text: string, userId: string): GroceryItem[] {
	// Split on comma, "and" (word boundary), or newline
	const parts = text
		.split(/,|\band\b|\n/i)
		.map((s) => s.trim())
		.filter(Boolean);

	const items: GroceryItem[] = [];
	for (const part of parts) {
		const match = part.match(QTY_UNIT_REGEX);
		let name: string;
		let quantity: number | null = null;
		let unit: string | null = null;

		if (match?.[0]?.trim()) {
			quantity = match[1] ? Number.parseFloat(match[1]) : null;
			unit = match[2] || null;
			name = part.slice(match[0].length).trim();
		} else {
			name = part;
		}

		if (!name) continue;

		items.push({
			name,
			quantity,
			unit,
			department: assignDepartment(name),
			recipeIds: [],
			purchased: false,
			addedBy: userId,
		});
	}

	return items;
}
