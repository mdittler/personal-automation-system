import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FOOD_MANIFEST = parseYaml(readFileSync(join(__dirname, '../../manifest.yaml'), 'utf-8'));

const NL_SAFE_KEYS = [
	'seasonal_nudges',
	'cultural_calendar',
	'child_meal_adaptation',
	'show_price_estimates',
	'hands_free_default',
	'meal_plan_dinners',
	'new_recipe_ratio',
	'macro_target_calories',
	'macro_target_protein',
	'macro_target_carbs',
	'macro_target_fat',
	'macro_target_fiber',
	'dietary_preferences',
	'dietary_restrictions',
	'default_store',
].filter((key) => FOOD_MANIFEST.user_config.some((e: { key: string }) => e.key === key));

describe('food manifest nlSafe metadata', () => {
	it.each(NL_SAFE_KEYS)('key %s has nlSafe=true and a compilable nlIntentRegex', (key) => {
		const entry = FOOD_MANIFEST.user_config.find((e: { key: string }) => e.key === key);
		expect(entry, `key ${key} missing from manifest`).toBeDefined();
		expect(entry.nlSafe).toBe(true);
		expect(typeof entry.nlIntentRegex).toBe('string');
		expect(() => new RegExp(entry.nlIntentRegex, 'i')).not.toThrow();
		expect(entry.help).toBeTruthy();
		expect(entry.label).toBeTruthy();
	});

	it.each(
		['guest_profiles_info', 'schedule_overrides_info'].filter((k) =>
			FOOD_MANIFEST.user_config.some((e: { key: string }) => e.key === k),
		),
	)('pseudo-field %s is hidden=true', (key) => {
		const entry = FOOD_MANIFEST.user_config.find((e: { key: string }) => e.key === key);
		expect(entry.hidden).toBe(true);
	});

	it.each(
		['routing_primary', 'shadow_min_confidence', 'shadow_sample_rate'].filter((k) =>
			FOOD_MANIFEST.user_config.some((e: { key: string }) => e.key === k),
		),
	)('operational field %s is adminOnly+dangerous with nlSafe=false', (key) => {
		const entry = FOOD_MANIFEST.user_config.find((e: { key: string }) => e.key === key);
		expect(entry.adminOnly).toBe(true);
		expect(entry.dangerous).toBe(true);
		expect(entry.dangerConfirmPrompt).toBeTruthy();
		expect(entry.nlSafe ?? false).toBe(false);
	});

	it('every nlSafe entry has non-empty help and label', () => {
		for (const e of FOOD_MANIFEST.user_config) {
			if (e.nlSafe) {
				expect(e.help, `${e.key} must have help`).toBeTruthy();
				expect(e.label, `${e.key} must have label`).toBeTruthy();
			}
		}
	});
});

