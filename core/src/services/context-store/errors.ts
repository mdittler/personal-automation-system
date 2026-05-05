/**
 * Custom error types for the context store service.
 */

/**
 * Thrown by `ContextStoreServiceImpl.save()` when content is rejected by the
 * threat scanner. The `pattern` field identifies which rule matched.
 *
 * The matched substring is intentionally NOT included to prevent PII leakage.
 */
export class ContextStoreThreatError extends Error {
	constructor(public readonly pattern: string) {
		super(`Content rejected by threat scan: pattern=${pattern}`);
		this.name = 'ContextStoreThreatError';
	}
}
