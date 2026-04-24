/**
 * Minimal notification interface for scheduled job lifecycle events.
 * Separated from JobFailureNotifier for testability — tests can use
 * plain object literals without casting.
 */
export interface SchedulerJobNotifier {
	/** Check if a job is currently disabled (e.g., after repeated failures). */
	isDisabled(appId: string, jobId: string): boolean;
	/** Report a job failure. Returns true if job was auto-disabled. */
	onFailure(appId: string, jobId: string, error: string): Promise<boolean>;
	/** Report a job success. Resets failure counters. */
	onSuccess(appId: string, jobId: string): void;
	/** Re-enable a previously disabled job. Optional so lightweight test doubles stay simple. */
	reEnable?(appId: string, jobId: string): void;
	/** Return all currently disabled job keys. Optional admin/introspection surface. */
	getDisabledJobs?(): string[];
	/** Return the consecutive failure count for a job. Optional admin/introspection surface. */
	getFailureCount?(appId: string, jobId: string): number;
}
