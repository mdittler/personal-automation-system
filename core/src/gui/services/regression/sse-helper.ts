/**
 * Fastify SSE helper. Canonical implementation — no reference pattern
 * elsewhere in `core/src/gui/`.
 *
 * `openSseStream` hijacks the reply, writes SSE headers + an initial
 * `retry:` directive, registers cleanup on close/error, and starts a
 * keep-alive interval. `writeSseEvent` writes one frame; the optional
 * `id` is what the browser caches as `Last-Event-ID` for reconnect.
 * `channel.close()` is idempotent.
 *
 * 15s keep-alive is half the typical reverse-proxy idle window
 * (30–60s); the comment ping is a single byte so wire cost is trivial.
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

export const DEFAULT_KEEPALIVE_MS = 15_000;
const RETRY_AFTER_MS = 3000;

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

	// Initial retry directive: browsers cache it for the lifetime of the
	// EventSource and reuse across every built-in reconnect.
	try {
		raw.write(`retry: ${RETRY_AFTER_MS}\n\n`);
	} catch {
		/* connection already gone — cleanup runs via request close/error listeners */
	}

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
	/** Browser caches this as `Last-Event-ID` for reconnect. Omit for
	 *  synthetic control frames like `gap`. */
	id?: number;
}

export function writeSseEvent(channel: SseChannel, event: SseEvent): void {
	if (channel.closed) return;
	// JSON.stringify ensures embedded newlines become `\n` so the SSE
	// frame remains a single `data:` line per the spec.
	const payload = JSON.stringify(event.data ?? null);
	const idLine = event.id !== undefined ? `id: ${event.id}\n` : '';
	channel.write(`${idLine}event: ${event.type}\ndata: ${payload}\n\n`);
}
