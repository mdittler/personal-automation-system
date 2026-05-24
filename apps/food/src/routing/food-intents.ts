/**
 * Single-sourced constants for Food app intent strings.
 *
 * Why: the LLM intent classifier matches user messages against intent
 * description strings. When the same string appears in many places
 * (manifest.yaml + multiple TS files + tests), they drift — and a drifted
 * routing label can mis-classify messages. The contract test
 * `shadow-taxonomy.contract.test.ts` asserts every TS copy of these
 * strings imports from here and that the manifest.yaml literal matches.
 *
 * Background: an earlier hosting-guests intent (see git history for the
 * pre-rename text) mis-classified platform-invite questions ("inviting
 * people") to the Food hosting handler because of semantic overlap. The
 * renamed string is anchored on meal/menu/dinner-party to disambiguate.
 */
export const HOSTING_MEAL_PLANNING_INTENT =
	'user wants to plan a meal or menu for a dinner party or guests they are hosting' as const;
