import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { AppConfigServiceImpl } from '../../config/app-config-service.js';
import type {
	ChatSessionStore,
	SessionTurn,
} from '../../conversation-session/chat-session-store.js';
import { createAppOutboundBridge } from '../index.js';

/**
 * Integration test: exercises the bridge against a REAL `AppConfigServiceImpl`
 * (not a fake) to prove opt-out actually works through the production config
 * layer when reading/writing to disk. Required by Codex Round 1 §1.
 */

const defaults: ManifestUserConfig[] = [
	{
		key: 'app_message_bridge_enabled',
		type: 'boolean',
		default: true,
		description: 'Bridge enabled',
		label: 'Bridge enabled',
		category: 'personal',
	},
];

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

describe('AppOutboundBridge × real AppConfigServiceImpl', () => {
	let tempDir: string;
	let conversationConfig: AppConfigServiceImpl;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-bridge-cfg-'));
		conversationConfig = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'chatbot',
			defaults,
		});
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('respects an opt-out written via setAll (skips append)', async () => {
		await conversationConfig.setAll('u1', { app_message_bridge_enabled: false });
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig,
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'weekly-menu',
			body: 'hi',
		});

		expect(sessions.appendExchange).not.toHaveBeenCalled();
		expect(sessions.calls).toHaveLength(0);
	});

	it('bridges by default when no override file exists', async () => {
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig,
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'weekly-menu',
			body: 'hi',
		});

		expect(sessions.appendExchange).toHaveBeenCalledOnce();
		expect(sessions.calls[0].user.content).toBe('[App: food] weekly-menu');
		expect(sessions.calls[0].assistant.content).toBe('hi');
	});

	it('bridges when override file present but opt-out key absent', async () => {
		// Set an unrelated key so the override file exists on disk but does not
		// contain `app_message_bridge_enabled`. The default (true) should apply.
		await conversationConfig.setAll('u1', { some_other_key: 'x' });
		const sessions = fakeChatSessions();
		const bridge = createAppOutboundBridge({
			chatSessions: sessions,
			conversationConfig,
			logger: noopLogger,
		});

		await bridge.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'weekly-menu',
			body: 'hi',
		});

		expect(sessions.appendExchange).toHaveBeenCalledOnce();
	});
});
