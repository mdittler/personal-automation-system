const _defaults = {
	defaultRateLimit: { maxRequests: 60, windowSeconds: 3600 },
	defaultMonthlyCostCap: 10,
	globalMonthlyCostCap: 50,
	defaultHouseholdRateLimit: { maxRequests: 200, windowSeconds: 3600 },
	defaultHouseholdMonthlyCostCap: 20,
	defaultReservationUsd: 0.05,
	reservationExpiryMs: 60_000,
} as const;

export const DEFAULT_LLM_SAFEGUARDS: typeof _defaults = Object.freeze({
	defaultRateLimit: Object.freeze(_defaults.defaultRateLimit),
	defaultMonthlyCostCap: _defaults.defaultMonthlyCostCap,
	globalMonthlyCostCap: _defaults.globalMonthlyCostCap,
	defaultHouseholdRateLimit: Object.freeze(_defaults.defaultHouseholdRateLimit),
	defaultHouseholdMonthlyCostCap: _defaults.defaultHouseholdMonthlyCostCap,
	defaultReservationUsd: _defaults.defaultReservationUsd,
	reservationExpiryMs: _defaults.reservationExpiryMs,
});

/**
 * Default list of intents that MUST go through route verification even when
 * the LLM classifier's confidence is above `routing.verification.upper_bound`.
 *
 * Why a non-empty default: the original "inviting people" mis-route bug
 * (Task 3.1) fired at confidence >= 0.7, so a `[]` default would leave fresh
 * deployments vulnerable until the operator manually edits pas.yaml.
 * Defaulting in code means every install is protected out of the box; the
 * operator can override via `routing.verification.always_verify_intents`.
 *
 * The exact string must match `apps/food/src/routing/food-intents.ts`'s
 * `HOSTING_MEAL_PLANNING_INTENT`. Core cannot import from `apps/`, so the
 * literal is duplicated here intentionally; the Food contract test
 * (`shadow-taxonomy.contract.test.ts`) keeps the manifest / shadow taxonomy /
 * persona in sync with that constant.
 */
export const DEFAULT_ALWAYS_VERIFY_INTENTS: readonly string[] = Object.freeze([
	'user wants to plan a meal or menu for a dinner party or guests they are hosting',
]);

/**
 * Default value for `routing.multi_intent_split`.
 *
 * Defaults IN CODE to `true` so the multi-intent-message bug is fixed in
 * production on merge without a config edit (operator's explicit decision —
 * multi-question messages were silently dropping a question). Operators can
 * set `routing.multi_intent_split: false` in pas.yaml to kill-switch the
 * feature if it misbehaves.
 *
 * Same rationale as `DEFAULT_ALWAYS_VERIFY_INTENTS`: fresh deployments must
 * be protected without operator action (Codex review feedback on Task 3.2).
 */
export const DEFAULT_MULTI_INTENT_SPLIT = true;
