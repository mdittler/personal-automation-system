/**
 * sse-helper tests (Codex I8).
 *
 * Verifies the Fastify hijack-pattern SSE helper:
 *   - SSE headers set on the raw response
 *   - events serialized correctly (`event: <type>\ndata: <json>\n\n`)
 *   - keep-alive pings while connection is open
 *   - cleanup on terminal event (raw.end() + interval cleared)
 *   - cleanup on client disconnect
 *   - no double-cleanup
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SseChannel, openSseStream, writeSseEvent } from '../sse-helper.js';

interface FakeReply {
	hijacked: boolean;
	headersWritten: { status: number; headers: Record<string, string> } | null;
	written: string[];
	ended: boolean;
	hijack(): void;
	raw: {
		writeHead: (status: number, headers: Record<string, string>) => void;
		write: (chunk: string) => boolean;
		end: () => void;
		destroyed: boolean;
	};
}

interface FakeRequest {
	raw: EventEmitter;
}

function makeReply(): FakeReply {
	const r: FakeReply = {
		hijacked: false,
		headersWritten: null,
		written: [],
		ended: false,
		hijack() {
			this.hijacked = true;
		},
		raw: {
			writeHead: (status, headers) => {
				r.headersWritten = { status, headers };
			},
			write: (chunk) => {
				r.written.push(chunk);
				return true;
			},
			end: () => {
				r.ended = true;
				r.raw.destroyed = true;
			},
			destroyed: false,
		},
	};
	return r;
}

function makeRequest(): FakeRequest {
	return { raw: new EventEmitter() };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('openSseStream — connection setup', () => {
	it('hijacks the reply and writes SSE headers', () => {
		const req = makeRequest();
		const reply = makeReply();
		openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		expect(reply.hijacked).toBe(true);
		expect(reply.headersWritten?.status).toBe(200);
		expect(reply.headersWritten?.headers['Content-Type']).toBe('text/event-stream');
		expect(reply.headersWritten?.headers['Cache-Control']).toContain('no-cache');
		expect(reply.headersWritten?.headers.Connection).toBe('keep-alive');
		expect(reply.headersWritten?.headers['X-Accel-Buffering']).toBe('no');
	});

	it('keep-alive comment is written every keepAliveMs', () => {
		const req = makeRequest();
		const reply = makeReply();
		openSseStream(req as never, reply as never, { keepAliveMs: 1000 });
		expect(reply.written.length).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(reply.written.some((c) => c.includes(':'))).toBe(true);
	});
});

describe('writeSseEvent — payload format', () => {
	it('writes "event: <type>\\ndata: <json>\\n\\n"', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		writeSseEvent(channel, { type: 'case-completed', data: { caseId: 'a' } });
		const joined = reply.written.join('');
		expect(joined).toContain('event: case-completed\n');
		expect(joined).toContain('data: {"caseId":"a"}\n\n');
	});

	it('JSON.stringify escapes newlines so data: stays single-line', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		writeSseEvent(channel, { type: 'case-completed', data: { msg: 'line1\nline2' } });
		const joined = reply.written.join('');
		// The data: line itself must not contain a real newline that would
		// truncate the SSE event prematurely.
		const dataLine = joined.split('\n').find((l) => l.startsWith('data:'));
		expect(dataLine).toContain('line1\\nline2');
	});

	it('does not write when channel is closed (no-op)', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		channel.close();
		const writtenBefore = reply.written.length;
		writeSseEvent(channel, { type: 'late', data: {} });
		expect(reply.written.length).toBe(writtenBefore);
	});
});

describe('channel.close — cleanup (Codex I8)', () => {
	it('writes reply.raw.end() exactly once', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		channel.close();
		expect(reply.ended).toBe(true);
		channel.close(); // idempotent
		expect(reply.ended).toBe(true);
	});

	it('stops emitting keep-alive after close', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 1000 });
		channel.close();
		const writtenAtClose = reply.written.length;
		vi.advanceTimersByTime(5000);
		expect(reply.written.length).toBe(writtenAtClose);
	});

	it('client-disconnect close event triggers cleanup', () => {
		const req = makeRequest();
		const reply = makeReply();
		openSseStream(req as never, reply as never, { keepAliveMs: 1000 });
		(req.raw as EventEmitter).emit('close');
		// After client disconnect, keep-alive should stop:
		const writtenAtDisconnect = reply.written.length;
		vi.advanceTimersByTime(5000);
		expect(reply.written.length).toBe(writtenAtDisconnect);
	});
});

describe('terminal-event close pattern', () => {
	it('writes terminal event and closes (single-shot pattern)', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel: SseChannel = openSseStream(req as never, reply as never, {
			keepAliveMs: 25_000,
		});
		writeSseEvent(channel, { type: 'case-completed', data: { caseId: 'a' } });
		writeSseEvent(channel, { type: 'complete', data: { exitCode: 0 } });
		channel.close();
		expect(reply.ended).toBe(true);
		const joined = reply.written.join('');
		expect(joined).toContain('event: complete');
	});
});
