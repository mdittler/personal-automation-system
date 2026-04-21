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
