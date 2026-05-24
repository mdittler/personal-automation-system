/**
 * Codex Round 1 #2 regression guard — pinning tests for the nested
 * `requestContext.run` sites in `dispatchMessage` / `dispatchPhoto` /
 * `dispatchConversation`. Each must spread the outer store first so an
 * outer `replyBuffer` (installed by `tryMultiIntentSplit`) survives the
 * nested scope. Without the spread, the buffer is dropped before any
 * handler observes it and the reply collector silently no-ops.
 *
 * REQ-ROUTE-020 — per-request AsyncLocalStorage isolation, hardened at the
 * three dispatch entry points.
 */

import { type Mock, describe, expect, it, vi } from 'vitest';
import type { RegisteredApp } from '../../app-registry/index.js';
import { requestContext } from '../../context/request-context.js';
import type { ConversationService } from '../../conversation/conversation-service.js';
import type { FlushableTelegramProxy } from '../reply-buffer-types.js';
import { buildRouter, echoManifest } from './test-helpers.js';

describe('Router nested-dispatch context merging — Codex Round 1 #2 regression guard', () => {
	it('dispatchMessage preserves outer replyBuffer (REQ-ROUTE-020)', async () => {
		const handlerObservedBuffer: unknown[] = [];
		const echoModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn(async () => {
				handlerObservedBuffer.push(requestContext.getStore()?.replyBuffer);
				return undefined;
			}),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		};
		const built = buildRouter({
			apps: [{ manifest: echoManifest, module: echoModule }],
		});

		const sentinel = { tag: 'sentinel-buffer' } as unknown as FlushableTelegramProxy;
		await requestContext.run({ userId: 'u1', replyBuffer: sentinel }, async () => {
			await built.router.dispatchMessage(
				{
					manifest: echoManifest,
					module: echoModule,
					appDir: '/apps/echo',
				} as unknown as RegisteredApp,
				{ userId: 'u1', text: 'x', timestamp: new Date(), chatId: 1, messageId: 1 },
				{
					appId: 'echo',
					intent: 'noop',
					confidence: 1,
					source: 'intent',
					verifierStatus: 'not-run',
				},
			);
		});

		expect(handlerObservedBuffer).toEqual([sentinel]);
	});

	it('dispatchPhoto preserves outer replyBuffer', async () => {
		const seen: unknown[] = [];
		const echoModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn(async () => {
				seen.push(requestContext.getStore()?.replyBuffer);
				return undefined;
			}),
		};
		const built = buildRouter({
			apps: [{ manifest: echoManifest, module: echoModule }],
		});

		const sentinel = { tag: 'photo-sentinel' } as unknown as FlushableTelegramProxy;
		await requestContext.run({ userId: 'u1', replyBuffer: sentinel }, async () => {
			await built.router.dispatchPhoto(
				{
					manifest: echoManifest,
					module: echoModule,
					appDir: '/apps/echo',
				} as unknown as RegisteredApp,
				{
					userId: 'u1',
					photo: Buffer.alloc(0),
					caption: 'x',
					mimeType: 'image/jpeg',
					timestamp: new Date(),
					chatId: 1,
					messageId: 1,
				},
				{
					appId: 'echo',
					intent: 'noop',
					confidence: 1,
					source: 'photo-intent',
					verifierStatus: 'not-run',
				},
			);
		});

		expect(seen).toEqual([sentinel]);
	});

	it('dispatchConversation preserves outer replyBuffer when ConversationService is wired', async () => {
		const seen: unknown[] = [];
		const conversationService = {
			handleMessage: vi.fn(async () => {
				seen.push(requestContext.getStore()?.replyBuffer);
				return undefined;
			}),
		} as unknown as ConversationService;

		const built = buildRouter({ conversationService });

		const sentinel = { tag: 'conv-sentinel' } as unknown as FlushableTelegramProxy;
		await requestContext.run({ userId: 'u1', replyBuffer: sentinel }, async () => {
			await built.router.dispatchConversation(
				{ userId: 'u1', text: 'hi', timestamp: new Date(), chatId: 1, messageId: 1 },
				{
					appId: 'chatbot',
					intent: 'chatbot',
					confidence: 1,
					source: 'fallback',
					verifierStatus: 'not-run',
				},
			);
		});

		expect(seen).toEqual([sentinel]);
		expect((conversationService.handleMessage as Mock).mock.calls).toHaveLength(1);
	});
});
