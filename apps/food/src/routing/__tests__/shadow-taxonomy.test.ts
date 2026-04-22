import { describe, it, expect } from 'vitest';
import {
    FOOD_SHADOW_LABELS,
    REGEX_TO_MANIFEST_MAP,
    normalizeRegexLabel,
    isValidShadowLabel,
    buildLabelsFromManifest,
} from '../shadow-taxonomy.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

describe('FOOD_SHADOW_LABELS', () => {
    it('contains all 26 manifest intents plus "none" (27 total)', () => {
        expect(FOOD_SHADOW_LABELS).toHaveLength(27);
        expect(FOOD_SHADOW_LABELS).toContain('none');
    });

    it('every manifest intent from apps/food/manifest.yaml appears verbatim', () => {
        const manifestPath = resolve(__dirname, '../../../manifest.yaml');
        const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
        const intents: string[] = manifest.capabilities.messages.intents;
        expect(intents.length).toBeGreaterThan(0);
        for (const intent of intents) {
            expect(FOOD_SHADOW_LABELS, `missing: ${intent}`).toContain(intent);
        }
    });

    it('has no duplicate labels', () => {
        expect(new Set(FOOD_SHADOW_LABELS).size).toBe(FOOD_SHADOW_LABELS.length);
    });

    it('"none" is the last label', () => {
        expect(FOOD_SHADOW_LABELS[FOOD_SHADOW_LABELS.length - 1]).toBe('none');
    });
});

describe('buildLabelsFromManifest', () => {
    it('returns manifest intents + "none", no duplicates', () => {
        const intents = [
            'user wants to save a recipe',
            'user wants to search for a recipe',
        ];
        const labels = buildLabelsFromManifest(intents);
        expect(labels).toEqual([...intents, 'none']);
    });

    it('deduplicates if manifest has repeats', () => {
        const labels = buildLabelsFromManifest(['a', 'a', 'b']);
        expect(labels).toEqual(['a', 'b', 'none']);
    });

    it('always includes "none" at the end even if manifest already has it', () => {
        const labels = buildLabelsFromManifest(['a', 'none', 'b']);
        expect(labels.filter((l) => l === 'none')).toHaveLength(1);
        expect(labels[labels.length - 1]).toBe('none');
    });

    it('empty input → ["none"]', () => {
        expect(buildLabelsFromManifest([])).toEqual(['none']);
    });
});

describe('REGEX_TO_MANIFEST_MAP', () => {
    it('every mapped value is a valid shadow label', () => {
        for (const [regex, manifest] of Object.entries(REGEX_TO_MANIFEST_MAP)) {
            expect(FOOD_SHADOW_LABELS, `${regex} → ${manifest}`).toContain(manifest);
        }
    });

    it.each([
        ['grocery_add',            'user wants to add items to the grocery list'],
        ['grocery_view',           'user wants to see or modify the grocery list'],
        ['grocery_generate',       'user wants to see or modify the grocery list'],
        ['pantry_add',             'user wants to check or update the pantry'],
        ['pantry_remove',          'user wants to check or update the pantry'],
        ['pantry_view',            'user wants to check or update the pantry'],
        ['waste_log',              'user wants to log leftovers'],
        ['leftover_add',           'user wants to log leftovers'],
        ['leftover_view',          'user wants to log leftovers'],
        ['freezer_add',            'user wants to check or update the pantry'],
        ['freezer_view',           'user wants to check or update the pantry'],
        ['meal_log_nl',            'user wants to log a meal they cooked by name with an optional portion'],
        ['whats_for_dinner',       "user wants to know what's for dinner"],
        ['cook_intent',            'user wants to start cooking a recipe'],
        ['save_recipe',            'user wants to save a recipe'],
        ['search_recipe',          'user wants to search for a recipe'],
        ['edit_recipe',            'user wants to save a recipe'],
        ['recipe_photo',           'user wants to search for a recipe'],
        ['what_can_i_make',        'user wants to know what they can make with what they have'],
        ['meal_plan_generate',     'user wants to plan meals for the week'],
        ['meal_plan_view',         'user wants to plan meals for the week'],
        ['meal_swap',              'user wants to plan meals for the week'],
        ['kid_adapt',              'user wants to adapt a recipe for a child'],
        ['food_intro',             'user wants to log a new food introduction for a child'],
        ['child_approval',         'user wants to tag a recipe as kid-approved or rejected'],
        ['price_update',           'user asks about prices at a specific store'],
        ['targets_set',            'user wants to set or change their nutrition or macro targets'],
        ['adherence',              'user wants to see how well they are hitting their macro targets over time'],
        ['nutrition_view',         'user wants to see nutrition information'],
        ['health_correlation',     'user wants to understand how their diet is affecting their health or energy'],
        ['cultural_calendar',      'user wants holiday or cultural recipe suggestions'],
        ['hosting',                'user wants to plan for hosting guests'],
        ['budget_view',            'user wants to see food spending'],
        ['food_question',          'user has a food-related question'],
        ['data_query_fallback',    'none'],
        ['help_fallthrough',       'none'],
        ['pending_flow_consumed',  'none'],
        ['(route-dispatched)',     'none'],
    ])('normalizeRegexLabel("%s") → "%s"', (regex, expected) => {
        expect(normalizeRegexLabel(regex)).toBe(expected);
    });

    it('unknown regex label falls back to "none"', () => {
        expect(normalizeRegexLabel('totally_fake_label')).toBe('none');
        expect(normalizeRegexLabel('')).toBe('none');
    });
});

describe('isValidShadowLabel', () => {
    it('accepts every taxonomy label', () => {
        for (const l of FOOD_SHADOW_LABELS) {
            expect(isValidShadowLabel(l)).toBe(true);
        }
    });

    it.each([
        ['',                              'empty string'],
        ['grocery_add',                   'regex label form'],
        ['USER WANTS TO SAVE A RECIPE',   'wrong case'],
        ['user wants to save a recipe ',  'trailing whitespace'],
        [' user wants to save a recipe',  'leading whitespace'],
        [null,                            'null'],
        [undefined,                       'undefined'],
        [42,                              'number'],
        [{},                              'object'],
        [[],                              'array'],
        [true,                            'boolean'],
        ['(route-dispatched)',            'sentinel string'],
    ])('rejects %j (%s)', (val) => {
        expect(isValidShadowLabel(val as unknown)).toBe(false);
    });
});
