/**
 * Shadow classifier persona dataset.
 *
 * A curated, reviewable specification of natural-language phrases and their
 * expected routing under current Food app semantics. Used by
 * shadow-classifier.persona.test.ts for structural invariant checks and
 * a thin smoke roundtrip per label.
 *
 * B.3 integration tests can pull rejectFor entries to assert that the
 * *deterministic* routing (regex cascade + handleMessage) sends each
 * phrase to correctLabel, not to persona.label. That is where real
 * accept/reject coverage lives; this file is the spec that drives it.
 *
 * Schema:
 *   accept[]     — phrases that SHOULD classify as `label` under current product semantics
 *   rejectFor[]  — phrases a casual reader might file under `label` but that current
 *                  Food routing sends to correctLabel instead
 *   synthesized  — true when the label has no existing test phrasing (photo-only or
 *                  LLM-only intent); accept phrases are invented rather than drawn from
 *                  existing test suites
 */

import type { FoodShadowLabel } from '../shadow-taxonomy.js';

export interface RejectEntry {
    text: string;
    correctLabel: FoodShadowLabel;
    reason: string;
    source?: string;
}

export interface Persona {
    label: FoodShadowLabel;
    accept: string[];
    rejectFor: RejectEntry[];
    synthesized?: true;
}

export const FOOD_PERSONAS: readonly Persona[] = [
    {
        label: 'user wants to save a recipe',
        accept: [
            'save this recipe',
            'add this pasta recipe to my collection',
            'keep the bolognese recipe for later',
            'store the chicken tikka masala recipe',
        ],
        rejectFor: [
            {
                text: 'find me a pasta recipe',
                correctLabel: 'user wants to search for a recipe',
                reason: 'isSaveRecipeIntent requires save/add/store/keep+recipe keyword; "find" triggers isSearchRecipeIntent instead',
                source: 'apps/food/src/index.ts:3067',
            },
            {
                text: 'what pasta recipes do we have?',
                correctLabel: 'user wants to search for a recipe',
                reason: 'isSearchRecipeIntent /\\bwhat.*recipes?\\b.*\\bhave\\b/ matches before save-intent check',
                source: 'apps/food/src/index.ts:3075',
            },
        ],
    },

    {
        label: 'user wants to search for a recipe',
        accept: [
            'find me a chicken recipe',
            'search for pasta dishes',
            'show me dinner recipes',
            'look up how to make risotto',
        ],
        rejectFor: [
            {
                text: 'what can I make with chicken?',
                correctLabel: 'user wants to know what they can make with what they have',
                reason: 'isWhatCanIMakeIntent /\\bwhat\\s+can\\s+i\\s+(make|cook)\\b/ fires at line 459; ingredient-constrained lookup, not open recipe search',
                source: 'apps/food/src/index.ts:459',
            },
            {
                text: 'save this chicken recipe',
                correctLabel: 'user wants to save a recipe',
                reason: 'isSaveRecipeIntent (line 417) runs before isSearchRecipeIntent (line 423); save+recipe routes to save intent',
                source: 'apps/food/src/index.ts:417',
            },
        ],
    },

    {
        label: 'user wants to plan meals for the week',
        accept: [
            'plan meals for next week',
            'create a meal plan',
            'what should we eat this week?',
            'make a weekly meal plan for us',
        ],
        rejectFor: [
            {
                text: "what's for dinner tonight?",
                correctLabel: "user wants to know what's for dinner",
                reason: 'isWhatsForDinnerIntent (line 453) matches /what\'s for dinner/ — single-meal tonight query, not week planning',
                source: 'apps/food/src/index.ts:453',
            },
            {
                text: 'what can I make for dinner?',
                correctLabel: 'user wants to know what they can make with what they have',
                reason: 'isWhatCanIMakeIntent /\\bwhat\\s+can\\s+i\\s+(make|cook)\\b/ fires at line 459 — ingredient-constrained cooking idea lookup, not multi-day meal planning',
                source: 'apps/food/src/index.ts:459',
            },
        ],
    },

    {
        label: 'user wants to see or modify the grocery list',
        accept: [
            'show me the grocery list',
            "what's on the shopping list?",
            'view my grocery list',
            'display the shopping list please',
        ],
        rejectFor: [
            {
                text: 'add eggs to the grocery list',
                correctLabel: 'user wants to add items to the grocery list',
                reason: 'isGroceryAddIntent /\\b(add)\\b.*\\b(to)\\s+(the\\s+)?(grocery)\\b/ — adding items routes to add intent, not view',
                source: 'apps/food/src/index.ts:3181',
            },
            {
                text: 'we need bread and milk',
                correctLabel: 'user wants to add items to the grocery list',
                reason: 'isGroceryAddIntent /\\bwe need\\b/ — "we need" is an add-intent trigger, not a view request',
                source: 'apps/food/src/index.ts:3183',
            },
        ],
    },

    {
        label: 'user wants to add items to the grocery list',
        accept: [
            'add milk to the grocery list',
            'we need eggs',
            'put bread on the shopping list',
            'get chicken from the grocery store',
        ],
        rejectFor: [
            {
                text: 'show me the grocery list',
                correctLabel: 'user wants to see or modify the grocery list',
                reason: 'isGroceryViewIntent /\\b(show|view|see|check)\\b.*\\b(grocery|shopping)\\b/ — viewing, not adding',
                source: 'apps/food/src/index.ts:3165',
            },
            {
                text: "we're out of pasta",
                correctLabel: 'user wants to check or update the pantry',
                reason: 'isPantryRemoveIntent /\\bwe\'re out of\\b/ fires at line 694 — "out of" is a pantry-remove signal that maps to pantry label in REGEX_TO_MANIFEST_MAP, not grocery-add',
                source: 'apps/food/src/index.ts:694',
            },
        ],
    },

    {
        label: "user wants to know what's for dinner",
        accept: [
            "what's for dinner?",
            'whats for dinner tonight',
            'what are we having for dinner',
            "what's on the menu tonight",
        ],
        rejectFor: [
            {
                text: 'plan meals for this week',
                correctLabel: 'user wants to plan meals for the week',
                reason: 'isMealPlanGenerateIntent /\\b(plan|generate|create|make)\\b.*\\b(meals?)\\b/ — week-level planning, not tonight query',
                source: 'apps/food/src/index.ts:441',
            },
            {
                text: 'what can I cook?',
                correctLabel: 'user wants to know what they can make with what they have',
                reason: 'isWhatCanIMakeIntent /\\bwhat\\s+can\\s+i\\s+(make|cook)\\b/ fires — ingredient-constrained query captures this phrase before chatbot fallback',
                source: 'apps/food/src/index.ts:459',
            },
        ],
    },

    {
        label: 'user has a food-related question',
        accept: [
            'how long should I cook chicken thighs?',
            "what's a good substitute for buttermilk?",
            'is it safe to eat pink salmon?',
            'what goes well with roast chicken?',
        ],
        rejectFor: [
            {
                text: 'I had pasta for lunch',
                correctLabel: 'user wants to log a meal they cooked by name with an optional portion',
                reason: 'isLogMealNLIntent /^i (had|ate)/ (line 578) runs before food-question intent (line 664) — "I had" always triggers meal-log flow',
                source: 'apps/food/src/index.ts:578',
            },
            {
                text: 'how much did we spend on food this month?',
                correctLabel: 'user wants to see food spending',
                reason: 'isBudgetViewIntent (line 650) runs before isFoodQuestionIntent (line 664); spending queries are a separate intent',
                source: 'apps/food/src/index.ts:650',
            },
        ],
    },

    {
        label: 'user wants to start cooking a recipe',
        accept: [
            "let's cook the chicken stir fry",
            'start cooking the bolognese',
            'ready to make the pasta carbonara',
            'can we cook the curry now?',
        ],
        rejectFor: [
            {
                text: 'find me a recipe for pasta',
                correctLabel: 'user wants to search for a recipe',
                reason: 'isSearchRecipeIntent (line 423) matches "find...recipe" — searching for a recipe, not starting a cook session on a known recipe',
                source: 'apps/food/src/index.ts:423',
            },
            {
                text: "let's make a meal plan for next week",
                correctLabel: 'user wants to plan meals for the week',
                reason: 'isMealPlanGenerateIntent /\\b(make)\\b.*\\b(meals?)\\b/ fires at line 441 before isCookIntent at line 706 — week-planning intent captures "make...meals" before cook intent runs',
                source: 'apps/food/src/index.ts:441',
            },
        ],
    },

    {
        label: 'user wants to check or update the pantry',
        accept: [
            "what's in the pantry?",
            'show me my pantry',
            'add chicken to the pantry',
            "what do I have in stock?",
        ],
        rejectFor: [
            {
                text: 'add eggs to the grocery list',
                correctLabel: 'user wants to add items to the grocery list',
                reason: 'isGroceryAddIntent /\\b(add)\\b.*\\b(to)\\s+(the\\s+)?(grocery)\\b/ — explicit "grocery list" routes to grocery-add, not pantry',
                source: 'apps/food/src/index.ts:3181',
            },
            {
                text: 'add eggs to the list',
                correctLabel: 'user wants to add items to the grocery list',
                reason: 'isGroceryAddIntent /\\b(add|put|get|buy)\\b.*\\b(to|on)\\s+(the\\s+)?(grocery|shopping)\\b/ may not match "the list" without grocery/shopping keyword; falls to LLM routing which typically classifies as grocery-add intent',
                source: 'apps/food/src/index.ts:3181',
            },
        ],
    },

    {
        label: 'user wants to log leftovers',
        accept: [
            "there's leftover soup from last night",
            "we've got leftover chicken in the fridge",
            'save the leftover pasta',
            "I've got some leftovers from dinner",
        ],
        rejectFor: [
            {
                text: 'I had leftover pasta for lunch',
                correctLabel: 'user wants to log a meal they cooked by name with an optional portion',
                reason: 'isLogMealNLIntent /^i (had|ate)/ (line 578) fires — "I had leftover X" is classified as a meal-log (eating leftovers), not logging that leftovers exist in the fridge',
                source: 'apps/food/src/index.ts:578',
            },
            {
                text: 'what can I make with leftover chicken?',
                correctLabel: 'user wants to know what they can make with what they have',
                reason: 'isWhatCanIMakeIntent /\\bwhat\\s+can\\s+i\\s+(make|cook)\\b/ fires at line 459 — ingredient-constrained recipe lookup, not logging that leftovers exist in the fridge',
                source: 'apps/food/src/index.ts:459',
            },
        ],
    },

    {
        label: 'user wants to plan for hosting guests',
        accept: [
            'hosting a dinner party next Saturday',
            "we're having 8 people over for dinner",
            'planning a dinner for guests',
            'need to prep for a dinner party',
        ],
        rejectFor: [
            {
                text: 'what should I cook for Christmas dinner?',
                correctLabel: 'user wants holiday or cultural recipe suggestions',
                reason: 'isCulturalCalendarIntent (line 630) runs before isHostingIntent (line 636) and matches holiday/occasion keywords; Christmas triggers cultural calendar intent',
                source: 'apps/food/src/index.ts:630',
            },
            {
                text: 'plan a menu for Thanksgiving',
                correctLabel: 'user wants holiday or cultural recipe suggestions',
                reason: 'isCulturalCalendarIntent (line 630) fires on Thanksgiving keyword; cultural calendar runs before hosting intent',
                source: 'apps/food/src/index.ts:630',
            },
        ],
    },

    {
        label: 'user wants to see food spending',
        accept: [
            'how much did we spend on food this month?',
            "show me our food budget",
            "what's our grocery spending?",
            'how much have we spent on groceries?',
        ],
        rejectFor: [
            {
                text: 'show me the grocery list',
                correctLabel: 'user wants to see or modify the grocery list',
                reason: 'isGroceryViewIntent (line 676) fires on "show...grocery list" — viewing the list, not spending data',
                source: 'apps/food/src/index.ts:676',
            },
            {
                text: 'what are the prices at Costco?',
                correctLabel: 'user asks about prices at a specific store',
                reason: 'isPriceUpdateIntent (line 567) or LLM routing sends store-price queries to the price intent; spending view is for aggregate budget, not per-store pricing',
                source: 'apps/food/src/index.ts:567',
            },
        ],
    },

    {
        // Photo-only: this intent is primarily triggered by photo messages showing receipts.
        // Text-based accept phrases are synthesized — the shadow classifier should classify
        // these NL phrasings correctly even though no regex branch claims them for text input.
        label: 'user wants to see receipt details or look up items from a receipt',
        synthesized: true,
        accept: [
            'show me the Costco receipt',
            'look up items from last week\'s grocery receipt',
            'find the receipt from Whole Foods',
        ],
        rejectFor: [
            {
                text: 'how much did we spend at Costco?',
                correctLabel: 'user wants to see food spending',
                reason: 'aggregate spending query routes to budget view; receipt lookup is for a specific receipt document, not total spend',
                source: 'apps/food/src/index.ts:650',
            },
            {
                text: 'how much are eggs at Costco?',
                correctLabel: 'user asks about prices at a specific store',
                reason: 'isPriceUpdateIntent (line 567) matches store + price queries; per-item price lookup is a different intent from receipt document lookup',
                source: 'apps/food/src/index.ts:567',
            },
        ],
    },

    {
        label: 'user asks about prices at a specific store',
        accept: [
            'how much are eggs at Costco?',
            'what does chicken cost at Whole Foods?',
            'eggs are $3.50 at Costco',
            'how much is milk at Safeway?',
        ],
        rejectFor: [
            {
                text: 'how much did we spend on groceries?',
                correctLabel: 'user wants to see food spending',
                reason: 'isBudgetViewIntent (line 650) matches aggregate spending queries; per-item store prices are a different intent',
                source: 'apps/food/src/index.ts:650',
            },
            {
                text: 'show me the Costco receipt',
                correctLabel: 'user wants to see receipt details or look up items from a receipt',
                reason: 'viewing a receipt document is distinct from asking about current store prices; receipt intent handles document lookups',
            },
        ],
    },

    {
        label: 'user wants to see nutrition information',
        accept: [
            'show me my macros',
            "what's the nutrition info for this recipe?",
            'how many calories are in this?',
            "show me today's nutrition summary",
        ],
        rejectFor: [
            {
                text: 'how am I doing on my macros?',
                correctLabel: 'user wants to see how well they are hitting their macro targets over time',
                reason: 'isAdherenceIntent (line 598) matches "how am I doing on macros" and is explicitly excluded from isNutritionViewIntent — adherence check runs first',
                source: 'apps/food/src/index.ts:598',
            },
            {
                text: 'I had pasta for dinner',
                correctLabel: 'user wants to log a meal they cooked by name with an optional portion',
                reason: 'isLogMealNLIntent (line 578) runs before isNutritionViewIntent (line 615); "I had" always routes to meal-log, not nutrition view',
                source: 'apps/food/src/index.ts:578',
            },
        ],
    },

    {
        label: 'user wants to know what they can make with what they have',
        accept: [
            'what can I make?',
            'what can I cook with what I have?',
            'what can we make with leftover chicken?',
            'what meals can I put together tonight?',
        ],
        rejectFor: [
            {
                text: "what's for dinner tonight?",
                correctLabel: "user wants to know what's for dinner",
                reason: 'isWhatsForDinnerIntent (line 453) matches /what\'s for dinner/ — consulting the meal plan, not asking what ingredients are available',
                source: 'apps/food/src/index.ts:453',
            },
            {
                text: 'find me a chicken recipe',
                correctLabel: 'user wants to search for a recipe',
                reason: 'isSearchRecipeIntent (line 423) matches "find...recipe" — open recipe search by type, not constrained by available ingredients',
                source: 'apps/food/src/index.ts:423',
            },
        ],
    },

    {
        label: 'user wants to adapt a recipe for a child',
        accept: [
            'make the chicken stir fry for Margot',
            'adapt this recipe for kids',
            'make a kid-friendly version of the curry',
            'can you simplify this recipe for Margot?',
        ],
        rejectFor: [
            {
                text: 'Margot tried peanut butter today',
                correctLabel: 'user wants to log a new food introduction for a child',
                reason: 'isFoodIntroIntent (line 531) matches child name + first-try food phrasing — introducing a new food, not adapting a recipe',
                source: 'apps/food/src/index.ts:531',
            },
            {
                text: 'Margot loved the chicken stir fry',
                correctLabel: 'user wants to tag a recipe as kid-approved or rejected',
                reason: 'isChildApprovalIntent (line 549) matches child name + reaction verb — approval/rejection tag, not recipe adaptation',
                source: 'apps/food/src/index.ts:549',
            },
        ],
    },

    {
        label: 'user wants to log a new food introduction for a child',
        accept: [
            'Margot tried peanut butter today',
            "it's Margot's first time having eggs",
            'gave Margot hummus for the first time',
            'Margot had strawberries today — first time',
        ],
        rejectFor: [
            {
                text: 'Margot loved the chicken stir fry',
                correctLabel: 'user wants to tag a recipe as kid-approved or rejected',
                reason: 'isChildApprovalIntent (line 549) matches child name + loved/hated/liked a food — recipe rating, not a first-time introduction',
                source: 'apps/food/src/index.ts:549',
            },
            {
                text: 'make the curry mild for Margot',
                correctLabel: 'user wants to adapt a recipe for a child',
                reason: 'isKidAdaptIntent (line 505) matches child name + recipe modification request',
                source: 'apps/food/src/index.ts:505',
            },
        ],
    },

    {
        label: 'user wants to tag a recipe as kid-approved or rejected',
        accept: [
            'Margot loved the chicken stir fry',
            'Margot hated the pasta with spinach',
            'Margot approved the mac and cheese',
            'kids rejected the lentil soup',
        ],
        rejectFor: [
            {
                text: 'Margot tried avocado today',
                correctLabel: 'user wants to log a new food introduction for a child',
                reason: 'isFoodIntroIntent (line 531) matches child name + first-try food phrasing (tried) — food introduction, not recipe approval',
                source: 'apps/food/src/index.ts:531',
            },
            {
                text: 'make the pasta milder for Margot',
                correctLabel: 'user wants to adapt a recipe for a child',
                reason: 'isKidAdaptIntent (line 505) matches child name + recipe modification — adapting the recipe, not rating it',
                source: 'apps/food/src/index.ts:505',
            },
        ],
    },

    {
        label: 'user wants to log a meal they cooked by name with an optional portion',
        accept: [
            'I had two slices of pizza',
            'I ate pasta carbonara for dinner',
            'just had some leftover chicken',
            'logged the salad I had for lunch',
        ],
        rejectFor: [
            {
                text: "there's leftover soup from dinner",
                correctLabel: 'user wants to log leftovers',
                reason: 'isLeftoverAddIntent /\\b(leftover|left over)\\b.*\\b(have|got|save|store|put|log)\\b/ or /\\b(there\'s|we\'ve got)\\b.*\\bleftover\\b/ — logging food in the fridge, not recording what was eaten',
                source: 'apps/food/src/index.ts:471',
            },
            {
                text: 'how many calories did I eat today?',
                correctLabel: 'user wants to see nutrition information',
                reason: 'isNutritionViewIntent (line 615) matches calorie/nutrition queries; isLogMealNLIntent exclusion regex filters out "how many" phrasings',
                source: 'apps/food/src/index.ts:615',
            },
        ],
    },

    {
        // LLM-only: no regex branch claims this label. Accept phrases are synthesized.
        // isLogMealNLIntent handles the similar "I had X" phrasing but routes named meals
        // to the named-meal-log label above; this label is for genuinely unidentifiable meals.
        label: 'user wants to log an unfamiliar meal with a free-text description',
        synthesized: true,
        accept: [
            "I had some weird grain bowl thing I can't really name",
            "I ate this stew but I have no idea what it was",
            "I just had something at my friend's — no clue what it was called",
        ],
        rejectFor: [
            {
                text: 'I had pasta for dinner',
                correctLabel: 'user wants to log a meal they cooked by name with an optional portion',
                reason: 'isLogMealNLIntent (line 578) matches "I had" + named food — pasta is a recognizable meal, routes to named-meal-log, not unfamiliar-meal',
                source: 'apps/food/src/index.ts:578',
            },
            {
                text: 'save this recipe',
                correctLabel: 'user wants to save a recipe',
                reason: 'isSaveRecipeIntent (line 417) fires on save+recipe keyword — saving a recipe is distinct from logging an unidentified meal that was eaten',
                source: 'apps/food/src/index.ts:417',
            },
        ],
    },

    {
        // LLM-only: no regex branch claims this label. Accept phrases are synthesized.
        label: 'user wants to save a frequent meal as a quick-meal template',
        synthesized: true,
        accept: [
            'save this as a quick meal',
            'add this to my quick meals',
            'make this a template for quick dinners',
        ],
        rejectFor: [
            {
                text: 'save this recipe',
                correctLabel: 'user wants to save a recipe',
                reason: 'isSaveRecipeIntent (line 417) matches save+recipe — storing a recipe in the recipe collection, not as a quick-meal shortcut',
                source: 'apps/food/src/index.ts:417',
            },
            {
                text: 'I had pasta for lunch',
                correctLabel: 'user wants to log a meal they cooked by name with an optional portion',
                reason: 'isLogMealNLIntent (line 578) fires on "I had X" — reporting a past meal, not creating a reusable quick-meal template',
                source: 'apps/food/src/index.ts:578',
            },
        ],
    },

    {
        label: 'user wants to set or change their nutrition or macro targets',
        accept: [
            'change my macro targets',
            'set my calorie goal to 2000',
            'update my protein target',
            'adjust my daily carb goal',
        ],
        rejectFor: [
            {
                text: 'how am I doing on my macros?',
                correctLabel: 'user wants to see how well they are hitting their macro targets over time',
                reason: 'isAdherenceIntent (line 598) matches "how am I doing on macros" — checking adherence, not changing targets',
                source: 'apps/food/src/index.ts:598',
            },
            {
                text: 'show me my macros',
                correctLabel: 'user wants to see nutrition information',
                reason: 'isNutritionViewIntent (line 615) matches nutrition-view queries; "show" without change/set verb routes to view, not set',
                source: 'apps/food/src/index.ts:615',
            },
        ],
    },

    {
        label: 'user wants to see how well they are hitting their macro targets over time',
        accept: [
            'how am I doing on my macros?',
            'am I hitting my calorie targets?',
            'how am I tracking with my macros this week?',
            'macro adherence for this week',
        ],
        rejectFor: [
            {
                text: 'change my calorie targets',
                correctLabel: 'user wants to set or change their nutrition or macro targets',
                reason: 'isTargetsSetIntent (line 592) matches change/set + calorie/macro targets — modifying goals, not checking adherence',
                source: 'apps/food/src/index.ts:592',
            },
            {
                text: 'show me my nutrition today',
                correctLabel: 'user wants to see nutrition information',
                reason: 'isNutritionViewIntent (line 615) matches today\'s nutrition summary — viewing logged data, not evaluating goal adherence over time',
                source: 'apps/food/src/index.ts:615',
            },
        ],
    },

    {
        label: 'user wants to understand how their diet is affecting their health or energy',
        accept: [
            'how is my diet affecting my energy levels?',
            'why do I feel so tired — could it be my food?',
            "does what I eat affect my sleep?",
            'how does my nutrition affect my health?',
        ],
        rejectFor: [
            {
                text: 'how am I doing on my macros?',
                correctLabel: 'user wants to see how well they are hitting their macro targets over time',
                reason: 'isAdherenceIntent (line 598) fires — progress-toward-goals query, not a diet-health correlation question',
                source: 'apps/food/src/index.ts:598',
            },
            {
                text: 'show me my nutrition this week',
                correctLabel: 'user wants to see nutrition information',
                reason: 'isNutritionViewIntent (line 615) handles nutrition data retrieval; health-correlation is a different, higher-level analytical intent',
                source: 'apps/food/src/index.ts:615',
            },
        ],
    },

    {
        label: 'user wants holiday or cultural recipe suggestions',
        accept: [
            'what should I cook for Thanksgiving?',
            'give me some Christmas dinner ideas',
            'what are good recipes for Eid?',
            'looking for Lunar New Year dishes',
        ],
        rejectFor: [
            {
                text: "we're having 10 people over for Thanksgiving dinner",
                correctLabel: 'user wants to plan for hosting guests',
                reason: 'isHostingIntent (line 636) may capture the "people over" phrasing; cultural intent (line 630) runs first but if it does not match, hosting takes over',
                source: 'apps/food/src/index.ts:636',
            },
            {
                text: 'plan meals for next week',
                correctLabel: 'user wants to plan meals for the week',
                reason: 'isMealPlanGenerateIntent (line 441) matches general week planning — no holiday/cultural context signals present',
                source: 'apps/food/src/index.ts:441',
            },
        ],
    },

    {
        // 'none' captures non-food messages. rejectFor documents phrases that seem
        // non-food but that Food's regex cascade actually claims.
        label: 'none',
        accept: [
            'hello there',
            "what's the weather like today?",
            'how are you doing?',
            'good morning',
            'lol that was funny',
        ],
        rejectFor: [
            {
                text: "we're out of pasta",
                correctLabel: 'user wants to check or update the pantry',
                reason: 'isPantryRemoveIntent /\\bwe\'re out of\\b/ (line 694) fires — looks like a general statement but is a pantry-remove intent trigger',
                source: 'apps/food/src/index.ts:694',
            },
            {
                text: 'Margot loved the pasta',
                correctLabel: 'user wants to tag a recipe as kid-approved or rejected',
                reason: 'isChildApprovalIntent (line 549) catches child name + loved/liked verb — appears to be a general observation but triggers kid-approval routing',
                source: 'apps/food/src/index.ts:549',
            },
        ],
    },
] as const;
