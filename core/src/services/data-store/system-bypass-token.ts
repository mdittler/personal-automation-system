/**
 * Private capability token for system-level DataStore bypass.
 *
 * The symbol is created ONCE at module load — never recreated.
 * Referential equality is the capability check: any Symbol('pas.systemBypass')
 * created elsewhere will NOT equal SYSTEM_BYPASS_TOKEN.
 *
 * ONLY the following internal services may import this module:
 *   - HouseholdService
 *   - Migration runner
 *   - FileIndexService
 *   - Migration backup helper
 *
 * No app code, barrel exports, or shared utilities may import this.
 */
export const SYSTEM_BYPASS_TOKEN = Symbol('pas.systemBypass');