// Behavior tests — must match positive samples AND reject negative samples
const FOOD_REGEX_BEHAVIOR = [
	{
		key: 'seasonal_nudges',
		positives: [
			'please turn off seasonal nudges',
			'stop sending seasonal recipe suggestions',
			'enable seasonal nudges again',
		],
		negatives: ['what season is best for tomatoes', 'I had a suggestion from grandma'],
	},
	{
		key: 'cultural_calendar',
		positives: [
			'turn off the cultural calendar',
			'disable cultural calendar suggestions',
			'enable the cultural calendar',
		],
		negatives: ['what cultural events are this month', 'my calendar for tomorrow'],
	},
	{
		key: 'child_meal_adaptation',
		positives: [
			'turn off kid meal adaptation',
			'disable child meal adjustments',
			'enable kid friendly meal adaptation',
		],
		negatives: ['my child does not like broccoli', 'how do I adapt this recipe for my toddler'],
	},
	{
		key: 'show_price_estimates',
		positives: [
			'stop showing price estimates',
			'turn on price estimates',
			'disable cost estimates in recipes',
		],
		negatives: ['what is the price of milk', 'estimate how long this recipe takes'],
	},
	{
		key: 'hands_free_default',
		positives: [
			'turn on hands free mode by default',
			'enable hands free default',
			'disable hands free mode',
		],
		negatives: ['my hands are full right now', 'what is the default oven temperature'],
	},
	{
		key: 'meal_plan_dinners',
		positives: [
			'change my meal plan to 5 dinners',
			'set dinners per week to 7',
			'how many dinners in my plan',
		],
		negatives: ['what is for dinner tonight', 'plan a dinner party for saturday'],
	},
	{
		key: 'new_recipe_ratio',
		positives: [
			'set new recipe ratio to 0.3',
			'change the ratio of new recipes',
			'lower the new recipe percentage',
		],
		negatives: ['what is a good new recipe to try', 'show me the ratio of protein to carbs'],
	},
	{
		key: 'macro_target_calories',
		positives: [
			'set my calorie target to 2000',
			'change my macro target calories',
			'update my calorie goal',
		],
		negatives: ['how many calories are in this', 'what is my favorite food'],
	},
	{
		key: 'macro_target_protein',
		positives: [
			'set my protein target to 150g',
			'change my macro protein target',
			'update my protein goal',
		],
		negatives: ['what foods are high in protein', 'add chicken to my list'],
	},
	{
		key: 'macro_target_carbs',
		// Manifest regex: (set|change|update|my).*(carb.target|target.carb|carb.goal)|carb.target.*(set|change|update|to)
		positives: [
			'set my carb target to 220g',
			'change my carb goal to 150',
			'update my carb target',
		],
		negatives: ['how many carbs are in this recipe', 'what foods are low in carbs'],
	},
	{
		key: 'macro_target_fat',
		// Manifest regex: (set|change|update|my).*(fat.target|target.fat|fat.goal)|fat.target.*(set|change|update|to)
		positives: [
			'set my fat target to 60g',
			'change my fat goal to 70',
			'update my macro fat target',
		],
		negatives: ['what foods are high in fat', 'this recipe has too much fat'],
	},
	{
		key: 'macro_target_fiber',
		// Manifest regex: (set|change|update|my).*(fiber.target|target.fiber|fiber.goal)|fiber.target.*(set|change|update|to)
		positives: [
			'set my fiber target to 30g',
			'change my fiber goal to 25',
			'update my macro fiber target',
		],
		negatives: ['this recipe is high in fiber', 'what foods have the most fiber'],
	},
	{
		key: 'dietary_preferences',
		positives: [
			'update my dietary preferences to vegetarian',
			'change my dietary preference',
			'set dietary preferences',
		],
		negatives: ['do you prefer pasta or rice', 'what is my favorite cuisine'],
	},
	{
		key: 'dietary_restrictions',
		positives: [
			'add gluten free to my dietary restrictions',
			'update my dietary restrictions',
			'change my food restrictions',
		],
		negatives: ['is this restaurant gluten free', 'what foods should I avoid'],
	},
	{
		key: 'default_store',
		positives: [
			'set my default store to Walmart',
			'change my default grocery store',
			'update default store to Trader Joes',
		],
		negatives: ['is this store open today', 'where is the nearest grocery store'],
	},
];

describe('food regex behavior (positive + negative samples)', () => {
	for (const row of FOOD_REGEX_BEHAVIOR) {
		const entry = FOOD_MANIFEST.user_config.find((e: { key: string }) => e.key === row.key);
		if (!entry?.nlIntentRegex) continue; // skip if key not in manifest

		describe(`food.${row.key}`, () => {
			const re = new RegExp(entry.nlIntentRegex, 'i');

			it.each(row.positives)('matches positive: %s', (msg) => {
				expect(re.test(msg)).toBe(true);
			});

			it.each(row.negatives)('does NOT match benign: %s', (msg) => {
				expect(re.test(msg)).toBe(false);
			});
		});
	}
});
