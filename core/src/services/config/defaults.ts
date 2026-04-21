export const DEFAULT_LLM_SAFEGUARDS = Object.freeze({
    defaultRateLimit: Object.freeze({ maxRequests: 60, windowSeconds: 3600 }),
    defaultMonthlyCostCap: 10,
    globalMonthlyCostCap: 50,
    defaultHouseholdRateLimit: Object.freeze({ maxRequests: 200, windowSeconds: 3600 }),
    defaultHouseholdMonthlyCostCap: 20,
    defaultReservationUsd: 0.05,
    reservationExpiryMs: 60_000,
}) as const;
