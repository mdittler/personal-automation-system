/**
 * Router command-name contract: /ask and /edit dispatched to ConversationService.
 *
 * The chatbot shim no longer exports handleCommand — /ask and /edit are Router
 * built-ins. This test pins the convention that the Router's built-in dispatch
 * reaches ConversationService.handleAsk / handleEdit (with no leading slash) so
 * a future regression would be caught immediately.
 *
 * Previously tested via chatbot.handleCommand; now tested via Router dispatch.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestMessageContext } from '../../../../core/src/testing/test-helpers.js';

describe('Router command-name contract: built-ins reach ConversationService', () => {
	function makeConvService() {
		return {
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handleAsk: vi.fn().mockResolvedValue(undefined),
			handleEdit: vi.fn().mockResolvedValue(undefined),
			handleNotes: vi.fn().mockResolvedValue(undefined),
		};
	}

	it("Router dispatches '/ask ...' to conversationService.handleAsk with args array (no leading slash in args)", async () => {
		const conv = makeConvService();

		// Import and build the Router inline to keep this test self-contained
		const { Router } = await import('@pas/core/services/router');
		const { ManifestCache } = await import('@pas/core/services/app-registry');

		const cache = new ManifestCache();
		// Chatbot manifest with NO commands (post-Chunk-C state)
		cache.add(
			{
				app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: '', author: '' },
				capabilities: { messages: {} },
			},
			'/apps/chatbot',
		);

		const registry = {
			getApp: vi.fn().mockReturnValue(undefined),
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['chatbot'],
		};
		const telegram = { send: vi.fn().mockResolvedValue(undefined), sendPhoto: vi.fn(), sendOptions: vi.fn() };
		const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() };

		const router = new Router({
			registry: registry as any,
			llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() } as any,
			telegram: telegram as any,
			fallback: { handleUnrecognized: vi.fn() } as any,
			config: {
				port: 3000, dataDir: '/tmp', logLevel: 'info', timezone: 'UTC', fallback: 'chatbot',
				telegram: { botToken: 'x' }, ollama: { url: '', model: '' }, claude: { apiKey: '', model: '' },
				gui: { authToken: '' }, cloudflare: {},
				users: [{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
			} as any,
			logger: logger as any,
			conversationService: conv as any,
		});
		router.buildRoutingTables();

		await router.routeMessage(createTestMessageContext({ userId: 'user1', text: '/ask what is pas?' }));

		expect(conv.handleAsk).toHaveBeenCalledOnce();
		const [args] = conv.handleAsk.mock.calls[0]!;
		// args is an array of tokens — not the raw string with a slash
		expect(args).toEqual(['what', 'is', 'pas?']);
	});

	it("Router dispatches '/edit ...' to conversationService.handleEdit with args array (no leading slash in args)", async () => {
		const conv = makeConvService();

		const { Router } = await import('@pas/core/services/router');
		const { ManifestCache } = await import('@pas/core/services/app-registry');

		const cache = new ManifestCache();
		cache.add(
			{
				app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: '', author: '' },
				capabilities: { messages: {} },
			},
			'/apps/chatbot',
		);

		const registry = {
			getApp: vi.fn().mockReturnValue(undefined),
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['chatbot'],
		};
		const telegram = { send: vi.fn().mockResolvedValue(undefined), sendPhoto: vi.fn(), sendOptions: vi.fn() };
		const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() };

		const router = new Router({
			registry: registry as any,
			llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() } as any,
			telegram: telegram as any,
			fallback: { handleUnrecognized: vi.fn() } as any,
			config: {
				port: 3000, dataDir: '/tmp', logLevel: 'info', timezone: 'UTC', fallback: 'chatbot',
				telegram: { botToken: 'x' }, ollama: { url: '', model: '' }, claude: { apiKey: '', model: '' },
				gui: { authToken: '' }, cloudflare: {},
				users: [{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
			} as any,
			logger: logger as any,
			conversationService: conv as any,
		});
		router.buildRoutingTables();

		await router.routeMessage(createTestMessageContext({ userId: 'user1', text: '/edit fix something' }));

		expect(conv.handleEdit).toHaveBeenCalledOnce();
		const [args] = conv.handleEdit.mock.calls[0]!;
		expect(args).toEqual(['fix', 'something']);
	});
});
