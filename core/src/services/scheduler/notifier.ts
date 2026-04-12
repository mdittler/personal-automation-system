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
}
