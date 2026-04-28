/**
 * Persona tests — /newchat and /reset literal-only matching.
 *
 * Documents that /newchat and /reset are LITERAL commands only.
 * Natural-language phrasings ("start over", "wipe context", etc.) are NOT
 * handled by handleNewChat — they route to free-text (handleMessage).
 * Natural-language /newchat intent is a P7 feature (see docs/open-items.md).
 *
 * I.2 — Literal matches invoke handleNewChat.
 * I.3 — Natural language phrasings route to handleMessage, not handleNewChat.
 * I.4 — Multi-step end-to-end scenarios using real ChatSessionStore.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext } from '../../../types/telegram.js';
import { ManifestCache, type AppRegistry, type RegisteredApp } from '../../app-registry/index.js';
import { Router } from '../../router/index.js';
import type { FallbackHandler } from '../../router/fallback.js';
import type { SystemConfig } from '../../../types/config.js';
import { composeChatSessionStore } from '../compose.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { CONVERSATION_DATA_SCOPES } from '../../conversation/manifest.js';

// ---------------------------------------------------------------------------
// Router infrastructure (minimal inline setup for routing tests)
// ---------------------------------------------------------------------------

const chatbotManifest: AppManifest = {
	app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Chatbot', author: 'Test' },
	capabilities: { messages: {} },
};

function makeConvSvc() {
	return {
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
	};
}

function createConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'test' },
		claude: { apiKey: 'test', model: 'test' },
		gui: { authToken: 'test' },
		cloudflare: {},
		users: [{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
	};
}

function buildRouter(conv: ReturnType<typeof makeConvSvc>) {
	const cache = new ManifestCache();
	cache.add(chatbotManifest, '/apps/chatbot');
	const registry = {
		getApp: (id: string) =>
			id === 'chatbot'
				? ({ manifest: chatbotManifest, module: { init: vi.fn(), handleMessage: vi.fn() } as any, appDir: '/apps/chatbot' } as RegisteredApp)
				: undefined,
		getManifestCache: () => cache,
		getLoadedAppIds: () => ['chatbot'],
	} as unknown as AppRegistry;
	const telegram = {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn(),
		sendOptions: vi.fn().mockResolvedValue('Cancel'),
		sendWithButtons: vi.fn(),
		editMessage: vi.fn(),
	};
	const router = new Router({
		registry,
		llm: { complete: vi.fn().mockResolvedValue('ok'), classify: vi.fn(), extractStructured: vi.fn() } as any,
		telegram: telegram as any,
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config: createConfig(),
		logger: pino({ level: 'silent' }),
		conversationService: conv as any,
	});
	router.buildRoutingTables();
	return router;
}

function msg(text: string): MessageContext {
	return { userId: 'user1', text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ---------------------------------------------------------------------------
// I.2 — Literal-only matches invoke handleNewChat
// ---------------------------------------------------------------------------

describe('I.2 — /newchat and /reset literal commands invoke handleNewChat', () => {
	it('/newchat invokes handleNewChat', async () => {
		const conv = makeConvSvc();
		await buildRouter(conv).routeMessage(msg('/newchat'));
		expect(conv.handleNewChat).toHaveBeenCalledOnce();
		expect(conv.handleMessage).not.toHaveBeenCalled();
	});

	it('/reset invokes handleNewChat', async () => {
		const conv = makeConvSvc();
		await buildRouter(conv).routeMessage(msg('/reset'));
		expect(conv.handleNewChat).toHaveBeenCalledOnce();
		expect(conv.handleMessage).not.toHaveBeenCalled();
	});

	it('/newchat@PASBot invokes handleNewChat (Telegram @bot suffix)', async () => {
		const conv = makeConvSvc();
		await buildRouter(conv).routeMessage(msg('/newchat@PASBot'));
		expect(conv.handleNewChat).toHaveBeenCalledOnce();
	});

	it('/reset@PASBot invokes handleNewChat (Telegram @bot suffix)', async () => {
		const conv = makeConvSvc();
		await buildRouter(conv).routeMessage(msg('/reset@PASBot'));
		expect(conv.handleNewChat).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// I.3 — Natural language phrasings route to free-text (handleMessage), NOT handleNewChat
//
// Natural-language /newchat intent is a P7 feature (intent learning + NLP routing).
// These phrasings are intentionally NOT handled by handleNewChat in P3.
// ---------------------------------------------------------------------------

describe('I.3 — Natural language phrasings route to free-text, not handleNewChat', () => {
	const NOT_NEWCHAT_PHRASES = [
		'start over',
		"let's start fresh",
		'new chat please',
		'wipe context',
		'begin again',
		'reset our conversation',
		'newchat is a cool word',
		'tell me about resets in physics',
		'I new the chat would help',
		'reset my password',
	];

	for (const phrase of NOT_NEWCHAT_PHRASES) {
		it(`"${phrase}" routes to handleMessage, not handleNewChat`, async () => {
			const conv = makeConvSvc();
			await buildRouter(conv).routeMessage(msg(phrase));
			expect(conv.handleNewChat).not.toHaveBeenCalled();
			// Free-text falls through to chatbot fallback → handleMessage
			expect(conv.handleMessage).toHaveBeenCalled();
		});
	}

	it('"/newchatroom" routes to unknown-command, not handleNewChat', async () => {
		const conv = makeConvSvc();
		await buildRouter(conv).routeMessage(msg('/newchatroom'));
		expect(conv.handleNewChat).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// I.4 — Multi-step scenarios using real ChatSessionStore
// ---------------------------------------------------------------------------

describe('I.4 — Multi-step scenarios with real ChatSessionStore', () => {
	let tempDir: string;
	const USER = 'matt';
	const SESSION_KEY = 'agent:main:telegram:dm:matt';

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-persona-newchat-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeStore() {
		const data = new DataStoreServiceImpl({
			dataDir: tempDir,
			appId: 'chatbot',
			userScopes: CONVERSATION_DATA_SCOPES,
			sharedScopes: [],
			changeLog: new ChangeLog(tempDir),
		});
		return composeChatSessionStore({ data, logger: pino({ level: 'silent' }) });
	}

	function turn(role: 'user' | 'assistant', content: string) {
		return { role, content, timestamp: new Date().toISOString() } as const;
	}

	const ctx = { userId: USER, sessionKey: SESSION_KEY };

	// I.4.1 — Long chat → /newchat → fresh start, old transcript readable
	it('I.4.1: 5 exchanges → /newchat clears index + sets ended_at; next message starts fresh session', async () => {
		const store = makeStore();

		// Write 5 user/assistant exchanges
		let firstSessionId!: string;
		for (let i = 0; i < 5; i++) {
			const { sessionId } = await store.appendExchange(
				ctx,
				turn('user', `question ${i}`),
				turn('assistant', `answer ${i}`),
			);
			if (i === 0) firstSessionId = sessionId;
		}

		// Verify active session
		expect(await store.peekActive(ctx)).toBe(firstSessionId);

		// Send /newchat — ends the session
		const { endedSessionId } = await store.endActive(ctx, 'newchat');
		expect(endedSessionId).toBe(firstSessionId);

		// Index cleared
		expect(await store.peekActive(ctx)).toBeUndefined();

		// Old transcript is readable with ended_at set
		const firstSession = await store.readSession(USER, firstSessionId);
		expect(firstSession?.meta.ended_at).not.toBeNull();
		expect(firstSession?.turns).toHaveLength(10); // 5 pairs = 10 turns

		// Next message creates a new session
		const { sessionId: secondSessionId } = await store.appendExchange(
			ctx,
			turn('user', 'fresh start'),
			turn('assistant', 'new session!'),
		);
		expect(secondSessionId).not.toBe(firstSessionId);

		// Second session started_at >= first ended_at
		const secondSession = await store.readSession(USER, secondSessionId);
		const firstEndedAt = new Date(firstSession!.meta.ended_at!).getTime();
		const secondStartedAt = new Date(secondSession!.meta.started_at).getTime();
		expect(secondStartedAt).toBeGreaterThanOrEqual(firstEndedAt);

		// Both transcript files exist (use readdir on actual disk path)
		const sessionsDir = join(tempDir, 'users', USER, 'chatbot', 'conversation', 'sessions');
		const files = await readdir(sessionsDir);
		expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(2);
	});

	// I.4.2 — /newchat race: in-flight turns land in the OLD session (locked decision)
	it('I.4.2: in-flight appendExchange with expectedSessionId lands in old session after endActive', async () => {
		const store = makeStore();

		// Create an initial session
		const { sessionId: oldId } = await store.appendExchange(
			ctx,
			turn('user', 'original question'),
			turn('assistant', 'original reply'),
		);

		// /newchat ends the session
		await store.endActive(ctx, 'newchat');
		expect(await store.peekActive(ctx)).toBeUndefined();

		// In-flight reply bound to the old session id (Router had bound it before /newchat)
		await store.appendExchange(
			{ ...ctx, expectedSessionId: oldId },
			turn('user', 'follow-up (in-flight)'),
			turn('assistant', 'follow-up reply'),
		);

		// Turn landed in the old session
		const oldSession = await store.readSession(USER, oldId);
		expect(oldSession?.turns).toHaveLength(4); // 2 original + 2 in-flight
		expect(oldSession?.turns.some((t) => t.content === 'follow-up reply')).toBe(true);

		// No new session was minted
		expect(await store.peekActive(ctx)).toBeUndefined();
	});

	// I.4.3 — Legacy migration on first new message
	it('I.4.3: pre-seeded history.json is imported once; new exchange lands in separate telegram session', async () => {
		// Pre-seed the legacy history.json
		const chatbotDir = join(tempDir, 'users', USER, 'chatbot');
		await mkdir(chatbotDir, { recursive: true });
		const legacyHistory = [
			{ role: 'user', content: 'legacy question 1', timestamp: '2026-01-01T10:00:00Z' },
			{ role: 'assistant', content: 'legacy answer 1', timestamp: '2026-01-01T10:00:01Z' },
			{ role: 'user', content: 'legacy question 2', timestamp: '2026-01-01T10:01:00Z' },
			{ role: 'assistant', content: 'legacy answer 2', timestamp: '2026-01-01T10:01:01Z' },
		];
		await writeFile(join(chatbotDir, 'history.json'), JSON.stringify(legacyHistory));

		const store = makeStore();

		// First new message triggers legacy migration
		const { sessionId: newId } = await store.appendExchange(
			ctx,
			turn('user', 'first new message'),
			turn('assistant', 'welcome back!'),
		);

		// The new session has source: telegram
		const newSession = await store.readSession(USER, newId);
		expect(newSession?.meta.source).toBe('telegram');
		expect(newSession?.turns).toHaveLength(2);

		// Legacy-import session exists with 4 turns
		const sessionsDir = join(tempDir, 'users', USER, 'chatbot', 'conversation', 'sessions');
		const files = await readdir(sessionsDir);
		const mdFiles = files.filter((f) => f.endsWith('.md'));
		expect(mdFiles).toHaveLength(2); // one legacy-import + one telegram

		// Find the legacy-import session
		let legacySession = null;
		for (const f of mdFiles) {
			const id = f.replace('.md', '');
			const s = await store.readSession(USER, id);
			if (s?.meta.source === 'legacy-import') {
				legacySession = s;
				break;
			}
		}
		expect(legacySession).not.toBeNull();
		expect(legacySession!.turns).toHaveLength(4);
		expect(legacySession!.turns[0]?.content).toBe('legacy question 1');

		// Original history.json is still on disk
		const { access } = await import('node:fs/promises');
		await expect(access(join(chatbotDir, 'history.json'))).resolves.toBeUndefined();
	});
});
