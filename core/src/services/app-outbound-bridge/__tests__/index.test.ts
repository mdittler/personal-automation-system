import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../types/config.js';
import type { InlineButton } from '../../../types/telegram.js';
import type {
	ChatSessionStore,
	SessionTurn,
} from '../../conversation-session/chat-session-store.js';
import { createAppOutboundBridge } from '../index.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function fakeChatSessions() {
	const calls: Array<{ user: SessionTurn; assistant: SessionTurn }> = [];
	const sessions: ChatSessionStore & { calls: typeof calls } = {
		calls,
		peekActive: vi.fn().mockResolvedValue('abc12345'),
		ensureActiveSession: vi.fn(),
		peekSnapshot: vi.fn(),
		appendExchange: vi.fn(async (_ctx, u: SessionTurn, a: SessionTurn) => {
			calls.push({ user: u, assistant: a });
			return { sessionId: 'abc12345' };
		}),
		loadRecentTurns: vi.fn(),
		endActive: vi.fn(),
		readSession: vi.fn(),
	} as never;
	return sessions;
}

function fakeConfig(overrides: Record<string, Record<string, unknown>> = {}): AppConfigService {
	return {
		get: vi.fn(),
		getAll: vi.fn(async (userId?: string) => overrides[userId ?? ''] ?? {}),
		getOverrides: vi.fn(),
		setAll: vi.fn(),
	} as unknown as AppConfigService;
}

describe('createAppOutboundBridge', () => {
	it('appends synthetic [App: <id>] <kind> exchange', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			household: { getHouseholdForUser: () => 'h1' } as never,
			conversationConfig: fakeConfig(),
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'weekly-menu',
			body: 'Mon: Tacos, Tue: Stew',
		});

		expect(sessions.calls).toHaveLength(1);
		expect(sessions.calls[0].user.content).toBe('[App: food] weekly-menu');
		expect(sessions.calls[0].assistant.content).toBe('Mon: Tacos, Tue: Stew');
	});

	it('appends button text from nested InlineButton[][] as [Buttons: ...] footer', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig: fakeConfig(),
			logger: noopLogger,
		});

		const buttons: InlineButton[][] = [
			[
				{ text: 'Approve', callbackData: 'a' },
				{ text: 'Reject', callbackData: 'r' },
			],
			[{ text: 'Edit', callbackData: 'e' }],
		];

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'weekly-menu',
			body: 'Plan ready.',
			buttons,
		});

		expect(sessions.calls[0].assistant.content).toBe(
			'Plan ready.\n[Buttons: Approve | Reject | Edit]',
		);
	});

	it('truncates body to MAX_BODY_LEN (1899) with ellipsis (worst-case total 1900)', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig: fakeConfig(),
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'reports',
			kind: 'weekly-spend',
			body: 'x'.repeat(5000),
		});

		expect(sessions.calls[0].assistant.content).toHaveLength(1900); // 1899 + ellipsis
		expect(sessions.calls[0].assistant.content.endsWith('…')).toBe(true);
	});

	it('returns silently when chatbot.app_message_bridge_enabled is false', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig: fakeConfig({ u1: { app_message_bridge_enabled: false } }),
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'weekly-menu',
			body: 'hi',
		});
		expect(sessions.calls).toHaveLength(0);
	});

	it('defaults opt-out to enabled when the key is missing from overrides', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig: fakeConfig({ u1: {} }),
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'weekly-menu',
			body: 'hi',
		});
		expect(sessions.calls).toHaveLength(1);
	});

	it('rejects malformed appId (caller bug — log and skip)', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig: fakeConfig(),
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'BAD APP ID',
			kind: 'x',
			body: 'hi',
		});
		expect(sessions.calls).toHaveLength(0);
		expect(noopLogger.warn).toHaveBeenCalled();
	});

	it('rejects malformed kind', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig: fakeConfig(),
			logger: noopLogger,
		});
		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'BAD KIND!!',
			body: 'hi',
		});
		expect(sessions.calls).toHaveLength(0);
	});

	it('swallows appendExchange errors (bridge fail-open)', async () => {
		const sessions = fakeChatSessions();
		(sessions.appendExchange as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('disk full'),
		);
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig: fakeConfig(),
			logger: noopLogger,
		});

		await expect(
			bridge.recordOutboundMessage({
				userId: 'u1',
				appId: 'food',
				kind: 'weekly-menu',
				body: 'hi',
			}),
		).resolves.toBeUndefined();
		expect(noopLogger.warn).toHaveBeenCalled();
	});
});
