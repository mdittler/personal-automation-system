/**
 * Job failure notification service.
 *
 * Sends Telegram notifications to the admin when scheduled jobs fail.
 * Rate-limited to avoid notification spam: at most one notification
 * per job per cooldown window (default 1 hour).
 *
 * Supports remote deactivation: after a configurable number of
 * consecutive failures, the job is auto-disabled and the admin is
 * notified. Disabled jobs can be re-enabled via the management GUI
 * or by editing the disabled-jobs YAML file.
 *
 * URS-SCH-005 — Failed job notification.
 */

import type { Logger } from 'pino';
import type { SchedulerJobNotifier } from './notifier.js';

/** Minimal Telegram send interface to avoid circular dependencies. */
export interface NotificationSender {
	send(chatId: string, text: string): Promise<void>;
}

export interface JobFailureNotifierOptions {
	logger: Logger;
	sender: NotificationSender;
	/** Telegram chat ID of the admin user. */
	adminChatId: string;
	/** Minimum ms between notifications for the same job (default: 1 hour). */
	notificationCooldownMs?: number;
	/** Number of consecutive failures before auto-disabling a job (default: 5). */
	autoDisableAfter?: number;
}

interface JobFailureState {
	/** Timestamp of the last notification sent for this job. */
	lastNotifiedAt: number;
	/** Number of consecutive failures (resets on success). */
	consecutiveFailures: number;
}

export class JobFailureNotifier implements SchedulerJobNotifier {
	private readonly logger: Logger;
	private readonly sender: NotificationSender;
	private readonly adminChatId: string;
	private readonly cooldownMs: number;
	private readonly autoDisableAfter: number;

	/** Per-job failure tracking. Key = "appId:jobId". */
	private readonly state = new Map<string, JobFailureState>();
	/** Set of disabled job keys. */
	private readonly disabledJobs = new Set<string>();

	constructor(options: JobFailureNotifierOptions) {
		this.logger = options.logger;
		this.sender = options.sender;
		this.adminChatId = options.adminChatId;
		this.cooldownMs = options.notificationCooldownMs ?? 60 * 60 * 1000; // 1 hour
		this.autoDisableAfter = options.autoDisableAfter ?? 5;

		if (this.autoDisableAfter < 1) {
			throw new Error('autoDisableAfter must be at least 1');
		}
	}

	/**
	 * Report a job failure. May send a notification if the cooldown has elapsed.
	 * Returns true if the job should be disabled (consecutive failure threshold reached).
	 */
	async onFailure(appId: string, jobId: string, error: string): Promise<boolean> {
		const key = `${appId}:${jobId}`;
		const now = Date.now();

		let jobState = this.state.get(key);
		if (!jobState) {
			jobState = { lastNotifiedAt: 0, consecutiveFailures: 0 };
			this.state.set(key, jobState);
		}

		jobState.consecutiveFailures++;

		// Check if auto-disable threshold reached
		if (jobState.consecutiveFailures >= this.autoDisableAfter) {
			this.disabledJobs.add(key);

			// Always notify on auto-disable (ignore cooldown)
			try {
				await this.sender.send(
					this.adminChatId,
					`⚠️ Job "${jobId}" (app: ${appId}) has been auto-disabled after ${jobState.consecutiveFailures} consecutive failures.\n\nLast error: ${error}\n\nRe-enable via the management GUI.`,
				);
			} catch (sendErr) {
				this.logger.warn({ error: sendErr }, 'Failed to send auto-disable notification');
			}

			this.logger.warn(
				{ appId, jobId, failures: jobState.consecutiveFailures },
				'Job auto-disabled after consecutive failures',
			);
			return true;
		}

		// Rate-limited notification
		if (now - jobState.lastNotifiedAt >= this.cooldownMs) {
			jobState.lastNotifiedAt = now;

			try {
				await this.sender.send(
					this.adminChatId,
					`❌ Job "${jobId}" (app: ${appId}) failed.\n\nError: ${error}\n\nFailure #${jobState.consecutiveFailures}/${this.autoDisableAfter} before auto-disable.`,
				);
			} catch (sendErr) {
				this.logger.warn({ error: sendErr }, 'Failed to send failure notification');
			}
		}

		return false;
	}

	/**
	 * Report a job success. Resets consecutive failure counter.
	 */
	onSuccess(appId: string, jobId: string): void {
		const key = `${appId}:${jobId}`;
		const jobState = this.state.get(key);
		if (jobState) {
			jobState.consecutiveFailures = 0;
		}
	}

	/**
	 * Check if a job is disabled due to consecutive failures.
	 */
	isDisabled(appId: string, jobId: string): boolean {
		return this.disabledJobs.has(`${appId}:${jobId}`);
	}

	/**
	 * Re-enable a previously disabled job.
	 */
	reEnable(appId: string, jobId: string): void {
		const key = `${appId}:${jobId}`;
		this.disabledJobs.delete(key);

		// Reset failure counter on re-enable
		const jobState = this.state.get(key);
		if (jobState) {
			jobState.consecutiveFailures = 0;
		}

		this.logger.info({ appId, jobId }, 'Job re-enabled');
	}

	/**
	 * Get all currently disabled job keys.
	 */
	getDisabledJobs(): string[] {
		return Array.from(this.disabledJobs);
	}

	/**
	 * Get the consecutive failure count for a job.
	 */
	getFailureCount(appId: string, jobId: string): number {
		return this.state.get(`${appId}:${jobId}`)?.consecutiveFailures ?? 0;
	}
}
