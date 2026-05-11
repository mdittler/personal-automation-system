/**
 * Fastify SSE helper (Codex I8).
 *
 * No reference SSE pattern exists elsewhere in `core/src/gui/`, so this
 * module is the canonical implementation. The contract:
 *
 *   1. `openSseStream(request, reply, opts)` — hijacks the reply, writes
 *      SSE headers, registers a `request.raw.on('close')` cleanup, and
 *      starts a keep-alive interval. Returns an `SseChannel`.
 *   2. `writeSseEvent(channel, event)` — writes one SSE frame
 *      (`event: <type>\ndata: <single-line-json>\n\n`).
 *   3. `channel.close()` — clears the keep-alive interval and ends the
 *      raw response. Idempotent. Subsequent `writeSseEvent` calls are
 *      no-ops.
 *
 * `data:` values are `JSON.stringify`-ed so embedded newlines become
 * `\n` escapes and the SSE frame remains single-line per the spec.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseChannel {
	readonly closed: boolean;
	write(line: string): void;
	close(): void;
}

export interface OpenSseOptions {
	keepAliveMs?: number;
	/**
	 * Called exactly once when the channel closes (client disconnect, error,
	 * explicit `channel.close()`, or process write failure). Use this to
	 * detach any registry listeners attached by the route handler — otherwise
	 * a closed client leaves a listener registered until the run's terminal
	 * event fires or the run is GC'd (Codex P2).
	 */
	onClose?: () => void;
}

const DEFAULT_KEEPALIVE_MS = 25_000;

export function openSseStream(
	request: FastifyRequest,
	reply: FastifyReply,
	options: OpenSseOptions = {},
): SseChannel {
	reply.hijack();
	const raw = reply.raw as unknown as {
		writeHead: (status: number, headers: Record<string, string>) => void;
		write: (chunk: string) => boolean;
		end: () => void;
		destroyed?: boolean;
	};
	raw.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});

	let closed = false;
	const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
	const keepAlive = setInterval(() => {
		if (closed) return;
		try {
			raw.write(': keepalive\n\n');
		} catch {
			cleanup();
		}
	}, keepAliveMs);

	function cleanup(): void {
		if (closed) return;
		closed = true;
		clearInterval(keepAlive);
		try {
			raw.end();
		} catch {
			/* swallow — connection may already be torn down */
		}
		options.onClose?.();
	}

	(request.raw as { on: (e: string, cb: () => void) => void }).on('close', cleanup);
	(request.raw as { on: (e: string, cb: () => void) => void }).on('error', cleanup);

	return {
		get closed() {
			return closed;
		},
		write(line: string) {
			if (closed) return;
			try {
				raw.write(line);
			} catch {
				cleanup();
			}
		},
		close() {
			cleanup();
		},
	};
}

export interface SseEvent {
	type: string;
	data: unknown;
}

export function writeSseEvent(channel: SseChannel, event: SseEvent): void {
	if (channel.closed) return;
	// JSON.stringify ensures embedded newlines become `\n` so the SSE
	// frame remains a single `data:` line per the spec.
	const payload = JSON.stringify(event.data ?? null);
	channel.write(`event: ${event.type}\ndata: ${payload}\n\n`);
}
