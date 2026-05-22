/**
 * Tests for the Food sendProactiveMessage helper. The helper is the single
 * Food-app path for proactive (app-initiated, non-reply) Telegram sends. It
 * must pair every Telegram send with an `appOutboundBridge.recordOutboundMessage`
 * call so the chatbot transcript records the message and Gus can answer
 * follow-up questions about it.
 *
 * Covered cases (one named test each):
 *   (a) with buttons → sendWithButtons + recordOutboundMessage + returns SentMessage
 *   (b) no buttons → send + helper returns undefined
 *   (c) RAW body passthrough — bytes passed to Telegram == bytes recorded
 *   (d) Telegram rejects → helper rejects AND bridge NOT called
 *   (e) bridge fail-open — bridge rejects but Telegram succeeded → helper resolves + logger.warn
 *   (f) appOutboundBridge undefined → Telegram still sends and helper resolves
 */

import type { CoreServices } from '@pas/core/types';
import { describe, expect, test, vi } from 'vitest';
import { sendProactiveMessage } from '../../utils/proactive-message.js';

function mockServices(over: Record<string, unknown> = {}): CoreServices {
	return {
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 100, messageId: 7 }),
		},
		appOutboundBridge: { recordOutboundMessage: vi.fn().mockResolvedValue(undefined) },
		logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
		...over,
	} as unknown as CoreServices;
}

describe('sendProactiveMessage', () => {
	test('(a) with buttons: sends, records the raw body, and returns the SentMessage', async () => {
		const s = mockServices();
		const buttons = [[{ text: 'Freeze', callbackData: 'f:0' }]];
		const sent = await sendProactiveMessage(s, {
			userId: 'u1',
			kind: 'batch-prep',
			body: 'raw <body>',
			buttons,
		});

		expect(sent).toEqual({ chatId: 100, messageId: 7 });
		expect(s.telegram.sendWithButtons).toHaveBeenCalledTimes(1);
		expect(s.telegram.sendWithButtons).toHaveBeenCalledWith('u1', 'raw <body>', buttons);
		expect(s.telegram.send).not.toHaveBeenCalled();
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		expect(s.appOutboundBridge!.recordOutboundMessage).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		expect(s.appOutboundBridge!.recordOutboundMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u1',
				appId: 'food',
				kind: 'batch-prep',
				body: 'raw <body>',
				buttons,
			}),
		);
	});

	test('(b) no buttons: sends plain text and returns undefined', async () => {
		const s = mockServices();
		const result = await sendProactiveMessage(s, {
			userId: 'u2',
			kind: 'nightly-rating-prompt',
			body: 'How was dinner?',
		});

		expect(result).toBeUndefined();
		expect(s.telegram.send).toHaveBeenCalledTimes(1);
		expect(s.telegram.send).toHaveBeenCalledWith('u2', 'How was dinner?');
		expect(s.telegram.sendWithButtons).not.toHaveBeenCalled();
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		expect(s.appOutboundBridge!.recordOutboundMessage).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		expect(s.appOutboundBridge!.recordOutboundMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'u2',
				appId: 'food',
				kind: 'nightly-rating-prompt',
				body: 'How was dinner?',
			}),
		);
	});

	test('(c) RAW body passthrough: bytes sent to Telegram are byte-identical to bytes recorded on the bridge', async () => {
		const s = mockServices();
		// Use a body with markdown, HTML-ish chars, unicode, and whitespace
		// that any naive sanitizer would mangle. The helper must NOT touch it.
		const rawBody = '*Bold* <tag> — café 🍣\n\nLine2  spaces  ';

		await sendProactiveMessage(s, {
			userId: 'u3',
			kind: 'freezer-check',
			body: rawBody,
		});

		expect(s.telegram.send).toHaveBeenCalledTimes(1);
		const telegramBody = (s.telegram.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		expect(s.appOutboundBridge!.recordOutboundMessage).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		const recordArgs = (s.appOutboundBridge!.recordOutboundMessage as ReturnType<typeof vi.fn>).mock
			.calls[0][0];

		expect(telegramBody).toBe(rawBody);
		expect(recordArgs.body).toBe(rawBody);
		// Strict byte-equality cross-check
		expect(Buffer.from(recordArgs.body, 'utf8').equals(Buffer.from(telegramBody, 'utf8'))).toBe(
			true,
		);
	});

	test('(d) telegram.send rejects: helper rejects and bridge is NOT called', async () => {
		const s = mockServices({
			telegram: {
				send: vi.fn().mockRejectedValue(new Error('tg down')),
				sendWithButtons: vi.fn(),
			},
		});

		await expect(
			sendProactiveMessage(s, { userId: 'u4', kind: 'freezer-check', body: 'x' }),
		).rejects.toThrow('tg down');
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		expect(s.appOutboundBridge!.recordOutboundMessage).not.toHaveBeenCalled();
	});

	test('(d2) telegram.sendWithButtons rejects: helper rejects and bridge is NOT called', async () => {
		const s = mockServices({
			telegram: {
				send: vi.fn(),
				sendWithButtons: vi.fn().mockRejectedValue(new Error('tg buttons down')),
			},
		});

		await expect(
			sendProactiveMessage(s, {
				userId: 'u4b',
				kind: 'batch-prep',
				body: 'x',
				buttons: [[{ text: 'OK', callbackData: 'ok' }]],
			}),
		).rejects.toThrow('tg buttons down');
		// biome-ignore lint/style/noNonNullAssertion: mock services always provide the bridge
		expect(s.appOutboundBridge!.recordOutboundMessage).not.toHaveBeenCalled();
	});

	test('(e) bridge fail-open: bridge rejection after a successful send is swallowed and logged', async () => {
		const s = mockServices({
			appOutboundBridge: {
				recordOutboundMessage: vi.fn().mockRejectedValue(new Error('bridge down')),
			},
		});

		await expect(
			sendProactiveMessage(s, { userId: 'u5', kind: 'freezer-check', body: 'still works' }),
		).resolves.toBeUndefined();

		expect(s.telegram.send).toHaveBeenCalledTimes(1);
		// biome-ignore lint/suspicious/noExplicitAny: accessing the mocked logger
		expect((s as any).logger.warn).toHaveBeenCalledTimes(1);
	});

	test('(f) appOutboundBridge undefined: Telegram still sends and helper resolves without throwing', async () => {
		const s = mockServices({ appOutboundBridge: undefined });

		await expect(
			sendProactiveMessage(s, { userId: 'u6', kind: 'leftover-check', body: 'msg' }),
		).resolves.toBeUndefined();

		expect(s.telegram.send).toHaveBeenCalledTimes(1);
		expect(s.telegram.send).toHaveBeenCalledWith('u6', 'msg');
	});
});
