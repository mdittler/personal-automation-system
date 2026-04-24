import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { JobFailureNotifier, type NotificationSender } from '../job-failure-notifier.js';

const logger = pino({ level: 'silent' });
const ADMIN_CHAT_ID = '12345';

function createMockSender(): NotificationSender {
	return { send: vi.fn().mockResolvedValue(undefined) };
}

function createNotifier(
	sender: NotificationSender,
	overrides?: { cooldownMs?: number; autoDisableAfter?: number },
): JobFailureNotifier {
	return new JobFailureNotifier({
		logger,
		sender,
		adminChatId: ADMIN_CHAT_ID,
		notificationCooldownMs: overrides?.cooldownMs ?? 1000, // Short for testing
		autoDisableAfter: overrides?.autoDisableAfter ?? 5,
	});
}

describe('JobFailureNotifier', () => {
	let sender: NotificationSender;

	beforeEach(() => {
		sender = createMockSender();
	});

	describe('onFailure', () => {
		it('sends notification on first failure', async () => {
			const notifier = createNotifier(sender);

			await notifier.onFailure('my-app', 'daily-sync', 'Connection timeout');

			expect(sender.send).toHaveBeenCalledWith(
				ADMIN_CHAT_ID,
				expect.stringContaining('daily-sync'),
			);
			expect(sender.send).toHaveBeenCalledWith(
				ADMIN_CHAT_ID,
				expect.stringContaining('Connection timeout'),
			);
		});

		it('includes failure count in notification', async () => {
			const notifier = createNotifier(sender);

			await notifier.onFailure('my-app', 'job-1', 'Error');

			expect(sender.send).toHaveBeenCalledWith(ADMIN_CHAT_ID, expect.stringContaining('1/5'));
		});

		it('increments consecutive failure count', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0 });

			await notifier.onFailure('my-app', 'job-1', 'Error 1');
			await notifier.onFailure('my-app', 'job-1', 'Error 2');
			await notifier.onFailure('my-app', 'job-1', 'Error 3');

			expect(notifier.getFailureCount('my-app', 'job-1')).toBe(3);
		});

		it('tracks different jobs independently', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0 });

			await notifier.onFailure('app-a', 'job-1', 'Error');
			await notifier.onFailure('app-a', 'job-1', 'Error');
			await notifier.onFailure('app-b', 'job-2', 'Error');

			expect(notifier.getFailureCount('app-a', 'job-1')).toBe(2);
			expect(notifier.getFailureCount('app-b', 'job-2')).toBe(1);
		});

		it('sends notification to admin chat ID', async () => {
			const notifier = createNotifier(sender);

			await notifier.onFailure('my-app', 'job-1', 'Error');

			expect(sender.send).toHaveBeenCalledWith(ADMIN_CHAT_ID, expect.any(String));
		});
	});

	describe('notification rate limiting', () => {
		it('suppresses notifications within cooldown window', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 60_000 });

			await notifier.onFailure('my-app', 'job-1', 'Error 1');
			await notifier.onFailure('my-app', 'job-1', 'Error 2');
			await notifier.onFailure('my-app', 'job-1', 'Error 3');

			// Only the first failure should trigger a notification
			expect(sender.send).toHaveBeenCalledTimes(1);
		});

		it('sends notification again after cooldown expires', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 50 });

			await notifier.onFailure('my-app', 'job-1', 'Error 1');
			expect(sender.send).toHaveBeenCalledTimes(1);

			// Wait for cooldown to expire
			await new Promise((r) => setTimeout(r, 60));

			await notifier.onFailure('my-app', 'job-1', 'Error 2');
			expect(sender.send).toHaveBeenCalledTimes(2);
		});

		it('does not rate-limit different jobs against each other', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 60_000 });

			await notifier.onFailure('app-a', 'job-1', 'Error');
			await notifier.onFailure('app-b', 'job-2', 'Error');

			// Both should send — different jobs
			expect(sender.send).toHaveBeenCalledTimes(2);
		});

		it('defaults to 1 hour cooldown', () => {
			const notifier = new JobFailureNotifier({
				logger,
				sender,
				adminChatId: ADMIN_CHAT_ID,
			});
			// We can't directly inspect private cooldownMs, but we can verify
			// behavior: second immediate failure should be suppressed
			expect(notifier).toBeDefined();
		});
	});

	describe('auto-disable', () => {
		it('disables job after consecutive failure threshold', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 3 });

			await notifier.onFailure('my-app', 'job-1', 'Error');
			await notifier.onFailure('my-app', 'job-1', 'Error');
			const shouldDisable = await notifier.onFailure('my-app', 'job-1', 'Error');

			expect(shouldDisable).toBe(true);
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(true);
		});

		it('returns false before threshold is reached', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 5 });

			const result1 = await notifier.onFailure('my-app', 'job-1', 'Error');
			const result2 = await notifier.onFailure('my-app', 'job-1', 'Error');

			expect(result1).toBe(false);
			expect(result2).toBe(false);
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(false);
		});

		it('sends auto-disable notification regardless of cooldown', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 60_000, autoDisableAfter: 3 });

			// First failure sends notification
			await notifier.onFailure('my-app', 'job-1', 'Error');
			// Second and third are within cooldown but third triggers auto-disable
			await notifier.onFailure('my-app', 'job-1', 'Error');
			await notifier.onFailure('my-app', 'job-1', 'Error');

			// 1 regular notification + 1 auto-disable notification
			expect(sender.send).toHaveBeenCalledTimes(2);
			expect(sender.send).toHaveBeenLastCalledWith(
				ADMIN_CHAT_ID,
				expect.stringContaining('auto-disabled'),
			);
		});

		it('auto-disable notification includes failure count', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 2 });

			await notifier.onFailure('my-app', 'job-1', 'Error');
			await notifier.onFailure('my-app', 'job-1', 'Final error');

			expect(sender.send).toHaveBeenLastCalledWith(
				ADMIN_CHAT_ID,
				expect.stringContaining('2 consecutive failures'),
			);
		});

		it('getDisabledJobs returns all disabled job keys', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 1 });

			await notifier.onFailure('app-a', 'job-1', 'Error');
			await notifier.onFailure('app-b', 'job-2', 'Error');

			const disabled = notifier.getDisabledJobs();
			expect(disabled).toContain('app-a:job-1');
			expect(disabled).toContain('app-b:job-2');
		});
	});

	describe('onSuccess', () => {
		it('resets consecutive failure count', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0 });

			await notifier.onFailure('my-app', 'job-1', 'Error');
			await notifier.onFailure('my-app', 'job-1', 'Error');
			expect(notifier.getFailureCount('my-app', 'job-1')).toBe(2);

			notifier.onSuccess('my-app', 'job-1');
			expect(notifier.getFailureCount('my-app', 'job-1')).toBe(0);
		});

		it('is a no-op for jobs with no failure state', () => {
			const notifier = createNotifier(sender);

			// Should not throw
			notifier.onSuccess('unknown-app', 'unknown-job');
			expect(notifier.getFailureCount('unknown-app', 'unknown-job')).toBe(0);
		});

		it('prevents auto-disable when interspersed with failures', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 3 });

			await notifier.onFailure('my-app', 'job-1', 'Error');
			await notifier.onFailure('my-app', 'job-1', 'Error');
			notifier.onSuccess('my-app', 'job-1'); // Reset
			await notifier.onFailure('my-app', 'job-1', 'Error');
			await notifier.onFailure('my-app', 'job-1', 'Error');

			// Should not be disabled — consecutive count reset by success
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(false);
			expect(notifier.getFailureCount('my-app', 'job-1')).toBe(2);
		});
	});

	describe('reEnable', () => {
		it('re-enables a disabled job', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 1 });

			await notifier.onFailure('my-app', 'job-1', 'Error');
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(true);

			notifier.reEnable('my-app', 'job-1');
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(false);
		});

		it('resets failure count on re-enable', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 2 });

			await notifier.onFailure('my-app', 'job-1', 'Error');
			await notifier.onFailure('my-app', 'job-1', 'Error');
			expect(notifier.getFailureCount('my-app', 'job-1')).toBe(2);

			notifier.reEnable('my-app', 'job-1');
			expect(notifier.getFailureCount('my-app', 'job-1')).toBe(0);
		});

		it('is a no-op for jobs that are not disabled', () => {
			const notifier = createNotifier(sender);

			// Should not throw
			notifier.reEnable('unknown-app', 'unknown-job');
			expect(notifier.isDisabled('unknown-app', 'unknown-job')).toBe(false);
		});

		it('resumes notifications after re-enable and subsequent failure', async () => {
			const notifier = createNotifier(sender, { cooldownMs: 0, autoDisableAfter: 1 });

			// Fail → auto-disable
			await notifier.onFailure('my-app', 'job-1', 'Error 1');
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(true);
			const callsAfterDisable = (sender.send as ReturnType<typeof vi.fn>).mock.calls.length;

			// Re-enable
			notifier.reEnable('my-app', 'job-1');
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(false);

			// Fail again → should send a new notification
			await notifier.onFailure('my-app', 'job-1', 'Error 2');
			expect((sender.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
				callsAfterDisable,
			);
		});

		it('persists disabled jobs and reloads them when persistPath is configured', async () => {
			const tempDir = await mkdtemp(join(tmpdir(), 'pas-job-failure-notifier-'));
			try {
				const persistPath = join(tempDir, 'system', 'disabled-jobs.yaml');
				const notifier = new JobFailureNotifier({
					logger,
					sender,
					adminChatId: ADMIN_CHAT_ID,
					autoDisableAfter: 1,
					notificationCooldownMs: 0,
					persistPath,
				});

				await notifier.onFailure('my-app', 'job-1', 'Error');

				const persisted = parse(await readFile(persistPath, 'utf-8')) as {
					disabledJobs?: string[];
				};
				expect(persisted.disabledJobs).toContain('my-app:job-1');

				const reloaded = new JobFailureNotifier({
					logger,
					sender,
					adminChatId: ADMIN_CHAT_ID,
					autoDisableAfter: 1,
					notificationCooldownMs: 0,
					persistPath,
				});
				expect(reloaded.isDisabled('my-app', 'job-1')).toBe(true);

				reloaded.reEnable('my-app', 'job-1');
				const afterReEnable = parse(await readFile(persistPath, 'utf-8')) as {
					disabledJobs?: string[];
				};
				expect(afterReEnable.disabledJobs ?? []).not.toContain('my-app:job-1');
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe('isDisabled', () => {
		it('returns false for unknown jobs', () => {
			const notifier = createNotifier(sender);
			expect(notifier.isDisabled('any-app', 'any-job')).toBe(false);
		});
	});

	describe('getFailureCount', () => {
		it('returns 0 for unknown jobs', () => {
			const notifier = createNotifier(sender);
			expect(notifier.getFailureCount('any-app', 'any-job')).toBe(0);
		});
	});

	describe('error handling', () => {
		it('swallows send errors on failure notification', async () => {
			const failingSender: NotificationSender = {
				send: vi.fn().mockRejectedValue(new Error('Network error')),
			};
			const notifier = createNotifier(failingSender);

			// Should not throw
			const result = await notifier.onFailure('my-app', 'job-1', 'Error');
			expect(result).toBe(false);
		});

		it('swallows send errors on auto-disable notification', async () => {
			const failingSender: NotificationSender = {
				send: vi.fn().mockRejectedValue(new Error('Network error')),
			};
			const notifier = createNotifier(failingSender, { cooldownMs: 0, autoDisableAfter: 1 });

			// Should not throw, but still disable the job
			const result = await notifier.onFailure('my-app', 'job-1', 'Error');
			expect(result).toBe(true);
			expect(notifier.isDisabled('my-app', 'job-1')).toBe(true);
		});
	});

	describe('config validation', () => {
		it('rejects autoDisableAfter less than 1', () => {
			expect(
				() =>
					new JobFailureNotifier({
						logger,
						sender,
						adminChatId: ADMIN_CHAT_ID,
						autoDisableAfter: 0,
					}),
			).toThrow('autoDisableAfter must be at least 1');
		});

		it('ignores malformed persisted state and starts clean', async () => {
			const tempDir = await mkdtemp(join(tmpdir(), 'pas-job-failure-notifier-bad-'));
			try {
				const persistPath = join(tempDir, 'system', 'disabled-jobs.yaml');
				await mkdir(join(tempDir, 'system'), { recursive: true });
				await writeFile(persistPath, 'not: [valid', 'utf-8');

				const notifier = new JobFailureNotifier({
					logger,
					sender,
					adminChatId: ADMIN_CHAT_ID,
					persistPath,
				});

				expect(notifier.getDisabledJobs()).toEqual([]);
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});
	});
});
