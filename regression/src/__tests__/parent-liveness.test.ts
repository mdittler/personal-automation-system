import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installParentLiveness } from '../runner/parent-liveness.js';

describe('installParentLiveness (review R1-2)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('worker exits when its parent-liveness signal fires', async () => {
		const exit = vi.fn();
		const stream = new PassThrough();
		const stop = installParentLiveness({
			stream,
			getPpid: () => 100,
			intervalMs: 60_000,
			exit,
		});
		expect(exit).not.toHaveBeenCalled();
		stream.end();
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
		stop();
	});

	it('worker exits when the parent pid changes', () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		let ppid = 100;
		const stop = installParentLiveness({
			stream: null,
			getPpid: () => ppid,
			intervalMs: 25,
			exit,
		});
		vi.advanceTimersByTime(25);
		expect(exit).not.toHaveBeenCalled();
		ppid = 1;
		vi.advanceTimersByTime(25);
		expect(exit).toHaveBeenCalledWith(1);
		stop();
	});
});
