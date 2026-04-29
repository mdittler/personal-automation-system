/**
 * Persona tests — Hermes P4 memory-snapshot freeze semantic.
 *
 * These integration-style tests exercise the full handleMessage / handleAsk
 * flow and assert Layer 2 prompt injection behavior:
 *
 *   Freeze persona: snapshot content from ensureActiveSession appears in the
 *   LLM system prompt inside a <memory-context label="durable-memory"> block,
 *   with framing tags outside the code fence.
 *
 *   Mid-session mutation persona: ContextStore mutated mid-session does NOT
 *   appear in subsequent turn prompts — the frozen snapshot from session mint
 *   is the only durable surface in the prompt. The new value is absent both
 *   inside and outside the memory-context block.
 *
 *   New-session persona: after /newchat, a new ensureActiveSession call mints
 *   a fresh snapshot; the new session's prompt contains the updated content.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { MemorySnapshot } from '../../../types/conversation-session.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { requestContext } from '../../context/request-context.js';
import { ConversationService } from '../conversation-service.js';
import type { ConversationServiceDeps } from '../conversation-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FROZEN_CONTENT = 'User prefers Celsius and metric units.';
const MUTATED_CONTENT = 'User now prefers Fahrenheit and imperial units.';

function makeOkSnapshot(content: string): MemorySnapshot {
	return { content, status: 'ok', builtAt: '2026-04-28T00:00:00Z', entryCount: 1 };
}

function makeChatSessionsWithSnapshot(snapshot: MemorySnapshot | undefined, opts: {
	sessionId?: string;
} = {}): ChatSessionStore {
	const sessionId = opts.sessionId ?? 'session-abc';
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi.fn().mockResolvedValue({ sessionId }),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn().mockResolvedValue({ endedSessionId: sessionId }),
		readSession: vi.fn().mockResolvedValue(undefined),
		ensureActiveSession: vi.fn().mockResolvedValue({ sessionId, isNew: true, snapshot }),
		peekSnapshot: vi.fn().mockResolvedValue(snapshot),
		setTitle: vi.fn().mockResolvedValue({ updated: false }),
	};
}

function makeServiceWithSessions(
	chatSessions: ChatSessionStore,
	buildMemorySnapshot?: () => Promise<MemorySnapshot>,
): { svc: ConversationService; services: ReturnType<typeof createMockCoreServices> } {
	const services = createMockCoreServices();
	const store = createMockScopedStore();
	vi.mocked(services.data.forUser).mockReturnValue(store);

	const retrieval = buildMemorySnapshot
		? {
				buildContextSnapshot: vi.fn().mockResolvedValue(null),
				buildMemorySnapshot: vi.fn().mockImplementation(buildMemorySnapshot),
				searchSessions: vi.fn(),
		  }
		: undefined;

	const deps: ConversationServiceDeps = {
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: 'UTC',
		chatSessions,
		conversationRetrieval: retrieval as never,
	};
	const svc = new ConversationService(deps);
	return { svc, services };
}

function getStandardPrompt(services: ReturnType<typeof createMockCoreServices>): string {
	const standardCall = vi.mocked(services.llm.complete).mock.calls.find(
		(c) => c[1]?.tier === 'standard',
	);
	return (standardCall?.[1]?.systemPrompt ?? '') as string;
}

// ---------------------------------------------------------------------------
// Freeze persona
// ---------------------------------------------------------------------------

describe('memory-snapshot persona — freeze semantic', () => {
	it('snapshot content appears in LLM system prompt inside <memory-context label="durable-memory">', async () => {
		const snapshot = makeOkSnapshot(FROZEN_CONTENT);
		const chatSessions = makeChatSessionsWithSnapshot(snapshot);
		const { svc, services } = makeServiceWithSessions(chatSessions);
		vi.mocked(services.llm.complete).mockResolvedValue('OK');

		const ctx = createTestMessageContext({ text: 'What should I wear today?' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx));

		const prompt = getStandardPrompt(services);
		expect(prompt).toContain('<memory-context label="durable-memory">');
		expect(prompt).toContain(FROZEN_CONTENT);
		expect(prompt).toContain('</memory-context>');
	});

	it('framing tags are outside the code fence — fence delimiter appears between tags and payload', async () => {
		const snapshot = makeOkSnapshot(FROZEN_CONTENT);
		const chatSessions = makeChatSessionsWithSnapshot(snapshot);
		const { svc, services } = makeServiceWithSessions(chatSessions);
		vi.mocked(services.llm.complete).mockResolvedValue('OK');

		const ctx = createTestMessageContext({ text: 'hello' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx));

		const prompt = getStandardPrompt(services);
		const openTag = prompt.indexOf('<memory-context label="durable-memory">');
		const fenceOpen = prompt.indexOf('```', openTag);
		const payloadIdx = prompt.indexOf(FROZEN_CONTENT);
		const fenceClose = prompt.indexOf('```', fenceOpen + 3);
		const closeTag = prompt.indexOf('</memory-context>', fenceClose);

		// Structure: <tag> … ``` … payload … ``` … </tag>
		expect(openTag).toBeGreaterThan(-1);
		expect(fenceOpen).toBeGreaterThan(openTag);
		expect(payloadIdx).toBeGreaterThan(fenceOpen);
		expect(fenceClose).toBeGreaterThan(payloadIdx);
		expect(closeTag).toBeGreaterThan(fenceClose);
	});

	it('no <memory-context> block when snapshot is absent (conversationRetrieval not wired)', async () => {
		const chatSessions = makeChatSessionsWithSnapshot(undefined);
		const { svc, services } = makeServiceWithSessions(chatSessions);
		vi.mocked(services.llm.complete).mockResolvedValue('OK');

		const ctx = createTestMessageContext({ text: 'hello' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx));

		const prompt = getStandardPrompt(services);
		expect(prompt).not.toContain('<memory-context label="durable-memory">');
	});

	it('no <memory-context> block when snapshot has degraded status', async () => {
		const snapshot: MemorySnapshot = { content: '', status: 'degraded', builtAt: '', entryCount: 0 };
		const chatSessions = makeChatSessionsWithSnapshot(snapshot);
		const { svc, services } = makeServiceWithSessions(chatSessions);
		vi.mocked(services.llm.complete).mockResolvedValue('OK');

		const ctx = createTestMessageContext({ text: 'hello' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx));

		const prompt = getStandardPrompt(services);
		expect(prompt).not.toContain('<memory-context label="durable-memory">');
	});
});

// ---------------------------------------------------------------------------
// Mid-session mutation persona
// ---------------------------------------------------------------------------

describe('memory-snapshot persona — mid-session mutation isolation', () => {
	it('mutated ContextStore value is absent from prompt; frozen value IS present', async () => {
		// Session minted with FROZEN_CONTENT snapshot
		const frozenSnapshot = makeOkSnapshot(FROZEN_CONTENT);
		const chatSessions = makeChatSessionsWithSnapshot(frozenSnapshot);
		const { svc, services } = makeServiceWithSessions(chatSessions);

		// Simulate "ContextStore mutated mid-session" — set up the live store to return
		// new content. Since gatherContext returns [] (P4 — no per-turn ContextStore
		// injection), this should NOT appear in the prompt.
		vi.mocked(services.contextStore.listForUser).mockResolvedValue([
			{ key: 'preference', value: MUTATED_CONTENT, updatedAt: new Date().toISOString() },
		]);

		// Second turn: ensureActiveSession returns the SAME frozen snapshot (isNew: false)
		vi.mocked(services.llm.complete).mockResolvedValue('Wear a jacket.');
		const ctx = createTestMessageContext({ text: 'What should I wear today?' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx));

		const prompt = getStandardPrompt(services);

		// Frozen content IS in the memory-context block
		expect(prompt).toContain(FROZEN_CONTENT);
		// Mutated (live) value is ABSENT — not injected per-turn
		expect(prompt).not.toContain(MUTATED_CONTENT);
	});

	it('two consecutive turns with identical snapshot produce byte-identical Layer 2 prefix', async () => {
		const frozenSnapshot = makeOkSnapshot(FROZEN_CONTENT);
		const chatSessions = makeChatSessionsWithSnapshot(frozenSnapshot);
		const { svc, services } = makeServiceWithSessions(chatSessions);

		vi.mocked(services.llm.complete).mockResolvedValue('OK');

		const ctx1 = createTestMessageContext({ text: 'Turn 1' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx1));

		const prompt1 = (vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '') as string;

		vi.mocked(services.llm.complete).mockClear();

		const ctx2 = createTestMessageContext({ text: 'Turn 2' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx2));

		const prompt2 = (vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '') as string;

		const extractBlock = (p: string) => {
			const start = p.indexOf('<memory-context label="durable-memory">');
			const end = p.indexOf('</memory-context>', start);
			return start === -1 ? '' : p.slice(start, end + '</memory-context>'.length);
		};

		expect(extractBlock(prompt1)).toEqual(extractBlock(prompt2));
		expect(extractBlock(prompt1)).not.toBe('');
	});
});

// ---------------------------------------------------------------------------
// New-session persona — /newchat mints fresh snapshot
// ---------------------------------------------------------------------------

describe('memory-snapshot persona — new session after /newchat', () => {
	it('new session after /newchat contains updated snapshot content', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);

		// First session: old preference
		const sessionOneSnapshot = makeOkSnapshot('User prefers metric units.');
		// Second session (after /newchat): updated preference
		const sessionTwoSnapshot = makeOkSnapshot('User prefers imperial units.');

		const chatSessions: ChatSessionStore = {
			peekActive: vi.fn().mockResolvedValue(undefined),
			appendExchange: vi.fn().mockResolvedValue({ sessionId: 'session-2' }),
			loadRecentTurns: vi.fn().mockResolvedValue([]),
			endActive: vi.fn().mockResolvedValue({ endedSessionId: 'session-1' }),
			readSession: vi.fn().mockResolvedValue(undefined),
			ensureActiveSession: vi
				.fn()
				.mockResolvedValueOnce({ sessionId: 'session-1', isNew: true, snapshot: sessionOneSnapshot })
				.mockResolvedValueOnce({ sessionId: 'session-2', isNew: true, snapshot: sessionTwoSnapshot }),
			peekSnapshot: vi.fn().mockResolvedValue(undefined),
			setTitle: vi.fn().mockResolvedValue({ updated: false }),
		};

		const deps: ConversationServiceDeps = {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		};
		const svc = new ConversationService(deps);

		// Turn 1: first session
		vi.mocked(services.llm.complete).mockResolvedValue('OK');
		const ctx1 = createTestMessageContext({ text: 'hello' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx1));

		const prompt1 = getStandardPrompt(services);
		expect(prompt1).toContain('User prefers metric units.');
		expect(prompt1).not.toContain('User prefers imperial units.');

		vi.mocked(services.llm.complete).mockClear();

		// Simulate /newchat → ensureActiveSession now returns session 2 with new snapshot
		vi.mocked(services.llm.complete).mockResolvedValue('OK');
		const ctx2 = createTestMessageContext({ text: 'What now?' });
		await requestContext.run({ userId: 'test-user' }, () => svc.handleMessage(ctx2));

		const prompt2 = getStandardPrompt(services);
		expect(prompt2).toContain('User prefers imperial units.');
		expect(prompt2).not.toContain('User prefers metric units.');
	});
});
