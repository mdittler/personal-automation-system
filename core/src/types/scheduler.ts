/**
 * Scheduler types.
 *
 * The scheduler handles recurring cron jobs (declared in manifests)
 * and dynamic one-off tasks (scheduled programmatically by apps).
 */

/** A recurring scheduled job, derived from a manifest declaration. */
export interface ScheduledJob {
	/** Unique job ID (scoped to app). */
	id: string;
	/** ID of the app that owns this job. */
	appId: string;
	/** Standard 5-field cron expression. */
	cron: string;
	/** Handler file path relative to app root. */
	handler: string;
	/** Human-readable description. */
	description: string;
	/** Scope: 'all' = per user, 'shared' = once for shared data, 'system' = once. */
	userScope: 'all' | 'shared' | 'system';
}

/** A dynamic one-off task, stored in data/system/scheduled-jobs.yaml. */
export interface OneOffTask {
	/** Composite ID: appId + jobId. */
	id: string;
	/** ID of the app that created this task. */
	appId: string;
	/** App-defined job ID. */
	jobId: string;
	/** When to execute. */
	runAt: Date;
	/** Handler file path relative to app root. */
	handler: string;
	/** When this task was created. */
	createdAt: Date;
}

/** Result of a scheduled job execution. */
export interface JobExecutionResult {
	/** The job that was executed. */
	jobId: string;
	/** The app that owns the job. */
	appId: string;
	/** When execution started. */
	startedAt: Date;
	/** When execution completed. */
	completedAt: Date;
	/** Whether the job succeeded. */
	success: boolean;
	/** Error message if the job failed. */
	error?: string;
}

/** Scheduler service provided to apps via CoreServices. */
export interface SchedulerService {
	/**
	 * Schedule a one-off job at a specific datetime.
	 * For recurring jobs, use cron in the manifest instead.
	 */
	scheduleOnce(appId: string, jobId: string, runAt: Date, handler: string): Promise<void>;

	/** Cancel a pending one-off job. */
	cancelOnce(appId: string, jobId: string): Promise<void>;
}
