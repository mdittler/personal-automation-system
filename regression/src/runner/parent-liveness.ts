import { Socket } from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Worker-side parent watchdog (review R1-2). The spawn keeps an extra pipe on
 * fd 3 open for the parent's whole life; EOF means the parent exited, including
 * a SIGKILL that cannot run the parent's teardown. A ppid poll covers the same
 * case when that pipe is not connected. stdin cannot be the signal: the parent
 * ends it as soon as the trial request has been written.
 */

export interface ParentLivenessOptions {
	/** Pass `null` to skip the pipe. Omit to open fd 3 (the production worker). */
	stream?: Readable | null;
	getPpid?: () => number;
	intervalMs?: number;
	exit?: (code: number) => void;
}

/** Default poll. Tests pass a shorter interval. */
const PARENT_POLL_MS = 500;

export function installParentLiveness(opts: ParentLivenessOptions = {}): () => void {
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	const getPpid = opts.getPpid ?? (() => process.ppid);
	const initialPpid = getPpid();
	const stream = 'stream' in opts ? (opts.stream ?? null) : openParentPipe();

	const state: { stopped: boolean; timer?: ReturnType<typeof setInterval> } = {
		stopped: false,
	};
	const die = () => {
		if (state.stopped) return;
		state.stopped = true;
		if (state.timer) clearInterval(state.timer);
		exit(1);
	};
	state.timer = setInterval(() => {
		if (getPpid() !== initialPpid) die();
	}, opts.intervalMs ?? PARENT_POLL_MS);
	if (typeof state.timer.unref === 'function') state.timer.unref();
	if (stream) {
		// A paused readable does not emit 'end' until something consumes it.
		let ignoreClose = false;
		stream.on('end', die);
		stream.on('close', () => {
			if (!ignoreClose) die();
		});
		stream.on('error', (err: NodeJS.ErrnoException) => {
			// fd 3 is absent when the worker is launched by hand. Keep polling ppid.
			if (err.code === 'EBADF' || err.code === 'ENXIO') {
				ignoreClose = true;
				return;
			}
			die();
		});
		stream.resume?.();
	}

	return () => {
		state.stopped = true;
		if (state.timer) clearInterval(state.timer);
		stream?.removeListener('end', die);
		stream?.removeListener('close', die);
	};
}

function openParentPipe(): Socket | null {
	try {
		// fs.ReadStream on this fd blocks a libuv threadpool thread. That read cannot
		// be unref'd, so the worker stays alive after the trial — and process.exit
		// waits on the threadpool forever. A net.Socket polls the fd; unref() keeps
		// it from holding the event loop. Construction throws when fd 3 is absent
		// (hand-launched worker); the caller then polls ppid only.
		const socket = new Socket({ fd: 3, readable: true, writable: false });
		socket.unref();
		return socket;
	} catch {
		return null;
	}
}
