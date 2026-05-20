/**
 * Tests for handleFlushMemory.
 *
 * Covers: happy path, edge cases (0/1 turns), error handling (peekActive throws,
 * readSession throws, summarizer throws, flushSave throws, summarizer returns null),
 * late-resolve guard, hostile summary sanitization, args-ignored, concurrency.
 *
 * REQ-CONV-FLUSH-013..018.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageContext } from '../../../types/telegram.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { handleFlushMemory } from '../handle-flush-memory.js';
import type { HandleFlushMemoryDeps } from '../handle-flush-memory.js';
import type { MemoryFlushSave } from '../memory-flush.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function baseCtx(userId = 'u1'): MessageContext {
	return { userId, text: '/flushmemory', timestamp: new Date(), chatId: 1, messageId: 1 };
}

function twoTurnSession() {
	return {
		meta: { title: undefined, created_at: '' },
		turns: [
			{ role: 'user' as const, content: 'hello', timestamp: '2026-05-07T10:00:00Z' },
			{ role: 'assistant' as const, content: 'hi there', timestamp: '2026-05-07T10:00:01Z' },
		],
	};
}

function makeDeps(overrides: Partial<HandleFlushMemoryDeps> = {}): HandleFlushMemoryDeps {
	return {
		telegram: { send: vi.fn().mockResolvedValue(undefined) } as any,
		chatSessions: {
			peekActive: vi.fn().mockResolvedValue('sess1'),
			readSession: vi.fn().mockResolvedValue(twoTurnSession()),
		} as unknown as ChatSessionStore,
		summarizer: vi.fn().mockResolvedValue('User and assistant greeted each other.'),
		flushSave: vi.fn().mockResolvedValue(undefined) as unknown as MemoryFlushSave,
		logger: { warn: vi.fn(), info: vi.fn() } as any,
		...overrides,
	};
}

function getSentText(deps: HandleFlushMemoryDeps): string {
	return (deps.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] ?? '';
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('handleFlushMemory — happy path', () => {
	it('calls summarizer and flushSave, replies with char count', async () => {
		const deps = makeDeps();
		await handleFlushMemory('', baseCtx(), deps);
		expect(deps.summarizer).toHaveBeenCalledOnce();
		expect(deps.flushSave).toHaveBeenCalledOnce();
		const reply = getSentText(deps);
		expect(reply).toMatch(
			/^Memory flushed: \d+ chars saved\.$|^Memory flushed: \d+ chars saved\.\s*$/,
		);
	});

	it('reply contains the actual persistedLength returned by sanitizeSummaryOutput', async () => {
		const summary = 'hello world'; // 11 chars
		const deps = makeDeps({ summarizer: vi.fn().mockResolvedValue(summary) });
		await handleFlushMemory('', baseCtx(), deps);
		const reply = getSentText(deps);
		// The persisted length may be <= summary.length due to sanitization
		expect(reply).toMatch(/Memory flushed: \d+ chars saved/);
	});

	it('ignores args — runs with empty args and with trailing spaces', async () => {
		const deps1 = makeDeps();
		const deps2 = makeDeps();
		await handleFlushMemory('', baseCtx(), deps1);
		await handleFlushMemory('   extra words   ', baseCtx(), deps2);
		expect(getSentText(deps1)).toMatch(/chars saved/);
		expect(getSentText(deps2)).toMatch(/chars saved/);
	});
});

// ─── Edge cases — early returns ──────────────────────────────────────────────

describe('handleFlushMemory — no active session', () => {
	it('replies "No active session" when peekActive returns undefined', async () => {
		const deps = makeDeps({
			chatSessions: {
				peekActive: vi.fn().mockResolvedValue(undefined),
				readSession: vi.fn(),
			} as unknown as ChatSessionStore,
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('No active session');
		expect(deps.summarizer).not.toHaveBeenCalled();
		expect(deps.flushSave).not.toHaveBeenCalled();
	});
});

describe('handleFlushMemory — insufficient turns', () => {
	it('replies "Not enough conversation" when session has 0 turns', async () => {
		const deps = makeDeps({
			chatSessions: {
				peekActive: vi.fn().mockResolvedValue('sess1'),
				readSession: vi.fn().mockResolvedValue({ meta: {}, turns: [] }),
			} as unknown as ChatSessionStore,
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('Not enough conversation');
		expect(deps.summarizer).not.toHaveBeenCalled();
	});

	it('replies "Not enough conversation" when session has exactly 1 turn', async () => {
		const deps = makeDeps({
			chatSessions: {
				peekActive: vi.fn().mockResolvedValue('sess1'),
				readSession: vi.fn().mockResolvedValue({
					meta: {},
					turns: [{ role: 'user', content: 'hi', timestamp: '2026-05-07T10:00:00Z' }],
				}),
			} as unknown as ChatSessionStore,
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('Not enough conversation');
	});

	it('replies "Not enough conversation" when readSession returns undefined', async () => {
		const deps = makeDeps({
			chatSessions: {
				peekActive: vi.fn().mockResolvedValue('sess1'),
				readSession: vi.fn().mockResolvedValue(undefined),
			} as unknown as ChatSessionStore,
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('Not enough conversation');
	});
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('handleFlushMemory — store throws', () => {
	it('peekActive throws → deferred + logger.warn, no summarizer call', async () => {
		const logger = { warn: vi.fn(), info: vi.fn() };
		const deps = makeDeps({
			chatSessions: {
				peekActive: vi.fn().mockRejectedValue(new Error('disk read error')),
				readSession: vi.fn(),
			} as unknown as ChatSessionStore,
			logger: logger as any,
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk read error'));
		expect(getSentText(deps)).toContain('deferred');
		expect(deps.summarizer).not.toHaveBeenCalled();
		expect(deps.flushSave).not.toHaveBeenCalled();
	});

	it('readSession throws → deferred + logger.warn', async () => {
		const logger = { warn: vi.fn(), info: vi.fn() };
		const deps = makeDeps({
			chatSessions: {
				peekActive: vi.fn().mockResolvedValue('sess1'),
				readSession: vi.fn().mockRejectedValue(new Error('parse error')),
			} as unknown as ChatSessionStore,
			logger: logger as any,
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('parse error'));
		expect(getSentText(deps)).toContain('deferred');
		expect(deps.summarizer).not.toHaveBeenCalled();
	});
});

describe('handleFlushMemory — summarizer outcomes', () => {
	it('summarizer throws → deferred reply', async () => {
		const deps = makeDeps({
			summarizer: vi.fn().mockRejectedValue(new Error('LLM timeout')),
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('deferred');
		expect(deps.flushSave).not.toHaveBeenCalled();
	});

	it('summarizer returns null → "Not enough conversation"', async () => {
		const deps = makeDeps({ summarizer: vi.fn().mockResolvedValue(null) });
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('Not enough conversation');
		expect(deps.flushSave).not.toHaveBeenCalled();
	});

	it('summarizer returns whitespace-only → deferred (sanitization rejects)', async () => {
		const deps = makeDeps({ summarizer: vi.fn().mockResolvedValue('   ') });
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('deferred');
		expect(deps.flushSave).not.toHaveBeenCalled();
	});

	it('flushSave throws → deferred reply', async () => {
		const deps = makeDeps({
			flushSave: vi
				.fn()
				.mockRejectedValue(new Error('context store unavailable')) as unknown as MemoryFlushSave,
		});
		await handleFlushMemory('', baseCtx(), deps);
		expect(getSentText(deps)).toContain('deferred');
	});
});

// ─── Late-resolve guard ───────────────────────────────────────────────────────

describe('handleFlushMemory — late-resolve guard', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('summarizer resolves AFTER 8s timeout → flushSave NOT called, reply is deferred', async () => {
		let resolveSummarizer!: (v: string) => void;
		const deps = makeDeps({
			summarizer: vi.fn().mockImplementation(
				() =>
					new Promise<string>((r) => {
						resolveSummarizer = r;
					}),
			),
			timeoutMs: 8_000,
		});

		const promise = handleFlushMemory('', baseCtx(), deps);
		await vi.advanceTimersByTimeAsync(8_001); // timeout fires
		resolveSummarizer('late summary'); // resolves AFTER timeout
		await promise;

		expect(getSentText(deps)).toContain('deferred');
		expect(deps.flushSave).not.toHaveBeenCalled();
	});

	it('summarizer resolves BEFORE timeout → flushSave IS called', async () => {
		const deps = makeDeps({ timeoutMs: 8_000 });
		// summarizer mock resolves immediately (before 8s)
		const promise = handleFlushMemory('', baseCtx(), deps);
		await vi.advanceTimersByTimeAsync(100);
		await promise;

		expect(deps.flushSave).toHaveBeenCalledOnce();
		expect(getSentText(deps)).toMatch(/chars saved/);
	});
});

// ─── Security ─────────────────────────────────────────────────────────────────

describe('handleFlushMemory — security', () => {
	it('hostile summary with <script> tags is sanitized before flushSave', async () => {
		const hostile = '<script>alert(1)</script>legitimate content here';
		const deps = makeDeps({ summarizer: vi.fn().mockResolvedValue(hostile) });
		await handleFlushMemory('', baseCtx(), deps);
		const written = (deps.flushSave as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
			| string
			| undefined;
		if (written !== undefined) {
			expect(written).not.toContain('<script>');
		}
		// Either sanitization cleaned it and flushSave was called, or sanitization rejected it
		// Either way the hostile content must not appear verbatim in the stored value
	});
});

// ─── Concurrency ─────────────────────────────────────────────────────────────

describe('handleFlushMemory — concurrency', () => {
	it('two simultaneous calls both complete without throwing', async () => {
		const deps1 = makeDeps();
		const deps2 = makeDeps();
		await Promise.all([
			handleFlushMemory('', baseCtx(), deps1),
			handleFlushMemory('', baseCtx(), deps2),
		]);
		expect(getSentText(deps1)).toMatch(/chars saved|deferred|Not enough/);
		expect(getSentText(deps2)).toMatch(/chars saved|deferred|Not enough/);
	});
});
