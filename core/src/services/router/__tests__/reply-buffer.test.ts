/**
 * REQ-ROUTE-017/018/019/019b/020/021 — unit coverage for
 * `BufferingTelegramProxy`. The buffer wraps an inner `TelegramService` (the
 * REAL transport per the compose-runtime split — Codex Round 1 #3) and
 * collects plain `send` calls per userId until `flushPending` emits them as
 * one (or as few as possible) combined Telegram message(s).
 */

import { describe, expect, it, vi } from 'vitest';
import type { InlineButton, SentMessage, TelegramService } from '../../../types/telegram.js';
import { BufferingTelegramProxy } from '../reply-buffer.js';

function makeInnerStub(): {
	inner: TelegramService;
	calls: Array<{ method: string; args: unknown[] }>;
} {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const inner: TelegramService = {
		send: vi.fn(async (...args: unknown[]) => {
			calls.push({ method: 'send', args });
		}),
		sendPhoto: vi.fn(async (...args: unknown[]) => {
			calls.push({ method: 'sendPhoto', args });
		}),
		sendOptions: vi.fn(async (...args: unknown[]) => {
			calls.push({ method: 'sendOptions', args });
			return (args[2] as string[])[0] ?? '';
		}),
		sendWithButtons: vi.fn(async (...args: unknown[]) => {
			calls.push({ method: 'sendWithButtons', args });
			return { chatId: 1, messageId: 1 } as SentMessage;
		}),
		editMessage: vi.fn(async (...args: unknown[]) => {
			calls.push({ method: 'editMessage', args });
		}),
	} as unknown as TelegramService;
	return { inner, calls };
}

describe('BufferingTelegramProxy — happy path (REQ-ROUTE-017)', () => {
	it('buffers plain `send` calls; final flush emits one combined message', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.send('u1', 'Segment 1 reply');
		await proxy.send('u1', 'Segment 2 reply');
		await proxy.send('u1', 'Segment 3 reply');
		expect(calls).toHaveLength(0); // nothing emitted yet
		await proxy.flushPending('u1');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: 'send',
			args: ['u1', 'Segment 1 reply\n\nSegment 2 reply\n\nSegment 3 reply'],
		});
	});

	it('flushPending on an empty buffer is a no-op', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.flushPending('u1');
		expect(calls).toHaveLength(0);
	});
});

describe('BufferingTelegramProxy — length splitting (REQ-ROUTE-018)', () => {
	it('auto-splits at segment boundaries when total exceeds maxLength', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 50 });
		await proxy.send('u1', 'A'.repeat(30));
		await proxy.send('u1', 'B'.repeat(30)); // 30+2+30 = 62 > 50
		await proxy.flushPending('u1');
		// Two separate messages, never breaking mid-segment.
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ method: 'send', args: ['u1', 'A'.repeat(30)] });
		expect(calls[1]).toEqual({ method: 'send', args: ['u1', 'B'.repeat(30)] });
	});

	it('packs as many segments as fit per message', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 50 });
		await proxy.send('u1', 'A'.repeat(15));
		await proxy.send('u1', 'B'.repeat(15)); // 15+2+15 = 32 ≤ 50 — combined
		await proxy.send('u1', 'C'.repeat(40)); // 32+2+40 = 74 > 50 — new chunk
		await proxy.flushPending('u1');
		expect(calls).toHaveLength(2);
		expect(calls[0]?.args[1]).toBe(`${'A'.repeat(15)}\n\n${'B'.repeat(15)}`);
		expect(calls[1]?.args[1]).toBe('C'.repeat(40));
	});

	it('hard-splits a single segment longer than maxLength (preserves all content)', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 50 });
		await proxy.send('u1', 'X'.repeat(120)); // single segment far over limit
		await proxy.flushPending('u1');
		// Expect ≥2 messages of ≤50 chars each, content fully preserved when concatenated.
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const concatenated = calls.map((c) => c.args[1] as string).join('');
		expect(concatenated).toBe('X'.repeat(120));
		for (const c of calls) {
			expect((c.args[1] as string).length).toBeLessThanOrEqual(50);
		}
	});
});

describe('BufferingTelegramProxy — rich sends flush + pass through (REQ-ROUTE-019)', () => {
	it('sendPhoto flushes pending text then delegates to inner', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.send('u1', 'pending text');
		const buf = Buffer.from([0, 1, 2]);
		await proxy.sendPhoto('u1', buf, 'caption');
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ method: 'send', args: ['u1', 'pending text'] });
		expect(calls[1]).toEqual({ method: 'sendPhoto', args: ['u1', buf, 'caption'] });
	});

	it('sendWithButtons flushes pending text then delegates', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.send('u1', 'pending text');
		// Codex Round 1 #9: InlineButton uses `callbackData`, not `callback_data`.
		const buttons: InlineButton[][] = [[{ text: 'Yes', callbackData: 'y' }]];
		const result = await proxy.sendWithButtons('u1', 'Confirm?', buttons);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe('send');
		expect(calls[1]?.method).toBe('sendWithButtons');
		expect(result).toEqual({ chatId: 1, messageId: 1 });
	});

	it('sendOptions flushes pending text then delegates', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.send('u1', 'pending text');
		const choice = await proxy.sendOptions('u1', 'pick', ['a', 'b']);
		expect(choice).toBe('a');
		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe('send');
		expect(calls[1]?.method).toBe('sendOptions');
	});

	it('editMessage passes through immediately (no flush) — REQ-ROUTE-019b', async () => {
		// Codex Round 1 #10 decision: editMessage targets a prior message id, never
		// an ordering-dependent reply, so it bypasses the buffer entirely.
		// REQ-ROUTE-019 (rich sends flush + pass through) excludes editMessage.
		// REQ-ROUTE-019b documents the bypass.
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.send('u1', 'pending text');
		await proxy.editMessage(1, 1, 'edited', undefined);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ method: 'editMessage', args: [1, 1, 'edited', undefined] });
		// Flushing afterwards still emits the pending text.
		await proxy.flushPending('u1');
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ method: 'send', args: ['u1', 'pending text'] });
	});
});

describe('BufferingTelegramProxy — per-user isolation (REQ-ROUTE-020)', () => {
	it('separates buffers across userIds', async () => {
		const { inner, calls } = makeInnerStub();
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.send('u1', 'A');
		await proxy.send('u2', 'B');
		await proxy.send('u1', 'C');
		await proxy.flushPending('u1');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ method: 'send', args: ['u1', 'A\n\nC'] });
		await proxy.flushPending('u2');
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ method: 'send', args: ['u2', 'B'] });
	});
});

describe('BufferingTelegramProxy — error handling (REQ-ROUTE-021)', () => {
	it('inner send rejection on flush propagates; buffer is cleared (no double-flush)', async () => {
		const inner: TelegramService = {
			send: vi.fn(async () => {
				throw new Error('telegram api down');
			}),
			sendPhoto: vi.fn(),
			sendOptions: vi.fn(),
			sendWithButtons: vi.fn(),
			editMessage: vi.fn(),
		} as unknown as TelegramService;
		const proxy = new BufferingTelegramProxy({ inner, maxLength: 4000 });
		await proxy.send('u1', 'segment 1');
		await expect(proxy.flushPending('u1')).rejects.toThrow('telegram api down');
		// Second flush is a no-op (buffer cleared after the failed attempt)
		await expect(proxy.flushPending('u1')).resolves.toBeUndefined();
		expect((inner.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});
});
