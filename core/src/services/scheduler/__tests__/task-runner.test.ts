import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { runTask } from '../task-runner.js';

const logger = pino({ level: 'silent' });

describe('runTask', () => {
	it('returns success result on successful execution', async () => {
		const handler = vi.fn().mockResolvedValue(undefined);

		const result = await runTask('app-1', 'job-1', handler, logger);

		expect(result.success).toBe(true);
		expect(result.appId).toBe('app-1');
		expect(result.jobId).toBe('job-1');
		expect(result.startedAt).toBeInstanceOf(Date);
		expect(result.completedAt).toBeInstanceOf(Date);
		expect(result.completedAt.getTime()).toBeGreaterThanOrEqual(result.startedAt.getTime());
		expect(result.error).toBeUndefined();
	});

	it('returns failure result on handler error', async () => {
		const handler = vi.fn().mockRejectedValue(new Error('handler crashed'));

		const result = await runTask('app-1', 'job-fail', handler, logger);

		expect(result.success).toBe(false);
		expect(result.error).toBe('handler crashed');
		expect(result.appId).toBe('app-1');
		expect(result.jobId).toBe('job-fail');
		expect(result.startedAt).toBeInstanceOf(Date);
		expect(result.completedAt).toBeInstanceOf(Date);
	});

	it('handles non-Error thrown values', async () => {
		const handler = vi.fn().mockRejectedValue('string error');

		const result = await runTask('app-1', 'job-str', handler, logger);

		expect(result.success).toBe(false);
		expect(result.error).toBe('string error');
	});

	it('does not throw — errors are captured in result', async () => {
		const handler = vi.fn().mockRejectedValue(new Error('boom'));

		// This should NOT throw
		await expect(runTask('app-1', 'job-x', handler, logger)).resolves.toBeDefined();
	});

	it('calls the handler exactly once', async () => {
		const handler = vi.fn().mockResolvedValue(undefined);

		await runTask('app-1', 'job-once', handler, logger);

		expect(handler).toHaveBeenCalledOnce();
	});
});
