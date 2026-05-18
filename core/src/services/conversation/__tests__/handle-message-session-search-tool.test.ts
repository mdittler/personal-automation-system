/**
 * Handler integration tests for the <session-search> pseudo-tool in handleMessage.
 *
 * Tests:
 *   - Instruction block injected/omitted based on intent regex + config + hasSessionSearch
 *   - Tool loop: tag detected → searchSessions → second LLM call → final response delivered
 *   - Tool loop edge cases: empty query, no hits, searchSessions throws, second LLM throws
 *   - Recursion cap: second response with tag → tag stripped, not re-parsed
 *   - Disabled / unavailable: tag in first response stripped, no search, no second call
 *   - No raw <session-search> reaches telegram.send on any code path
 *
 * REQ-CONV-TOOL-SEARCH-001 through 012
 *
 * NOTE: runRecallPipeline is mocked at the module level to prevent it from
 * consuming llm.complete calls (it runs a fast-tier LLM classifier when
 * hasSessionSearch=true). This keeps tests focused on the pseudo-tool path.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the recall pipeline so its LLM calls don't interfere with call-count assertions.
vi.mock('../recall-pipeline.js', () => ({ runRecallPipeline: vi.fn().mockResolvedValue([]) }));
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { AppConfigService } from '../../../types/config.js';
import type { ConversationRetrievalService } from '../../conversation-retrieval/index.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import {
	SESSION_SEARCH_CONFIG_INSTRUCTION_BLOCK,
	SESSION_SEARCH_INSTRUCTION_BLOCK,
} from '../control-tags/session-search-instruction.js';
import { handleMessage } from '../handle-message.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChatSessions(sessionId = 'session-1'): ChatSessionStore {
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi.fn().mockResolvedValue({ sessionId }),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn().mockResolvedValue({ endedSessionId: null }),
		readSession: vi.fn().mockResolvedValue(undefined),
		ensureActiveSession: vi.fn().mockResolvedValue({ sessionId, isNew: true, snapshot: undefined }),
		peekSnapshot: vi.fn().mockResolvedValue(undefined),
		setTitle: vi.fn().mockResolvedValue({ updated: false }),
		rebuildMemorySnapshot: vi
			.fn()
			.mockResolvedValue({ status: 'ok', entryCount: 0, content: '', builtAt: '' }),
	};
}

function makeConfig(overrides: Record<string, unknown> = {}): AppConfigService {
	return {
		get: vi.fn(),
		// Batch 1D: resolver honors manifest default `true` when the value is
		// missing. These tests focus on the session-search pseudo-tool path
		// and don't exercise auto-detect; pin it off so an unrelated
		// classifier LLM call doesn't get inserted.
		getAll: vi.fn().mockResolvedValue({ auto_detect_pas: false }),
		getOverrides: vi.fn().mockResolvedValue(overrides),
		setAll: vi.fn(),
		updateOverrides: vi.fn().mockResolvedValue(undefined),
	} as unknown as AppConfigService;
}

function makeRetrieval(
	opts: {
		hasSearch?: boolean;
		hits?: Array<{
			sessionId: string;
			sessionStartedAt: string;
			title: string | null;
			matches: Array<{ role: string; turn_index: number; snippet: string }>;
		}>;
		throws?: Error;
	} = {},
): ConversationRetrievalService {
	const { hasSearch = true, hits = [], throws } = opts;
	const searchFn = throws ? vi.fn().mockRejectedValue(throws) : vi.fn().mockResolvedValue({ hits });

	return {
		hasSessionSearch: vi.fn().mockReturnValue(hasSearch),
		searchSessions: searchFn,
		buildContextSnapshot: vi.fn().mockResolvedValue(null),
		buildMemorySnapshot: vi.fn().mockResolvedValue({ entries: [], totalChars: 0, entryCount: 0 }),
		searchData: vi.fn(),
		listContextEntries: vi.fn().mockResolvedValue([]),
		getRecentInteractions: vi.fn().mockResolvedValue([]),
		getEnabledApps: vi.fn().mockResolvedValue([]),
		searchAppKnowledge: vi.fn().mockResolvedValue([]),
		buildSystemDataBlock: vi.fn().mockResolvedValue(''),
		listScopedReports: vi.fn().mockResolvedValue([]),
		listScopedAlerts: vi.fn().mockResolvedValue([]),
	} as unknown as ConversationRetrievalService;
}

function makeDeps(
	opts: {
		firstResponse?: string;
		secondResponse?: string;
		conversationRetrieval?: ConversationRetrievalService;
		config?: AppConfigService;
	} = {},
) {
	const services = createMockCoreServices();
	const store = createMockScopedStore();
	vi.mocked(services.data.forUser).mockReturnValue(store);

	// First LLM call returns the initial response; second call returns the continuation
	const complete = vi.mocked(services.llm.complete);
	if (opts.secondResponse !== undefined) {
		complete
			.mockResolvedValueOnce(opts.firstResponse ?? 'No tag here')
			.mockResolvedValueOnce(opts.secondResponse);
	} else {
		complete.mockResolvedValue(opts.firstResponse ?? 'Normal response');
	}

	return {
		services,
		store,
		chatSessions: makeChatSessions(),
		conversationRetrieval: opts.conversationRetrieval,
		config: opts.config,
	};
}

function makeHandleMessageDeps(
	services: ReturnType<typeof createMockCoreServices>,
	chatSessions: ChatSessionStore,
	extra: {
		conversationRetrieval?: ConversationRetrievalService;
		config?: AppConfigService;
	} = {},
) {
	return {
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: 'UTC',
		chatSessions,
		conversationRetrieval: extra.conversationRetrieval,
		config: extra.config,
	};
}

// ---------------------------------------------------------------------------
// Instruction block conditional inclusion
// ---------------------------------------------------------------------------

describe('SESSION_SEARCH_INSTRUCTION_BLOCK injection', () => {
	it('injects instruction block when intent matches AND config enabled AND hasSessionSearch=true', async () => {
		const { services, chatSessions } = makeDeps({ firstResponse: 'No tag' });
		const config = makeConfig({ session_search_tool_enabled: true });
		const retrieval = makeRetrieval({ hasSearch: true });

		// "remember" triggers SESSION_SEARCH_TOOL_INTENT_REGEX
		const ctx = createTestMessageContext({ text: 'do you remember what we said about pasta?' });

		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		const firstCallSystemPrompt =
			vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(firstCallSystemPrompt).toContain(SESSION_SEARCH_INSTRUCTION_BLOCK);
	});

	it('omits instruction block when intent regex does NOT match', async () => {
		const { services, chatSessions } = makeDeps({ firstResponse: 'No tag' });
		const config = makeConfig({ session_search_tool_enabled: true });
		const retrieval = makeRetrieval({ hasSearch: true });

		const ctx = createTestMessageContext({ text: 'what is the weather today?' });

		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		const firstCallSystemPrompt =
			vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(firstCallSystemPrompt).not.toContain(SESSION_SEARCH_INSTRUCTION_BLOCK);
	});

	it('omits instruction block when config explicitly disables session_search_tool_enabled', async () => {
		const { services, chatSessions } = makeDeps({ firstResponse: 'No tag' });
		const config = makeConfig({ session_search_tool_enabled: false });
		const retrieval = makeRetrieval({ hasSearch: true });

		const ctx = createTestMessageContext({ text: 'do you remember what we said about pasta?' });

		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		const firstCallSystemPrompt =
			vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(firstCallSystemPrompt).not.toContain(SESSION_SEARCH_INSTRUCTION_BLOCK);
	});

	it('omits instruction block when hasSessionSearch=false', async () => {
		const { services, chatSessions } = makeDeps({ firstResponse: 'No tag' });
		const config = makeConfig({ session_search_tool_enabled: true });
		const retrieval = makeRetrieval({ hasSearch: false });

		const ctx = createTestMessageContext({ text: 'do you remember our pasta discussion?' });

		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		const firstCallSystemPrompt =
			vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(firstCallSystemPrompt).not.toContain(SESSION_SEARCH_INSTRUCTION_BLOCK);
	});

	it('omits instruction block when conversationRetrieval is undefined', async () => {
		const { services, chatSessions } = makeDeps({ firstResponse: 'No tag' });
		const config = makeConfig({ session_search_tool_enabled: true });

		const ctx = createTestMessageContext({ text: 'do you recall our discussion about pasta?' });

		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, { config }),
		});

		const firstCallSystemPrompt =
			vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(firstCallSystemPrompt).not.toContain(SESSION_SEARCH_INSTRUCTION_BLOCK);
	});

	it('injects SESSION_SEARCH_CONFIG_INSTRUCTION_BLOCK when toggle intent matches', async () => {
		const { services, chatSessions } = makeDeps({ firstResponse: 'No tag' });
		const config = makeConfig({});
		const ctx = createTestMessageContext({ text: 'turn off session search' });

		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, { config }),
		});

		const firstCallSystemPrompt =
			vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(firstCallSystemPrompt).toContain(SESSION_SEARCH_CONFIG_INSTRUCTION_BLOCK);
	});
});

// ---------------------------------------------------------------------------
// Tool loop: tag emitted → search → second LLM call
// ---------------------------------------------------------------------------

describe('session-search tool loop — happy path', () => {
	it('when LLM emits tag, searchSessions is called with sanitized queryTerms', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Let me search. <session-search query="pasta carbonara"/>',
			secondResponse: 'Here is what I found about pasta carbonara.',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'what did we say about pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		expect(retrieval.searchSessions).toHaveBeenCalledOnce();
		const callArg = vi.mocked(retrieval.searchSessions).mock.calls[0]?.[0];
		expect(callArg?.queryTerms).toContain('pasta');
		expect(callArg?.queryTerms).toContain('carbonara');
	});

	it('makes exactly two LLM calls when the tool fires', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: '<session-search query="groceries"/>',
			secondResponse: 'Here is what I found.',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'what did we discuss about groceries?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		expect(services.llm.complete).toHaveBeenCalledTimes(2);
	});

	it('delivers the second response to telegram.send (not the first)', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Searching. <session-search query="pasta"/>',
			secondResponse: 'Final answer about pasta.',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'remember pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).toContain('Final answer about pasta.');
		expect(sentText).not.toContain('Searching.');
	});

	it('search excludes the active session id', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: '<session-search query="pasta"/>',
			secondResponse: 'Result.',
			conversationRetrieval: retrieval,
			config,
		});

		// makeChatSessions returns sessionId 'session-1'
		const ctx = createTestMessageContext({ text: 'remember our pasta talk?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		const callArg = vi.mocked(retrieval.searchSessions).mock.calls[0]?.[0];
		expect(callArg?.excludeSessionIds).toContain('session-1');
	});

	it('second response is appended to transcript, not the first partial', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Partial. <session-search query="pasta"/>',
			secondResponse: 'Full second response.',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'recall pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		expect(chatSessions.appendExchange).toHaveBeenCalledOnce();
		const assistantTurn = vi.mocked(chatSessions.appendExchange).mock.calls[0]?.[2];
		expect(assistantTurn?.content).toContain('Full second response.');
		expect(assistantTurn?.content).not.toContain('<session-search');
	});
});

// ---------------------------------------------------------------------------
// Tool loop edge cases
// ---------------------------------------------------------------------------

describe('session-search tool loop — edge cases', () => {
	it('query empty after sanitize → no second call, first-response prose (without tag) sent', async () => {
		const retrieval = makeRetrieval({ hasSearch: true });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			// FTS operators only → buildUntrustedQuery returns empty terms
			firstResponse: 'Prose before. <session-search query="*()"  />',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'remember?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		// Only one LLM call (tag stripped, no second call)
		expect(services.llm.complete).toHaveBeenCalledTimes(1);
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<session-search');
		expect(sentText).toContain('Prose before.');
	});

	it('no hits → continuation prompt still issued, second response delivered', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: '<session-search query="obscure"/>',
			secondResponse: 'Nothing found about obscure.',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'recall obscure?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		expect(services.llm.complete).toHaveBeenCalledTimes(2);
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).toContain('Nothing found about obscure.');
	});

	it('searchSessions throws → falls back to first-response prose (without tag), warns, one telegram.send', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, throws: new Error('DB error') });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Before. <session-search query="pasta"/>',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'recall pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		// Falls back — tool loop caught the error
		expect(services.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('session-search tool loop failed'),
			expect.any(Error),
		);
		expect(services.telegram.send).toHaveBeenCalledOnce();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).toContain('Before.');
		expect(sentText).not.toContain('<session-search');
	});

	it('second LLM call throws → falls back to first-response prose (without tag)', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		// Use makeDeps without a secondResponse so the mock defaults to returning the firstResponse.
		// Then override with Once values: first call → tagged prose, second call → throws.
		// (runRecallPipeline is mocked at module level so it doesn't consume llm.complete calls.)
		const { services, chatSessions } = makeDeps({
			conversationRetrieval: retrieval,
			config,
		});
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('Before. <session-search query="pasta"/>')
			.mockRejectedValueOnce(new Error('LLM timeout'));

		const ctx = createTestMessageContext({ text: 'recall pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		expect(services.telegram.send).toHaveBeenCalledOnce();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).toContain('Before.');
		expect(sentText).not.toContain('<session-search');
	});
});

// ---------------------------------------------------------------------------
// Recursion cap
// ---------------------------------------------------------------------------

describe('session-search recursion cap', () => {
	it('second response emitting another tag → tag stripped, not re-parsed, no third LLM call', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		// runRecallPipeline is mocked so exactly 2 llm.complete calls fire: first + re-prompt.
		const { services, chatSessions } = makeDeps({
			firstResponse: '<session-search query="pasta"/>',
			secondResponse: 'Here. <session-search query="more"/>',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'recall pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		// Exactly two LLM calls — runRecallPipeline is mocked out, no third
		expect(services.llm.complete).toHaveBeenCalledTimes(2);
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<session-search');
		expect(sentText).toContain('Here.');
	});
});

// ---------------------------------------------------------------------------
// Disabled / unavailable — invariant: <session-search never reaches telegram.send
// ---------------------------------------------------------------------------

describe('session-search disabled / unavailable', () => {
	it('session_search_tool_enabled=false: tag stripped, single LLM call, no search', async () => {
		const retrieval = makeRetrieval({ hasSearch: true });
		const config = makeConfig({ session_search_tool_enabled: false });
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Prose. <session-search query="pasta"/>',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		expect(services.llm.complete).toHaveBeenCalledTimes(1);
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<session-search');
	});

	it('conversationRetrieval=undefined: tag stripped, single LLM call', async () => {
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Prose. <session-search query="pasta"/>',
			config,
		});

		const ctx = createTestMessageContext({ text: 'pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, { config }),
		});

		expect(services.llm.complete).toHaveBeenCalledTimes(1);
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<session-search');
	});

	it('hasSessionSearch=false: tag stripped, single LLM call, no search', async () => {
		const retrieval = makeRetrieval({ hasSearch: false });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Prose. <session-search query="pasta"/>',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		expect(services.llm.complete).toHaveBeenCalledTimes(1);
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<session-search');
	});

	it('config=undefined: tag stripped, no session-search execution (search not called)', async () => {
		// Batch 1D: with config=undefined, the auto_detect_pas resolver
		// short-circuits to the manifest default `true`, so the chatbot's
		// fast-tier classifier still runs. What we're asserting here is the
		// invariant that matters for the session-search tool path: without
		// config, no search is executed and the tag is stripped from the
		// reply (handleMessage.ts gates session-search execution on
		// `deps.config !== undefined`).
		const retrieval = makeRetrieval({ hasSearch: true });
		const { services, chatSessions } = makeDeps({
			firstResponse: 'Prose. <session-search query="pasta"/>',
			conversationRetrieval: retrieval,
		});

		const ctx = createTestMessageContext({ text: 'pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, { conversationRetrieval: retrieval }),
		});

		// Search must NOT be called when config is undefined.
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<session-search');
	});
});

// ---------------------------------------------------------------------------
// P1 gate: execution requires the same intent-regex guard as instruction injection
// ---------------------------------------------------------------------------

describe('session-search P1 gate — intent regex must match for execution', () => {
	it('intent regex does NOT match but tag present → stripped, no search, single call', async () => {
		const retrieval = makeRetrieval({ hasSearch: true });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			// Crafted tag in response despite no intent-match in user message
			firstResponse: 'Here is my answer. <session-search query="pasta"/>',
			conversationRetrieval: retrieval,
			config,
		});

		// "what is the weather" does NOT match SESSION_SEARCH_TOOL_INTENT_REGEX
		const ctx = createTestMessageContext({ text: 'what is the weather today?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		// Tag stripped; search NOT executed; single LLM call
		expect(services.llm.complete).toHaveBeenCalledTimes(1);
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<session-search');
		expect(sentText).toContain('Here is my answer.');
	});
});

// ---------------------------------------------------------------------------
// P2 empty fallback: tag-only first response delivers non-empty text on failure
// ---------------------------------------------------------------------------

describe('session-search P2 empty fallback', () => {
	it('tag-only first response + searchSessions throws → non-empty fallback delivered', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, throws: new Error('DB error') });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			// The entire first response is just the tag — beforeTag will be empty
			firstResponse: '<session-search query="pasta"/>',
			conversationRetrieval: retrieval,
			config,
		});

		const ctx = createTestMessageContext({ text: 'remember pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
		});

		// Fallback message delivered — not an empty string
		expect(services.telegram.send).toHaveBeenCalledOnce();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText.trim().length).toBeGreaterThan(0);
		expect(sentText).not.toContain('<session-search');
	});
});

// ---------------------------------------------------------------------------
// Tool ordering: second response flows through existing post-processors
// ---------------------------------------------------------------------------

describe('tool ordering — second response through post-processors', () => {
	it('journal tags in second response are extracted (not first partial)', async () => {
		const retrieval = makeRetrieval({ hasSearch: true, hits: [] });
		const config = makeConfig({});
		const { services, chatSessions } = makeDeps({
			firstResponse: '<session-search query="pasta"/>',
			secondResponse: 'Answer. <model-journal>Journal entry from second response</model-journal>',
			conversationRetrieval: retrieval,
			config,
		});
		const mockJournal = { append: vi.fn().mockResolvedValue(undefined) };

		const ctx = createTestMessageContext({ text: 'recall pasta?' });
		await handleMessage(ctx, {
			...makeHandleMessageDeps(services, chatSessions, {
				conversationRetrieval: retrieval,
				config,
			}),
			modelJournal: mockJournal as any,
		});

		// Journal entry from second response should be processed
		expect(mockJournal.append).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining('Journal entry from second response'),
		);
		// The journal tag should be stripped from the delivered reply
		const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
		expect(sentText).not.toContain('<model-journal>');
	});
});
