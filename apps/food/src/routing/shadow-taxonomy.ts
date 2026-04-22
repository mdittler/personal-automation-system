/**
 * Canonical label list for the Food shadow classifier (LLM Enhancement #2 Chunk B).
 * Includes all 26 manifest intents verbatim plus a "none" escape — 27 total.
 *
 * MUST stay in sync with apps/food/manifest.yaml capabilities.messages.intents.
 * shadow-taxonomy.test.ts enforces parity at test time.
 */

export const FOOD_SHADOW_LABELS = [
    'user wants to save a recipe',
    'user wants to search for a recipe',
    'user wants to plan meals for the week',
    'user wants to see or modify the grocery list',
    'user wants to add items to the grocery list',
    "user wants to know what's for dinner",
    'user has a food-related question',
    'user wants to start cooking a recipe',
    'user wants to check or update the pantry',
    'user wants to log leftovers',
    'user wants to plan for hosting guests',
    'user wants to see food spending',
    'user wants to see receipt details or look up items from a receipt',
    'user asks about prices at a specific store',
    'user wants to see nutrition information',
    'user wants to know what they can make with what they have',
    'user wants to adapt a recipe for a child',
    'user wants to log a new food introduction for a child',
    'user wants to tag a recipe as kid-approved or rejected',
    'user wants to log a meal they cooked by name with an optional portion',
    'user wants to log an unfamiliar meal with a free-text description',
    'user wants to save a frequent meal as a quick-meal template',
    'user wants to set or change their nutrition or macro targets',
    'user wants to see how well they are hitting their macro targets over time',
    'user wants to understand how their diet is affecting their health or energy',
    'user wants holiday or cultural recipe suggestions',
    'none',
] as const;

export type FoodShadowLabel = (typeof FOOD_SHADOW_LABELS)[number];

const LABEL_SET: ReadonlySet<string> = new Set(FOOD_SHADOW_LABELS);

export function isValidShadowLabel(v: unknown): v is FoodShadowLabel {
    return typeof v === 'string' && LABEL_SET.has(v);
}

/**
 * Build the shadow taxonomy at runtime from a manifest's intent list.
 * Deduplicates and appends "none" at the end. Used so the prompt stays
 * in lockstep with the live manifest.yaml.
 */
export function buildLabelsFromManifest(manifestIntents: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const intent of manifestIntents) {
        if (intent === 'none') continue;
        if (!seen.has(intent)) {
            seen.add(intent);
            out.push(intent);
        }
    }
    out.push('none');
    return out;
}

/**
 * Maps the regex cascade's internal label onto the nearest manifest intent.
 * Used only to compute the agreement verdict for the shadow log — never surfaced
 * to handlers or users.
 *
 * The sentinel '(route-dispatched)' maps to 'none' because route-dispatch
 * outcomes are logged as { kind: 'legacy-skipped' } and the verdict is
 * 'legacy-skipped', so the mapped value is never used for agreement math.
 */
export const REGEX_TO_MANIFEST_MAP: Record<string, FoodShadowLabel> = {
    save_recipe:            'user wants to save a recipe',
    search_recipe:          'user wants to search for a recipe',
    recipe_photo:           'user wants to search for a recipe',
    edit_recipe:            'user wants to save a recipe',
    meal_plan_generate:     'user wants to plan meals for the week',
    meal_plan_view:         'user wants to plan meals for the week',
    whats_for_dinner:       "user wants to know what's for dinner",
    food_question:          'user has a food-related question',
    cook_intent:            'user wants to start cooking a recipe',
    what_can_i_make:        'user wants to know what they can make with what they have',
    meal_swap:              'user wants to plan meals for the week',
    leftover_add:           'user wants to log leftovers',
    leftover_view:          'user wants to log leftovers',
    freezer_add:            'user wants to check or update the pantry',
    freezer_view:           'user wants to check or update the pantry',
    waste_log:              'user wants to log leftovers',
    kid_adapt:              'user wants to adapt a recipe for a child',
    food_intro:             'user wants to log a new food introduction for a child',
    child_approval:         'user wants to tag a recipe as kid-approved or rejected',
    price_update:           'user asks about prices at a specific store',
    meal_log_nl:            'user wants to log a meal they cooked by name with an optional portion',
    targets_set:            'user wants to set or change their nutrition or macro targets',
    adherence:              'user wants to see how well they are hitting their macro targets over time',
    nutrition_view:         'user wants to see nutrition information',
    health_correlation:     'user wants to understand how their diet is affecting their health or energy',
    cultural_calendar:      'user wants holiday or cultural recipe suggestions',
    hosting:                'user wants to plan for hosting guests',
    budget_view:            'user wants to see food spending',
    grocery_view:           'user wants to see or modify the grocery list',
    grocery_add:            'user wants to add items to the grocery list',
    grocery_generate:       'user wants to see or modify the grocery list',
    pantry_view:            'user wants to check or update the pantry',
    pantry_add:             'user wants to check or update the pantry',
    pantry_remove:          'user wants to check or update the pantry',
    data_query_fallback:    'none',
    help_fallthrough:       'none',
    pending_flow_consumed:  'none',
    '(route-dispatched)':   'none',
};

export function normalizeRegexLabel(regexLabel: string): FoodShadowLabel {
    return Object.hasOwn(REGEX_TO_MANIFEST_MAP, regexLabel)
        ? REGEX_TO_MANIFEST_MAP[regexLabel]!
        : 'none';
}
