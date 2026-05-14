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
import {
	DEFAULT_KEEPALIVE_MS,
	type SseChannel,
	openSseStream,
	writeSseEvent,
} from '../sse-helper.js';

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
		// Initial `retry:` directive lands immediately (REQ-REG-GUI-V2-021).
		// The keep-alive check is: AFTER that initial write, no further
		// writes until keepAliveMs elapses; THEN a comment ping appears.
		const initialWrites = reply.written.length;
		expect(reply.written.join('')).toContain('retry:');
		vi.advanceTimersByTime(1000);
		expect(reply.written.length).toBeGreaterThan(initialWrites);
		const afterTick = reply.written.slice(initialWrites).join('');
		expect(afterTick).toMatch(/^:\s*keepalive/);
	});

	it('writes initial "retry: 3000\\n\\n" directive (REQ-REG-GUI-V2-021)', () => {
		const req = makeRequest();
		const reply = makeReply();
		openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		expect(reply.written.join('')).toContain('retry: 3000\n\n');
	});

	it('default keep-alive is 15s (REQ-REG-GUI-V2-021)', () => {
		expect(DEFAULT_KEEPALIVE_MS).toBe(15_000);
	});

	it('with default keepAliveMs (no override), a ping fires at the 15s mark', () => {
		const req = makeRequest();
		const reply = makeReply();
		openSseStream(req as never, reply as never);
		const initialWrites = reply.written.length;
		vi.advanceTimersByTime(15_000);
		expect(reply.written.length).toBeGreaterThan(initialWrites);
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

	it('writes "id: <n>\\n" line when id is provided (REQ-REG-GUI-V2-021)', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		writeSseEvent(channel, { type: 'case-completed', data: { caseId: 'a' }, id: 7 });
		const joined = reply.written.join('');
		expect(joined).toContain('id: 7\nevent: case-completed\n');
	});

	it('omits "id:" line when id is undefined (synthetic frames like gap)', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		writeSseEvent(channel, { type: 'gap', data: {} });
		const joined = reply.written.join('');
		// Find the frame after the initial retry directive:
		const frames = joined.split('\n\n').filter((f) => f.includes('event:'));
		expect(frames[0]).not.toMatch(/^id:/);
		expect(frames[0]).toContain('event: gap');
	});

	it('handles id=0 (first event) — writes "id: 0" (no truthy-check bug)', () => {
		const req = makeRequest();
		const reply = makeReply();
		const channel = openSseStream(req as never, reply as never, { keepAliveMs: 25_000 });
		writeSseEvent(channel, { type: 'case-completed', data: { caseId: 'a' }, id: 0 });
		expect(reply.written.join('')).toContain('id: 0\n');
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
